"""Mesaj INSERT izolasyonu — zehirli satır, SAVEPOINT ve kısıt adı.

NEDEN VAR (Aşama 4.10 §5 / L-C1): 4.7'nin çekirdek güvenlik iddiası, tek bir
zehirli satırın 500 satırlık bir sayfayı öldürmemesi. `_insert_messages_resilient`
bunu `begin_nested()` + satır satır izolasyonla yapıyor ve `dead_letter`
raporunda kısıt ADINI yayınlıyor. Ölçüldü: bu yolun **hiçbir** testi yoktu —
`_insert_messages_one_by_one` hiçbir test tarafından sürülmüyordu. Mutlu yol
(`on_conflict_do_nothing`) test ediliyordu, çünkü çakışma orada hata ATMIYOR;
hata atan yol (arbiter OLMAYAN tekillik: `uq_msg_conv_client_message_id`)
tamamen karanlıktı.

Bu dosya o boşluğu kapatır. Üç iddia kilitlenir:

  1. Arbiter olmayan bir tekillik ihlali sayfayı KAYBETMEZ: diğer satırlar yazılır,
     yalnızca çakışan satır `dead_letter` sayacına düşer.
  2. İzolasyondan sonra dış transaction KULLANILABİLİR kalır (SAVEPOINT geri
     alındı, oturum zehirlenmedi).
  3. `_integrity_constraint_name` asyncpg'nin `orig.__cause__.diag` tuzağını
     atlar; ad yoksa SQLSTATE döner, None dönerse operatör `/health`te
     `dead_letter_last_constraint=None` görür.

Dialect notu: SQLite hata mesajında indeks ADI taşımaz, yalnızca kolonları
söyler (`UNIQUE constraint failed: messages.conversation_id, ...`); PostgreSQL
gerçek indeks adını verir. 1. test bunu dialect'e göre pinler.

PG notu (Aşama 4.11'de ölçüldü): bu dosyanın ilk sürümü `created_at`'i
tz-aware üretiyordu. SQLite kabul etti, PostgreSQL 17 reddetti
(`can't subtract offset-naive and offset-aware datetimes`) — 5 testin 2'si
PG'de kırmızıydı. Ürün değil FIXTURE hatasıydı; naive'e çevrildi. Ders:
SQLite'ta yeşil olmak, transaction/SAVEPOINT davranışının doğrulandığı
anlamına gelmez.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services.whatsapp.orchestration.sync import (
    _integrity_constraint_name,
    _insert_messages_resilient,
)

# Bu dosyaya özel kiracı — diğer test dosyalarıyla çakışmasın.
U4 = "99999999-9999-9999-9999-999999999999"
U4_HEX = U4.replace("-", "")


@pytest_asyncio.fixture(autouse=True)
async def _clean_state():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U4_HEX}
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def make_conversation() -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(
            user_id=U4,
            phone_e164=f"+9055{uuid_digits()}",
            display_name="INSERT izolasyon",
        )
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=U4,
            contact_id=contact.id,
            channel="WHATSAPP",
            session_id=None,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        return int(conv.id)


def uuid_digits() -> str:
    """Deterministik olmayan ama çakışmayan 8 hane."""
    return str(abs(hash(_uuid.uuid4().hex)) % 10**8).zfill(8)


def row(
    conv_id: int,
    *,
    wa_id: str,
    client_id: str,
    minute: int = 0,
    body: str = "govde",
) -> Dict[str, Any]:
    """`_normalize_message_insert_values` sözlüğü de kabul eder.

    Eksik NOT NULL kolonlar (status, message_type, is_*) kolon tanımından
    türetilir — bu yüzden burada yalnızca anlamlı alanlar veriliyor.
    """
    # NAIVE olmali: kolon `TIMESTAMP WITHOUT TIME ZONE`, asyncpg tz-aware degeri
    # reddeder ("can't subtract offset-naive and offset-aware datetimes"). Urun
    # de naive uretir (`utc_now_naive`). tz-aware fixture SQLite'ta sessizce
    # gecer, PostgreSQL'de patlar — bu yuzden asagidaki test PG'de kirmiziydi.
    at = datetime(2026, 8, 1, 10, 0) + timedelta(minutes=minute)
    return {
        "conversation_id": conv_id,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "body": body,
        "recipient_phone": "+905551112233",
        "wa_message_id": wa_id,
        "client_message_id": client_id,
        "created_at": at,
    }


async def count_messages(conv_id: int) -> int:
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Message).where(Message.conversation_id == conv_id))
        return len(res.scalars().all())


# ---------------------------------------------------------------------------
# §1 — Arbiter olmayan tekillik: sayfa kaybolmaz, yalnızca satır izole edilir
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_client_message_id_collision_is_isolated_per_row():
    """`uq_msg_conv_client_message_id` çakışması TÜM sayfayı öldürmemeli.

    Bulk INSERT'in arbiter'ı `(conversation_id, wa_message_id)`. Aynı
    `client_message_id`'yi taşıyan iki satır bu arbiter'a takılmaz; ayrı bir
    kısmi indekse takılır ve `IntegrityError` fırlatır. Eski davranış: 500
    satırın tamamı geri alınır. Beklenen: 3 satır yazılır, 1 satır dead-letter.
    """
    conv_id = await make_conversation()
    rows: List[Dict[str, Any]] = [
        row(conv_id, wa_id="W-OK-1", client_id="C-SHARED", minute=0),
        row(conv_id, wa_id="W-POISON", client_id="C-SHARED", minute=1),
        row(conv_id, wa_id="W-OK-2", client_id="C-SOLO", minute=2),
    ]
    dead: Dict[str, Any] = {"count": 0}

    async with AsyncSessionLocal() as db:
        inserted = await _insert_messages_resilient(db, rows, dead_letter=dead)
        await db.commit()

    assert len(inserted) == 2, f"sayfa kaybi: {len(inserted)} satir yazildi"
    assert dead["count"] == 1
    assert await count_messages(conv_id) == 2

    # Kisit ADI dialect'e baglidir: SQLite hata metninde yalnizca KOLONLARI
    # soyler, PostgreSQL gercek indeks adini verir. Ikisini de pinlemek,
    # "ad var mi" iddiasinin sessizce None'a dusmesini engeller.
    async with AsyncSessionLocal() as db:
        dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        assert dead.get("constraint") == "uq_msg_conv_client_message_id"
    else:
        assert dead.get("constraint") is None


@pytest.mark.asyncio
async def test_poison_row_leaves_the_outer_transaction_usable():
    """İzolasyondan sonra oturum zehirlenmemeli.

    `begin_nested()` geri alınırsa dış transaction AYAKTA kalır. Kalmazsa
    sonraki her sorgu `InFailedSQLTransactionError` ile ölür — 3.8.7'de tam bu
    sınıf hata 34 sahte hataya yol açmıştı.
    """
    conv_id = await make_conversation()
    poison = [
        row(conv_id, wa_id="W-A", client_id="C-DUP", minute=0),
        row(conv_id, wa_id="W-B", client_id="C-DUP", minute=1),
    ]

    async with AsyncSessionLocal() as db:
        await _insert_messages_resilient(db, poison, dead_letter={"count": 0})
        # Aynı oturumda yeni bir yazma: dış transaction kullanılabilir olmalı.
        clean = await _insert_messages_resilient(
            db, [row(conv_id, wa_id="W-C", client_id="C-FRESH", minute=2)]
        )
        await db.commit()
        assert len(clean) == 1

    assert await count_messages(conv_id) == 2


# ---------------------------------------------------------------------------
# §2 — Kısıt adı çıkarımı (asyncpg `diag` tuzağı)
# ---------------------------------------------------------------------------
class _Diag:
    def __init__(self, name: str) -> None:
        self.constraint_name = name


class _PgError:
    """`asyncpg` istisnasının gerçek şekli: ad `diag.constraint_name`'de."""

    def __init__(self, name: str) -> None:
        self.diag = _Diag(name)
        self.pgcode = "23505"


class _AsyncpgAdapter:
    """SQLAlchemy'nin asyncpg sarmalayıcısı: `diag` BOŞ, gerçek hata `__cause__`'da."""

    def __init__(self, cause: Any = None) -> None:
        self.diag = None
        self.pgcode = "23505"
        if cause is not None:
            self.__cause__ = cause


def test_constraint_name_reads_asyncpg_diag_from_the_cause():
    """`orig.diag` boşsa `orig.__cause__.diag` okunmalı — yoksa ad yerine SQLSTATE."""
    orig = _AsyncpgAdapter(_PgError("uq_msg_conv_client_message_id"))
    exc = IntegrityError("INSERT INTO messages ...", {}, orig)

    assert _integrity_constraint_name(exc) == "uq_msg_conv_client_message_id"


def test_constraint_name_prefers_a_direct_diag():
    """`orig.diag` doluysa doğrudan oradan okunur (psycopg2 şekli)."""
    exc = IntegrityError("INSERT INTO messages ...", {}, _PgError("uq_msg_conv_wa_message_id"))

    assert _integrity_constraint_name(exc) == "uq_msg_conv_wa_message_id"


def test_constraint_name_falls_back_to_sqlstate_without_lying():
    """Ad hiçbir yerde yoksa SQLSTATE döner — None değil.

    `None` dönerse `/health` alanı `dead_letter_last_constraint=None` olur ve
    operatör hangi indeksin çakıştığını asla öğrenemez. Kod da bir cevaptır.
    """
    class _Bare:
        diag = None
        pgcode = "23505"

    exc = IntegrityError("INSERT INTO messages ...", {}, _Bare())

    assert _integrity_constraint_name(exc) == "23505"
