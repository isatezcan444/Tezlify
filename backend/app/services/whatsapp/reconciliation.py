"""LID/telefon kimliği bölünmüş sohbetlerin BİRLEŞTİRİLMESİ (servis katmanından bağımsız).

Neden ayrı bir modül
--------------------
Bir kişi LID adresiyle yazdığında ve gateway henüz LID→telefon köprüsünü
öğrenmemişken backend, `phone_e164 = 'jid:<lid>'` olan bir "hayalet" kişi ve ona
bağlı ayrı bir sohbet oluşturur. Köprü sonradan öğrenilse bile **geçmişte**
kalıcılaşmış bölünmeler için canlı yol (`lid_mapped`) bir daha çalışmaz — o olay
yalnızca bir kez gelir.

Birleştirme ÜÇ yerden çağrılır ve üçünün de AYNI mantığı çalıştırması gerekir:

1. **canlı yol**: `lid_mapped` olayı (gateway köprüyü ilk kez öğrendiğinde),
2. **boot**: `purge_raw_jid_identity_data` köprüsü BİLİNEN hayaletleri silmez,
   erteler; bu modüldeki `merge_deferred_lid_ghosts` onları gerçekten birleştirir,
3. **onarım işi**: `scripts/diagnostics/whatsapp_lid_split_repair.py`.

Mantık orchestrator metodunda kalsaydı boot onu çağıramazdı: `core/migrations.py`
servis katmanını import edemez (döngüsel import). Gövde bu yüzden BURAYA taşındı;
orchestrator metodu ince bir delegasyondur ve kendi mock'lanabilir yardımcılarını
(`_upsert_contact`, `_ensure_conversation`, kilit) enjekte eder.

Davranış sözleşmesi (taşındığı haliyle korunur)
----------------------------------------------
- Veri SİLİNMEZ: mesajlar `conversation_id` güncellenerek TAŞINIR.
- Aynı `wa_message_id` iki sohbette varsa kopya taşınmaz; durum rütbesi yüksek
  olan kazanır (canonical okuma yolu arşivlenen satırı görmez, kayıp değildir).
- Okunmamış sayıları toplanır; daha yeni önizleme/zaman korunur.
- Eski (LID) sohbet ARŞİVLENİR — silinmez.
- Köprüsü BİLİNMEYEN hayalet ne birleştirilir ne silinir (kimlik tahmin edilmez).
"""

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import select, text, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message
from backend.app.services.whatsapp.identity import (
    contact_phone_for_jid,
    strip_jid_prefix,
)
from backend.app.services.whatsapp.repositories.conversations import (
    get_conversation_lock,
    get_conversation_scope_filters,
)

logger = logging.getLogger(__name__)

# Onarım işinin ve boot adımının varsayılan sınırı: bir çalıştırma sınırsız
# sayıda satıra dokunamaz.
DEFAULT_REPAIR_LIMIT = 50
BOOT_MERGE_LIMIT = 200

# Aynı `wa_message_id` iki sohbette varsa hangi satır kazanır. DELIVERED/READ
# bir ACK'tır; LID kopyasında kalmışsa taşınan satıra işlenir, kaybedilmez.
_STATUS_RANKS = {
    "PENDING": 0,
    "FAILED": 0,
    "SENT": 1,
    "DELIVERED": 2,
    "READ": 3,
    "RECEIVED": 4,
}


def _dialect_is_postgres(bind: Any) -> bool:
    try:
        return bind.dialect.name == "postgresql"
    except Exception:  # noqa: BLE001 - ölçemezsek SQLite varsayımı güvenli
        return False


def _lid_table(postgres: bool) -> str:
    # Gateway bu tabloyu Postgres'te özel şemada, SQLite'ta düz adla açar.
    return "whatsapp_private.lid_mappings" if postgres else "lid_mappings"


def _sessions_table(postgres: bool) -> str:
    return "public.whatsapp_sessions" if postgres else "whatsapp_sessions"


def _public_table(postgres: bool, name: str) -> str:
    # contacts/conversations her zaman public şemadadır; SQLite testte düz ad.
    return f"public.{name}" if postgres else name


# ---------------------------------------------------------------------------
# Çapraz SÜREÇ kilidi: birleştirme aynı anda iki süreçte koşamaz
# ---------------------------------------------------------------------------
#
# `get_conversation_lock` yalnızca TEK süreç içinde geçerlidir. Ama aynı LID
# çiftini iki ayrı süreç birleştirebilir: canlı yol API sürecinde, boot adımı ve
# onarım işi ise ayrı süreçlerde koşar. Ölçülen sonuç: iki birleştirme aynı
# mesaj kümesini okur, ikisi de "taşıdım" der, okunmamış sayı İKİ KEZ toplanır ve
# arada gelen bir mesaj arşivlenen sohbette SAHİPSİZ kalır.
#
# Kilit bir DB satırıdır (lease): süreç ölürse `expires_at` geçer ve satır
# devralınabilir — yani kilit asla kalıcı olarak takılı kalmaz. Süreç-içi
# asyncio kilidi de korunur (aynı süreçteki eşzamanlı olaylar için).
_MERGE_LOCK_TABLE = "wa_merge_locks"
_MERGE_LOCK_TTL_SECONDS = 120
_MERGE_LOCK_POLL_SECONDS = 0.25
# DDL'i her birleştirmede tekrarlamamak için süreç başına bir kez kurulur.
_MERGE_LOCK_TABLE_READY: set[str] = set()

# ---------------------------------------------------------------------------
# Gözlemlenebilirlik: süpürme turu süreleri + kilit bekleme dağılımı
# ---------------------------------------------------------------------------
# Amaç "iş çalışıyor mu" sorusunu kabuk komudu olmadan ölçmek. Bu yüzden
# süreç belleğinde tutulur ve `/metrics` (ve `/health` özeti) üzerinden okunur.
# Örnekler son N taneyle sınırlanır: sınırsız bir liste süreç ömrü boyunca
# büyür ve sızıntıya döner. Toplamlar ayrıca tutulur; ortalama tüm koşuların
# (yalnızca son örneklerin değil) ortalamasıdır.
_METRIC_SAMPLE_LIMIT = 50

_LOCK_METRICS: Dict[str, Any] = {
    "attempts": 0,
    "acquired": 0,
    "contended": 0,
    # Lease tablosu kurulamadıysa deneme yapılmadı bile: ayrı sayılır, ki
    # "kilit var" ile "kilit kurulamadı" raporu karışmasın.
    "unavailable": 0,
    "wait_samples_ms": [],
    "wait_total_ms": 0.0,
    "wait_max_ms": 0.0,
}


def _record_lock_attempt(*, wait_ms: float, acquired: bool) -> None:
    """Bir lease denemesinin beklemesini kaydeder (örnekler son N ile sınırlı)."""
    _LOCK_METRICS["attempts"] = int(_LOCK_METRICS["attempts"]) + 1
    if acquired:
        _LOCK_METRICS["acquired"] = int(_LOCK_METRICS["acquired"]) + 1
    else:
        _LOCK_METRICS["contended"] = int(_LOCK_METRICS["contended"]) + 1
    waited = round(float(wait_ms), 3)
    samples = _LOCK_METRICS["wait_samples_ms"]
    samples.append(waited)
    del samples[: max(0, len(samples) - _METRIC_SAMPLE_LIMIT)]
    _LOCK_METRICS["wait_total_ms"] = round(
        float(_LOCK_METRICS["wait_total_ms"]) + waited, 3
    )
    _LOCK_METRICS["wait_max_ms"] = max(float(_LOCK_METRICS["wait_max_ms"]), waited)


def _sample_stats(
    samples: List[float],
    *,
    total_ms: Optional[float] = None,
    count: Optional[int] = None,
) -> Dict[str, Any]:
    """Örneklerden avg/max/p50/p95 üretir. `count` verilirse o (tüm koşular),
    yoksa elde tutulan örnek sayısıdır — ortalama total/count'tan gelir."""
    n = int(count) if count is not None else len(samples)
    ordered = sorted(float(s) for s in samples)
    # `count` (tüm koşular) ile elde tutulan örnek penceresi AYRIŞABİLİR: tur
    # sayacı örnek listesinden daha uzun yaşayabilir (örnek kaydı bir hatadan
    # etkilenirse ya da liste bilinçli olarak boşaltılırsa). Bu yüzden dağılım
    # alanları YALNIZCA gerçekten örnek varsa üretilir; sıfır bölme/boş liste
    # indeksi yok. (Bu tuzak bir falsifikasyon probuyla yakalandı: `max`
    # `ordered[-1]`e koşulsuz erişip IndexError atıyordu.)
    avg: Optional[float]
    if total_ms is not None:
        avg = round(float(total_ms) / n, 3) if n else None
    elif ordered:
        avg = round(sum(ordered) / len(ordered), 3)
    else:
        avg = None
    if not ordered:
        return {
            "count": n,
            "last": None,
            "avg": avg,
            "max": None,
            "p50": None,
            "p95": None,
        }

    def _pct(p: float) -> Optional[float]:
        idx = int(round((p / 100.0) * (len(ordered) - 1)))
        idx = min(len(ordered) - 1, max(0, idx))
        return round(ordered[idx], 3)

    return {
        "count": n,
        "last": round(float(samples[-1]), 3) if samples else None,
        "avg": avg,
        "max": round(ordered[-1], 3),
        "p50": _pct(50),
        "p95": _pct(95),
    }


def _lock_table_cache_key(db: AsyncSession, postgres: bool) -> str:
    """Lease tablosu hazır-işareti için ANAHTAR: sürücü DEĞİL, VERİTABANI.

    Önbellek yalnızca lehçeye göre anahtarlanıyordu (`"sqlite"` /
    `"postgresql"`). Tek bir süreçte BİRDEN FAZLA sqlite veritabanı koşar
    (test paketi her test için ayrı bir dosya açıyor): tabloyu ilk kuran
    veritabanı, DİĞERLERİNİ de "hazır" işaretliyor ve
    `CREATE TABLE IF NOT EXISTS` tam da gereken yerde atlanıyordu.

    Sonuç yalnızca `no such table: wa_merge_locks` değildi: kilit ALINMAMIŞ
    sayılıyor, yani bu tablonun önlemek için var olduğu çapraz süreç
    birleştirme yarışı sessizce geri geliyordu. Üretimde tek bir veritabanı
    olduğu için orada görünmüyordu; test paketinde ise sıraya bağlı, tekrarlayan
    kırmızı üretiyordu.

    Kimlik okunamazsa eski (kaba) davranışa düşülür: en kötü ihtimalle tablo
    yeniden kurulur, ki bu idempotenttir.
    """
    dialect = "postgresql" if postgres else "sqlite"
    try:
        bind = db.get_bind()
    except Exception:  # noqa: BLE001 - kimlik okunamazsa kaba anahtar
        return dialect
    url = getattr(bind, "url", None) or getattr(getattr(bind, "engine", None), "url", None)
    return f"{dialect}:{url}" if url else dialect


async def _ensure_merge_lock_table(db: AsyncSession, postgres: bool) -> bool:
    """Lease tablosunu idempotent kurar. Kurulamazsa kilit YOK sayılmaz."""
    key = _lock_table_cache_key(db, postgres)
    if key in _MERGE_LOCK_TABLE_READY:
        return True
    ddl = (
        f"CREATE TABLE IF NOT EXISTS {_MERGE_LOCK_TABLE} ("
        "lock_key VARCHAR(200) PRIMARY KEY, "
        "holder VARCHAR(64) NOT NULL, "
        "expires_at TIMESTAMP NOT NULL)"
    )
    try:
        await db.execute(text(ddl))
        await db.commit()
    except Exception as exc:  # noqa: BLE001 - yarış halinde "zaten var" beklenir
        await db.rollback()
        logger.debug("merge kilidi tablosu kurulamadi (yok sayilir): %s", exc)
        return False
    _MERGE_LOCK_TABLE_READY.add(key)
    return True


def _merge_lock_key(user_id: str, lid_phone: str) -> str:
    """Lease anahtarı: aynı çiftin farklı yazımları AYNI anahtarı üretmeli.

    `user_id` sütunu Uuid olduğu için kayıtlı biçim dash'siz olabilir; canlı yolda
    gelen biçim ise tireli. Anahtar bu farktan etkilenirse iki süreç aynı çifti
    FARKLI kilitlerle birleştirir — yani kilit sessizce hiçbir şeyi korumaz.
    (Bu tam olarak bir testte yakalandı: süpürme, tutulan kilide rağmen birleştirdi.)
    """
    return f"{str(user_id).replace('-', '').lower()}:{str(lid_phone).lower()}"


@asynccontextmanager
async def _merge_lease(
    db: AsyncSession,
    *,
    lock_key: str,
    wait_seconds: float,
    postgres: Optional[bool] = None,
):
    """`lock_key` için süreçler arası lease; `(acquired, holder)` döner.

    Alınamazsa **birleştirme yapılmaz** ve süreç bunu dürüstçe bildirir: bu bir
    kayıp değildir, çünkü LID sohbeti arşivlenmediği sürece aday olarak kalır ve
    bir sonraki boot/periyodik süpürme onu birleştirir. Kilit altında yapılan
    işin yarım kalmasındansa işi ertelemek doğrudur.
    """
    if postgres is None:
        postgres = _dialect_is_postgres(getattr(db, "bind", None))
    holder = uuid.uuid4().hex
    started = time.monotonic()
    if not await _ensure_merge_lock_table(db, postgres):
        # Kilit kurulamıyorsa kilitsiz devam ETMEYİZ: sessizce yarışa girmek,
        # korunma iddiasını yalan yapar. Tek süreçli boot için bu bir engel
        # değildir; çok süreçli durumda iş bir sonraki tura kalır.
        _LOCK_METRICS["unavailable"] = int(_LOCK_METRICS["unavailable"]) + 1
        yield False, None
        return

    deadline = utc_now_naive() + timedelta(seconds=max(0.0, wait_seconds))
    acquired = False
    while True:
        now = utc_now_naive()
        try:
            inserted = await db.execute(
                text(
                    f"INSERT INTO {_MERGE_LOCK_TABLE} (lock_key, holder, expires_at) "
                    "VALUES (:k, :h, :exp) ON CONFLICT (lock_key) DO NOTHING"
                ),
                {"k": lock_key, "h": holder, "exp": now + timedelta(seconds=_MERGE_LOCK_TTL_SECONDS)},
            )
            await db.commit()
            if (inserted.rowcount or 0) > 0:
                acquired = True
                break
            # Süresi geçmiş lease devralınır. Koşul eski `expires_at`e bağlıdır:
            # iki devralıcı yarışırsa yalnızca BİRİ satırı günceller.
            stolen = await db.execute(
                text(
                    f"UPDATE {_MERGE_LOCK_TABLE} SET holder = :h, expires_at = :exp "
                    "WHERE lock_key = :k AND expires_at < :now"
                ),
                {"k": lock_key, "h": holder, "exp": now + timedelta(seconds=_MERGE_LOCK_TTL_SECONDS), "now": now},
            )
            await db.commit()
            if (stolen.rowcount or 0) > 0:
                acquired = True
                break
        except Exception as exc:  # noqa: BLE001 - kilit alınamadıysa birleştirme ertelenir
            await db.rollback()
            logger.warning("merge kilidi alinamadi (%s): %s", lock_key, exc)
            break
        if utc_now_naive() >= deadline:
            break
        await asyncio.sleep(_MERGE_LOCK_POLL_SECONDS)

    # Bekleme, ALINDIĞI ANDA ölçülür: `yield` bloğu birleştirme gövdesini de
    # kapsar, gövde süresi kilit beklemesi sanılmamalı.
    _record_lock_attempt(
        wait_ms=(time.monotonic() - started) * 1000.0, acquired=acquired
    )

    try:
        yield acquired, (holder if acquired else None)
    finally:
        if acquired:
            try:
                await db.execute(
                    text(
                        f"DELETE FROM {_MERGE_LOCK_TABLE} WHERE lock_key = :k AND holder = :h"
                    ),
                    {"k": lock_key, "h": holder},
                )
                await db.commit()
            except Exception as exc:  # noqa: BLE001 - lease TTL ile kendiliğinden düşer
                await db.rollback()
                logger.warning("merge kilidi birakilamadi (%s): %s", lock_key, exc)


async def candidate_lid_split_pairs(
    db: AsyncSession,
    *,
    user_id: Optional[str] = None,
    limit: int = DEFAULT_REPAIR_LIMIT,
    postgres: Optional[bool] = None,
    archived: bool = False,
) -> List[Dict[str, Any]]:
    """Köprüsü BİLİNEN ve hâlâ hayalet LID kişisine bağlı AKTİF sohbeti olan çiftler.

    Yalnızca her iki ucu da kanıtlanmış çiftler döner: eşleme tablosunda kaydı
    olmayan bir LID aday DEĞİLDİR (kimliği tahmin etmek yerine atlarız).

    Arşivlenmiş LID sohbeti (`archived=False` iken) aday DEĞİLDİR: birleştirme
    onu arşivler, ikinci bir koşu aynı satırı yeniden "birleştirilmiş" diye
    raporlamamalıdır. Idempotans bu filtreden gelir; onsuz her boot aynı 200
    çifti işler ve "kalan" sayısı hiç azalmazdı.

    `archived=True` ise tam tersi sorulur: ARŞİVLENMİŞ ama hâlâ mesaj taşıyan
    sohbetler (birleştirme sırasında gelen mesajın sahipsiz kaldığı durum).

    Sınır GERÇEK adaylara uygulanır (2026-10-02 düzeltmesi): hayalet kişi ve
    sohbet koşulları SQL JOIN'indedir. Önceki sürüm ham eşleme satırlarını
    `ORDER BY lid_jid LIMIT` ile tarayıp Python'da eliyordu; ÜRETİMDE ÖLÇÜLDÜ —
    18 138 eşleme varken `limit=50` yalnızca en küçük `lid_jid` penceresini
    kapsıyor, sıralamada sonra gelen gerçek bir bölünme hiç görünmüyordu
    (`/lid-splits` boş döndü, süpürme o çifti hiç aday saymadı). JOIN'li sürümde
    `LIMIT` gerçek aday sayısını sınırlar ve `remaining_at_least` gerçekten
    kalan işi söyler.
    """
    if postgres is None:
        postgres = _dialect_is_postgres(getattr(db, "bind", None))
    # `user_id` sütunu Uuid olduğu için kayıtlı biçim dash'siz olabilir; operatör
    # ise tireli UUID yazar. İki biçimi de kabul et — yoksa `--user-id` sessizce
    # "hiç aday yok" derdi.
    where_user = " AND (ws.user_id = :user_id OR ws.user_id = :user_id_hex)" if user_id else ""
    params: Dict[str, Any] = {"lim": limit, "archived": archived}
    if user_id:
        params["user_id"] = str(user_id)
        params["user_id_hex"] = str(user_id).replace("-", "")
    # `MIN(...)`: aynı çift için birden çok kişi/sohbet satırı varsa (veri
    # anomalisi) Python sürümünün `.first()` seçicisiyle aynı biçimde en küçük
    # id seçilir — çift başına tek satır döner.
    rows = (
        await db.execute(
            text(
                f"""
                SELECT lm.lid_jid,
                       lm.phone_jid,
                       ws.user_id,
                       MIN(c.id) AS lid_contact_id,
                       MIN(cv.id) AS lid_conversation_id
                FROM {_lid_table(postgres)} lm
                JOIN {_sessions_table(postgres)} ws ON ws.gateway_id = lm.session_id
                JOIN {_public_table(postgres, "contacts")} c
                  ON c.user_id = ws.user_id
                 AND c.phone_e164 = 'jid:' || lm.lid_jid
                JOIN {_public_table(postgres, "conversations")} cv
                  ON cv.contact_id = c.id
                 AND cv.user_id = ws.user_id
                 AND cv.is_archived = :archived
                WHERE lm.phone_jid IS NOT NULL AND lm.phone_jid <> ''
                  AND lm.lid_jid LIKE '%@lid'
                  {where_user}
                GROUP BY lm.lid_jid, lm.phone_jid, ws.user_id
                ORDER BY lm.lid_jid
                LIMIT :lim
                """
            ),
            params,
        )
    ).all()

    pairs: List[Dict[str, Any]] = []
    for lid_jid, phone_jid, owner, lid_contact_id, lid_conversation_id in rows:
        pairs.append(
            {
                "user_id": str(owner),
                "lid_jid": str(lid_jid),
                "phone_jid": str(phone_jid),
                "lid_contact_id": lid_contact_id,
                "lid_conversation_id": lid_conversation_id,
            }
        )
    return pairs


async def _default_upsert_contact(
    db: AsyncSession,
    user_id: str,
    jid: str,
    display_name: Optional[str] = None,
    name_source: Optional[str] = None,
    **_ignored: Any,
) -> Contact:
    """Kanonik (telefon JID'li) kişiyi bulur, yoksa hayaletin adıyla oluşturur.

    Canlı yol orchestrator'ın kendi (daha zengin) `_upsert_contact`'ını enjekte
    eder; boot ve onarım işi burada tanımlı, servis katmanına bağlı olmayan
    sürümü kullanır.
    """
    canonical_phone = contact_phone_for_jid(jid) or _strip_jid_prefix(jid)
    stmt = select(Contact).where(
        Contact.phone_e164 == canonical_phone,
        get_user_filter(Contact.user_id, user_id),
    )
    contact = (await db.execute(stmt)).scalars().first()
    if contact is not None:
        return contact
    contact = Contact(
        user_id=user_id,
        phone_e164=canonical_phone,
        display_name=display_name,
    )
    try:
        async with db.begin_nested():
            db.add(contact)
            await db.flush()
    except IntegrityError:
        # Eşzamanlı bir yazar aynı kişiyi yarattıysa kaydı ikiye bölmeyiz.
        contact = (await db.execute(stmt)).scalars().first()
        if contact is None:
            raise
    return contact


async def _default_ensure_conversation(
    db: AsyncSession,
    user_id: str,
    jid: str,
    session_id: Optional[int] = None,
    **_ignored: Any,
) -> Conversation:
    contact = await _default_upsert_contact(db, user_id, jid)
    filters = get_conversation_scope_filters(user_id, contact.id, session_id)
    conv = (
        await db.execute(
            select(Conversation).where(*filters).order_by(Conversation.id.asc())
        )
    ).scalars().first()
    if conv is None:
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            session_id=session_id,
            is_group=False,
            is_archived=False,
            last_message_at=None,
        )
        db.add(conv)
        await db.flush()
    conv._contact = contact
    return conv


async def merge_split_conversation(
    db: AsyncSession,
    user_id: str,
    lid_jid: str,
    phone_jid: str,
    session_id: Optional[int] = None,
    *,
    upsert_contact: Optional[Callable[..., Any]] = None,
    ensure_conversation: Optional[Callable[..., Any]] = None,
    lock_factory: Optional[Callable[[str, int], Any]] = None,
    lock_wait_seconds: float = 20.0,
    result_info: Optional[Dict[str, Any]] = None,
) -> Optional[Conversation]:
    """LID sohbetini telefon (kanonik) sohbetine TAŞIR ve eskisini arşivler.

    `None` dönerse birleştirilecek bir şey yoktur (LID kişisi yok) YA DA
    birleştirme BAŞKA BİR SÜREÇ tarafından yürütülmektedir; ikincisinde
    `result_info["skipped_reason"] == "merge_lease_held"` olur ve LID sohbeti
    arşivlenmediği için aday olarak kalır — yani iş kaybolmaz, ertelenir.

    `upsert_contact`/`ensure_conversation`/`lock_factory` verilmezse bu modüldeki
    servis-bağımsız varsayılanlar ve paylaşılan sohbet kilidi (depo katmanı)
    kullanılır. Kilidin KENDİSİ her zaman süreçler arasıdır (DB lease).
    """
    _upsert_contact = upsert_contact or _default_upsert_contact
    _ensure_conversation = ensure_conversation or _default_ensure_conversation
    _lock_factory = lock_factory or get_conversation_lock
    postgres = _dialect_is_postgres(getattr(db, "bind", None))

    lid_phone = f"jid:{lid_jid}" if not str(lid_jid).startswith("jid:") else str(lid_jid)
    canonical_phone = contact_phone_for_jid(phone_jid)

    async with _merge_lease(
        db,
        lock_key=_merge_lock_key(user_id, lid_phone),
        wait_seconds=lock_wait_seconds,
        postgres=postgres,
    ) as (lease_ok, _holder):
        if not lease_ok:
            if result_info is not None:
                result_info["skipped_reason"] = "merge_lease_held"
            logger.info(
                "[lid_merge] Birleştirme başka bir süreç tarafından yürütülüyor; "
                "ertelendi (lid=%s, owner=%s) — sohbet aday olarak kalıyor.",
                lid_phone,
                user_id,
            )
            return None
        return await _merge_under_lease(
            db,
            user_id=user_id,
            lid_jid=lid_jid,
            phone_jid=phone_jid,
            session_id=session_id,
            lid_phone=lid_phone,
            canonical_phone=canonical_phone,
            upsert_contact=_upsert_contact,
            ensure_conversation=_ensure_conversation,
            lock_factory=_lock_factory,
            result_info=result_info,
        )


async def _merge_under_lease(
    db: AsyncSession,
    *,
    user_id: str,
    lid_jid: str,
    phone_jid: str,
    session_id: Optional[int],
    lid_phone: str,
    canonical_phone: Optional[str],
    upsert_contact: Callable[..., Any],
    ensure_conversation: Callable[..., Any],
    lock_factory: Callable[[str, int], Any],
    result_info: Optional[Dict[str, Any]] = None,
) -> Optional[Conversation]:
    """Lease ALINDIKTAN sonraki birleştirme gövdesi (okumalar kilit içinde)."""
    cres = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_([lid_phone, canonical_phone]),
            get_user_filter(Contact.user_id, user_id),
        )
    )
    contacts = {c.phone_e164: c for c in cres.scalars().all()}
    lid_contact = contacts.get(lid_phone)
    canonical_contact = contacts.get(canonical_phone)

    if not lid_contact:
        return None
    if not canonical_contact:
        canonical_contact = await upsert_contact(
            db, user_id, phone_jid, lid_contact.display_name, None
        )

    # Avatar LID kişisinde varsa ve kanonikte yoksa taşınır: kimlik birleşirken
    # görsel kimlik de kaybolmamalı.
    lid_attrs = lid_contact.custom_attributes or {}
    canon_attrs = canonical_contact.custom_attributes or {}
    if lid_attrs.get("avatar_url") and not canon_attrs.get("avatar_url"):
        canon_attrs["avatar_url"] = lid_attrs["avatar_url"]
        canonical_contact.custom_attributes = dict(canon_attrs)
        await db.flush()

    conv_res = await db.execute(
        select(Conversation).where(
            Conversation.contact_id.in_([lid_contact.id, canonical_contact.id]),
            get_user_filter(Conversation.user_id, user_id),
            *(
                [Conversation.session_id == session_id]
                if session_id is not None
                else []
            ),
        )
    )
    convs = {c.contact_id: c for c in conv_res.scalars().all()}
    legacy_conv = convs.get(lid_contact.id)
    canonical_conv = convs.get(canonical_contact.id)

    if not legacy_conv:
        return canonical_conv
    if not canonical_conv:
        legacy_msg_count = await db.scalar(
            select(func.count(Message.id)).where(Message.conversation_id == legacy_conv.id)
        )
        if (legacy_msg_count or 0) == 0 and legacy_conv.last_message_at is None:
            legacy_conv.status = ConversationStatus.ARCHIVED
            legacy_conv.is_archived = True
            await db.commit()
            return None
        canonical_conv = await ensure_conversation(
            db, user_id, phone_jid, session_id=legacy_conv.session_id
        )

    if legacy_conv.id == canonical_conv.id:
        return canonical_conv

    async def _do_reconciliation():
        moved_unique = 0
        # Tekilleşen kopyalar ID bazlı sayılır: doğrulama turu aynı satırı
        # yeniden okur, sayaç "kaç kez görüldü"yu değil "kaç kopya tekilleşti"yi
        # söylemeli (aksi halde tur sayısı raporu şişirir).
        deduped_ids: set[str] = set()
        stranded = 0
        passes = 0

        async def _read_both():
            mres = await db.execute(
                select(Message).where(
                    Message.conversation_id.in_([legacy_conv.id, canonical_conv.id])
                )
            )
            rows = list(mres.scalars().all())
            canon_ids = {
                m.wa_message_id: m
                for m in rows
                if m.conversation_id == canonical_conv.id and m.wa_message_id
            }
            return rows, canon_ids

        # Sınırlı doğrulama turu. Tek tur "taşıdım" demek yetmez: birleştirme
        # sürerken gelen bir mesaj (canlı ingest) eski sohbete yazılmış olabilir;
        # onu arşivlenen sohbette bırakmak SAHİPSİZ mesaj demektir. Taşıma
        # yapılmayı kalmayana kadar (en fazla 3 tur) tekrarlanır ve sonuç
        # ölçülerek raporlanır.
        for _attempt in range(3):
            passes += 1
            all_msgs, canonical_wa_ids = await _read_both()
            moved_this_pass = 0
            for msg in all_msgs:
                if msg.conversation_id != legacy_conv.id:
                    continue
                if msg.wa_message_id and msg.wa_message_id in canonical_wa_ids:
                    deduped_ids.add(str(msg.wa_message_id))
                    canon_msg = canonical_wa_ids[msg.wa_message_id]
                    if _STATUS_RANKS.get(msg.status.value, 0) > _STATUS_RANKS.get(
                        canon_msg.status.value, 0
                    ):
                        canon_msg.status = msg.status
                        canon_msg.delivered_at = canon_msg.delivered_at or msg.delivered_at
                        canon_msg.read_at = canon_msg.read_at or msg.read_at
                else:
                    msg.conversation_id = canonical_conv.id
                    moved_unique += 1
                    moved_this_pass += 1
            if moved_this_pass == 0:
                break
            await db.flush()

        # Arşivlemeden ÖNCE sahipsiz kalan var mı? Varsa birleştirme
        # tamamlanmış SAYILMAZ ve rapor bunu saklamaz.
        stranded_rows = (
            await db.execute(
                select(Message.wa_message_id).where(Message.conversation_id == legacy_conv.id)
            )
        ).scalars().all()
        _canon_wa_ids = {
            m.wa_message_id
            for m in (
                await db.execute(
                    select(Message).where(Message.conversation_id == canonical_conv.id)
                )
            ).scalars().all()
            if m.wa_message_id
        }
        stranded = len(
            [w for w in stranded_rows if not w or w not in _canon_wa_ids]
        )
        if result_info is not None:
            result_info.update(
                {
                    "moved_unique": moved_unique,
                    "deduped_duplicates": len(deduped_ids),
                    "stranded_unique": stranded,
                    "merge_passes": passes,
                }
            )
        if stranded:
            # Sessiz kalmak gerçek bir veri sahipsizliğini gizler; bu satırlar
            # arşivlenen sohbette durur ve periyodik süpürme onları taşır.
            logger.error(
                "[lid_merge] Birleştirme sonrası %d BENZERSİZ mesaj hâlâ LID "
                "sohbetinde (conv=%s → %s).",
                stranded,
                legacy_conv.id,
                canonical_conv.id,
            )

        canonical_conv.unread_count = (canonical_conv.unread_count or 0) + (
            legacy_conv.unread_count or 0
        )

        if legacy_conv.last_message_at and (
            canonical_conv.last_message_at is None
            or legacy_conv.last_message_at > canonical_conv.last_message_at
        ):
            canonical_conv.last_message_at = legacy_conv.last_message_at
            if legacy_conv.last_message_preview:
                canonical_conv.last_message_preview = legacy_conv.last_message_preview

        legacy_conv.status = ConversationStatus.ARCHIVED
        legacy_conv.is_archived = True
        legacy_conv.unread_count = 0
        legacy_conv.archived_at = utc_now_naive()

        await db.commit()
        await db.refresh(canonical_conv)
        return canonical_conv

    # Süreçler arası lease zaten alındı; bu kilit aynı süreçteki eşzamanlı
    # olayları serileştirir (kilit sırası id'ye göre: kilitlenme olmaz).
    first_id, second_id = sorted([legacy_conv.id, canonical_conv.id])
    async with lock_factory(user_id, first_id), lock_factory(user_id, second_id):
        return await _do_reconciliation()


async def merge_deferred_lid_ghosts(
    engine: AsyncEngine,
    *,
    limit: int = BOOT_MERGE_LIMIT,
    user_id: Optional[str] = None,
    session_factory: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """Startup adımı: purge'ün ERTELEDİĞİ köprüsü bilinen hayaletleri birleştirir.

    Erteleme birleştirme değildir: `purge_raw_jid_identity_data` köprüsü bilinen
    hayaleti silmez ama boot onu canonical sohbete de taşımazdı; sonuç, kullanıcı
    için "mesajlarım isimsiz bir sohbette duruyor" olurdu. Bu adım o boşluğu
    kapatır ve onarım işiyle AYNI `merge_split_conversation`'ı çağırır.

    Sözleşme
    --------
    - Sınırlıdır (`limit`); iş sınırsız olamaz. İşlenmeyen kaldıysa rapor
      `remaining_at_least` ile dürüstçe söyler.
    - Idempotenttir: birleştirilen LID sohbeti arşivlendiği için aday listesinden
      çıkar; ikinci boot yapılacak iş bulamaz.
    - Boot'u ASLA düşürmez (fail-open): şema/erişim hatası loglanır, rapor
      `error` alanıyla döner. Kimlik birleştirmesi şema bütünlüğüne dokunmaz.

    Dönen rapor: `scanned`, `merged`, `skipped`, `errors`, `remaining_at_least`,
    `merged_pairs` (kanıt), `error` (varsa).
    """
    factory = session_factory or AsyncSessionLocal
    report: Dict[str, Any] = {
        "scanned": 0,
        "merged": 0,
        "skipped": 0,
        # Başka bir süreç aynı çifti birleştiriyorsa iş ERTELENİR (kaybolmaz):
        # LID sohbeti arşivlenmedi, yani aday olarak duruyor.
        "deferred": 0,
        "errors": 0,
        "remaining_at_least": 0,
        "limit": limit,
        "merged_pairs": [],
        "skipped_pairs": [],
        "deferred_pairs": [],
    }
    if limit <= 0:
        report["error"] = "limit pozitif olmali"
        return report

    try:
        async with factory() as db:
            pairs = await candidate_lid_split_pairs(
                db,
                user_id=user_id,
                limit=limit + 1,
                postgres=_dialect_is_postgres(engine),
            )
            if len(pairs) > limit:
                report["remaining_at_least"] = len(pairs) - limit
            for pair in pairs[:limit]:
                pair_info: Dict[str, Any] = {}
                try:
                    merged = await merge_split_conversation(
                        db,
                        pair["user_id"],
                        pair["lid_jid"],
                        pair["phone_jid"],
                        session_id=None,
                        # Boot uzun bekleyemez: kilitliyse bir sonraki süpürme
                        # devralır, burada startup geciktirilmez.
                        lock_wait_seconds=5.0,
                        result_info=pair_info,
                    )
                except Exception as pair_exc:  # noqa: BLE001 - tek çift boot'u düşürmez
                    await db.rollback()
                    report["errors"] += 1
                    report["skipped_pairs"].append({**pair, "reason": str(pair_exc)})
                    logger.warning(
                        "[MIGRATION] lid hayalet birleştirme hatası (lid=%s): %s",
                        pair["lid_jid"],
                        pair_exc,
                    )
                    continue
                report["scanned"] += 1
                if merged is None:
                    if pair_info.get("skipped_reason") == "merge_lease_held":
                        report["deferred"] += 1
                        report["deferred_pairs"].append(
                            {**pair, "reason": "merge_lease_held"}
                        )
                        continue
                    report["skipped"] += 1
                    report["skipped_pairs"].append(
                        {**pair, "reason": "reconcile_returned_none"}
                    )
                    continue
                report["merged"] += 1
                report["merged_pairs"].append(
                    {
                        "user_id": pair["user_id"],
                        "lid_jid": pair["lid_jid"],
                        "phone_jid": pair["phone_jid"],
                        "legacy_conversation_id": pair["lid_conversation_id"],
                        "canonical_conversation_id": merged.id,
                        "canonical_unread_count": merged.unread_count,
                        "moved_unique": pair_info.get("moved_unique"),
                        "deduped_duplicates": pair_info.get("deduped_duplicates"),
                        "stranded_unique": pair_info.get("stranded_unique"),
                    }
                )
                logger.info(
                    "[MIGRATION] LID hayaleti birleştirildi: %s → %s (kullanıcı=%s, "
                    "sohbet %s → %s)",
                    pair["lid_jid"],
                    pair["phone_jid"],
                    pair["user_id"],
                    pair["lid_conversation_id"],
                    merged.id,
                )
    except Exception as exc:  # noqa: BLE001 - startup'ı düşürmez
        report["error"] = str(exc)
        logger.warning(
            "[MIGRATION] lid hayalet birleştirme atlandı: %s", exc, exc_info=True
        )
        return report

    if (
        report["merged"]
        or report["skipped"]
        or report["deferred"]
        or report["remaining_at_least"]
    ):
        logger.info(
            "[MIGRATION] LID hayalet birleştirme: %d birleştirildi, %d atlandı, "
            "%d ertelendi (başka süreçte), %d hata, en az %d çift bekliyor (limit=%d).",
            report["merged"],
            report["skipped"],
            report["deferred"],
            report["errors"],
            report["remaining_at_least"],
            limit,
        )
    else:
        logger.debug("[MIGRATION] LID hayalet birleştirme: bekleyen çift yok.")
    return report


async def _canonical_conversation_id(
    db: AsyncSession, user_id: str, phone_jid: str
) -> Optional[int]:
    canonical_phone = contact_phone_for_jid(phone_jid)
    if not canonical_phone:
        return None
    return await db.scalar(
        select(Conversation.id)
        .join(Contact, Contact.id == Conversation.contact_id)
        .where(
            Contact.phone_e164 == canonical_phone,
            get_user_filter(Conversation.user_id, user_id),
            Conversation.is_archived.is_(False),
        )
        .order_by(Conversation.id.asc())
    )


async def candidate_stranded_lid_conversations(
    db: AsyncSession,
    *,
    user_id: Optional[str] = None,
    limit: int = DEFAULT_REPAIR_LIMIT,
    postgres: Optional[bool] = None,
) -> List[Dict[str, Any]]:
    """ARŞİVLENMİŞ LID sohbetinde SAHİPSİZ kalmış BENZERSİZ mesajı olan çiftler.

    Birleştirme tek turda bitse bile şu yarış kalır: canlı ingest, eski sohbeti
    arşivlenmeden ÖNCE çözer ve mesajı ona yazar. Satır kaybolmaz ama canonical
    okuma yolu arşivlenen sohbeti görmediği için kullanıcı için yok olur.

    Bu fonksiyon tam olarak o satırları bulur. Öldü kopyaları (wa_message_id'si
    canonical tarafta ZATEN olanlar) aday SAYILMAZ: aksi halde her süpürme aynı
    satırlarla uğraşır ve "bekleyen iş" hiç bitmezdi.
    """
    pairs = await candidate_lid_split_pairs(
        db, user_id=user_id, limit=limit, postgres=postgres, archived=True
    )
    out: List[Dict[str, Any]] = []
    for pair in pairs:
        legacy_ids = set(
            (
                await db.execute(
                    select(Message.wa_message_id).where(
                        Message.conversation_id == pair["lid_conversation_id"]
                    )
                )
            ).scalars().all()
        )
        canonical_id = await _canonical_conversation_id(
            db, pair["user_id"], pair["phone_jid"]
        )
        canonical_ids = (
            set(
                (
                    await db.execute(
                        select(Message.wa_message_id).where(
                            Message.conversation_id == canonical_id
                        )
                    )
                ).scalars().all()
            )
            if canonical_id is not None
            else set()
        )
        stranded = [w for w in legacy_ids if not w or w not in canonical_ids]
        if stranded:
            out.append({**pair, "stranded_unique": len(stranded)})
    return out


async def collect_stranded_lid_messages(
    engine: AsyncEngine,
    *,
    limit: int = DEFAULT_REPAIR_LIMIT,
    user_id: Optional[str] = None,
    session_factory: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """Arşivlenmiş LID sohbetlerinde kalmış sahipsiz mesajları taşır.

    Birleştirmenin KENDİSİNİ kullanır (ikinci bir taşıma kodu yok): arşivlenmiş
    sohbeti de bulur, benzersiz satırları canonical sohbete taşır, kopyaları
    tekilleştirir. Zaten birleşmiş ve sahipsiz satırı olmayan çift aday
    olmadığı için koşu boşa dönmez.
    """
    factory = session_factory or AsyncSessionLocal
    report: Dict[str, Any] = {
        "scanned": 0,
        "merged": 0,
        "moved_unique_total": 0,
        "still_stranded": 0,
        "deferred": 0,
        "errors": 0,
        "pairs": [],
        "error": None,
    }
    if limit <= 0:
        report["error"] = "limit pozitif olmali"
        return report
    try:
        async with factory() as db:
            pairs = await candidate_stranded_lid_conversations(
                db,
                user_id=user_id,
                limit=limit,
                postgres=_dialect_is_postgres(engine),
            )
            report["scanned"] = len(pairs)
            for pair in pairs:
                info: Dict[str, Any] = {}
                try:
                    merged = await merge_split_conversation(
                        db,
                        pair["user_id"],
                        pair["lid_jid"],
                        pair["phone_jid"],
                        session_id=None,
                        lock_wait_seconds=5.0,
                        result_info=info,
                    )
                except Exception as exc:  # noqa: BLE001 - tek çift süpürmeyi düşürmez
                    await db.rollback()
                    report["errors"] += 1
                    report["pairs"].append({**pair, "error": str(exc)})
                    continue
                if merged is None:
                    from_lock = info.get("skipped_reason") == "merge_lease_held"
                    if from_lock:
                        report["deferred"] += 1
                    else:
                        report["errors"] += 1
                    report["pairs"].append({**pair, "deferred": from_lock})
                    continue
                report["merged"] += 1
                moved = int(info.get("moved_unique") or 0)
                report["moved_unique_total"] += moved
                leftover = int(info.get("stranded_unique") or 0)
                if leftover:
                    report["still_stranded"] += leftover
                    logger.error(
                        "[sweep] Taşıma sonrası hala %d sahipsiz mesaj (lid=%s)",
                        leftover,
                        pair["lid_jid"],
                    )
                report["pairs"].append(
                    {**pair, "moved_unique": moved, "stranded_after": leftover}
                )
    except Exception as exc:  # noqa: BLE001 - süpürme döngüsü düşmez
        report["error"] = str(exc)
        logger.warning("[sweep] sahipsiz mesaj toplama atlandi: %s", exc, exc_info=True)
        return report

    if report["merged"] or report["deferred"] or report["errors"]:
        logger.info(
            "[sweep] sahipsiz LID mesajları: %d birleştirme, %d taşınan benzersiz "
            "mesaj, %d ertelendi, %d hata.",
            report["merged"],
            report["moved_unique_total"],
            report["deferred"],
            report["errors"],
        )
    return report


# ---------------------------------------------------------------------------
# Periyodik süpürme: operatör `docker exec` etmek zorunda kalmasın
# ---------------------------------------------------------------------------
#
# Boot tek başına yeterli değildir: (a) boot sınırı yüzünden artan çiftler,
# (b) canlı yolun kilit yüzünden ertelediği birleştirmeler ve (c) birleştirme
# sırasında gelen ve arşivlenen sohbette kalan SAHİPSİZ mesajlar yalnızca
# yeniden koşan bir süpürmeyle onarılır. Durum süreç belleğinde tutulur ve
# `/health` üzerinden okunur — böylece "bekleyen iş var mı" sorusu için kabuk
# komutu gerekmez.
_SWEEP_STATE: Dict[str, Any] = {
    "runs": 0,
    "merged_total": 0,
    "deferred_total": 0,
    "stranded_moved_total": 0,
    "still_stranded": 0,
    "errors_total": 0,
    "last_started_at": None,
    "last_finished_at": None,
    "last_report": None,
    "last_error": None,
    # Gözlemlenebilirlik: her turun toplam süresi ve iki fazın ayrı süreleri.
    "duration_samples_ms": [],
    "split_duration_samples_ms": [],
    "stranded_duration_samples_ms": [],
    "duration_total_ms": 0.0,
}


async def run_identity_sweep_once(
    engine: AsyncEngine,
    *,
    limit: int = BOOT_MERGE_LIMIT,
    session_factory: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """Bir süpürme turu: (1) bölünmüşleri birleştir, (2) sahipsizleri topla.

    İki faz ayrı raporlanır. Sıra önemlidir: birleştirme LID sohbetini
    arşivler, ikinci faz da tam o arşivde kalmış (yarışta yazılmış) satırları
    toplar — birinci fazın ürettiği artığı aynı turda temizler.
    """
    _SWEEP_STATE["last_started_at"] = utc_now_naive().isoformat()
    run_started = time.monotonic()
    split_started = time.monotonic()
    report = await merge_deferred_lid_ghosts(
        engine, limit=limit, session_factory=session_factory
    )
    split_ms = (time.monotonic() - split_started) * 1000.0
    stranded_started = time.monotonic()
    stranded = await collect_stranded_lid_messages(
        engine, limit=limit, session_factory=session_factory
    )
    stranded_ms = (time.monotonic() - stranded_started) * 1000.0
    duration_ms = (time.monotonic() - run_started) * 1000.0
    _SWEEP_STATE["duration_total_ms"] = round(
        float(_SWEEP_STATE["duration_total_ms"]) + duration_ms, 3
    )
    for key, value in (
        ("duration_samples_ms", duration_ms),
        ("split_duration_samples_ms", split_ms),
        ("stranded_duration_samples_ms", stranded_ms),
    ):
        samples = _SWEEP_STATE[key]
        samples.append(round(value, 3))
        del samples[: max(0, len(samples) - _METRIC_SAMPLE_LIMIT)]
    _SWEEP_STATE["runs"] = int(_SWEEP_STATE["runs"]) + 1
    _SWEEP_STATE["merged_total"] = int(_SWEEP_STATE["merged_total"]) + int(report.get("merged") or 0)
    _SWEEP_STATE["deferred_total"] = int(_SWEEP_STATE["deferred_total"]) + int(report.get("deferred") or 0)
    _SWEEP_STATE["stranded_moved_total"] = int(
        _SWEEP_STATE.get("stranded_moved_total") or 0
    ) + int(stranded.get("moved_unique_total") or 0)
    _SWEEP_STATE["still_stranded"] = int(stranded.get("still_stranded") or 0)
    last_error = report.get("error") or stranded.get("error")
    if last_error:
        _SWEEP_STATE["errors_total"] = int(_SWEEP_STATE["errors_total"]) + 1
        _SWEEP_STATE["last_error"] = last_error
    _SWEEP_STATE["last_finished_at"] = utc_now_naive().isoformat()
    _SWEEP_STATE["last_report"] = {"splits": report, "stranded": stranded}
    return _SWEEP_STATE["last_report"]


async def identity_sweep_loop(
    engine: AsyncEngine,
    *,
    interval_seconds: float,
    initial_delay_seconds: float = 0.0,
    limit: int = BOOT_MERGE_LIMIT,
    session_factory: Optional[Callable[[], Any]] = None,
) -> None:
    """Süresiz döngü: periyodik süpürme. İptal edilene kadar yaşar.

    Tek bir tur patlarsa döngü ölmez: hata duruma yazılır ve bir sonraki tur
    beklenir. Aksi halde bir kez bozulan bir DB bağlantısı, onarımı süreç
    ömrü boyunca durdururdu.
    """
    if initial_delay_seconds > 0:
        await asyncio.sleep(initial_delay_seconds)
    while True:
        try:
            await run_identity_sweep_once(
                engine, limit=limit, session_factory=session_factory
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - döngü ölmez, durum yazılır
            _SWEEP_STATE["last_error"] = str(exc)
            logger.warning("[sweep] lid kimlik süpürmesi düştü: %s", exc, exc_info=True)
        await asyncio.sleep(max(1.0, float(interval_seconds)))


def merge_sweep_status() -> Dict[str, Any]:
    """`/health` için okunabilir durum (kopya; çağıran durumu değiştiremez)."""
    state = dict(_SWEEP_STATE)
    report = state.get("last_report") or {}
    splits = report.get("splits") or {}
    stranded = report.get("stranded") or {}
    state["pending_at_least"] = splits.get("remaining_at_least")
    state["last_deferred"] = (splits.get("deferred") or 0) + (stranded.get("deferred") or 0)
    state["last_stranded_moved"] = stranded.get("moved_unique_total")
    runs = int(state.get("runs") or 0)
    samples = state.get("duration_samples_ms") or []
    # Özet alanlar: son tur süresi, tüm koşuların ortalaması ve kilit özeti.
    state["last_duration_ms"] = samples[-1] if samples else None
    state["avg_duration_ms"] = (
        round(float(state.get("duration_total_ms") or 0.0) / runs, 3) if runs else None
    )
    state["lock_wait_avg_ms"] = (
        round(float(_LOCK_METRICS["wait_total_ms"]) / int(_LOCK_METRICS["attempts"]), 3)
        if int(_LOCK_METRICS["attempts"])
        else None
    )
    state["lock_contended_total"] = int(_LOCK_METRICS["contended"])
    # Tam rapor ve örnek listeleri `/health` gövdesini şişirmesin: özet yeter.
    state.pop("last_report", None)
    for key in (
        "duration_samples_ms",
        "split_duration_samples_ms",
        "stranded_duration_samples_ms",
    ):
        state.pop(key, None)
    return state


def identity_sweep_metrics() -> Dict[str, Any]:
    """`/metrics` için tam gözlemlenebilirlik: tur süreleri + kilit dağılımı.

    Dürüstlük sınırı: bu değerler SÜREÇ belleğidir. Süreç yeniden başlarsa
    sayaçlar sıfırlanır — bu yüzden `generated_at` ile birlikte okunmalı ve
    "tüm zamanların metriği" sanılmamalıdır.
    """
    runs = int(_SWEEP_STATE.get("runs") or 0)
    lock_attempts = int(_LOCK_METRICS["attempts"])
    return {
        "generated_at": utc_now_naive().isoformat(),
        "process_local": True,
        "runs": runs,
        "merged_total": int(_SWEEP_STATE.get("merged_total") or 0),
        "deferred_total": int(_SWEEP_STATE.get("deferred_total") or 0),
        "stranded_moved_total": int(_SWEEP_STATE.get("stranded_moved_total") or 0),
        "still_stranded": int(_SWEEP_STATE.get("still_stranded") or 0),
        "errors_total": int(_SWEEP_STATE.get("errors_total") or 0),
        "last_started_at": _SWEEP_STATE.get("last_started_at"),
        "last_finished_at": _SWEEP_STATE.get("last_finished_at"),
        "last_error": _SWEEP_STATE.get("last_error"),
        "duration_ms": _sample_stats(
            _SWEEP_STATE.get("duration_samples_ms") or [],
            total_ms=float(_SWEEP_STATE.get("duration_total_ms") or 0.0),
            count=runs,
        ),
        "splits_duration_ms": _sample_stats(
            _SWEEP_STATE.get("split_duration_samples_ms") or []
        ),
        "stranded_duration_ms": _sample_stats(
            _SWEEP_STATE.get("stranded_duration_samples_ms") or []
        ),
        "merge_lock": {
            "attempts": lock_attempts,
            "acquired": int(_LOCK_METRICS["acquired"]),
            "contended": int(_LOCK_METRICS["contended"]),
            "unavailable": int(_LOCK_METRICS["unavailable"]),
            "wait_ms": _sample_stats(
                _LOCK_METRICS.get("wait_samples_ms") or [],
                total_ms=float(_LOCK_METRICS.get("wait_total_ms") or 0.0),
                count=lock_attempts,
            ),
        },
    }


def reset_sweep_state() -> None:
    """Test izolasyonu: süreç-global süpürme + kilit metriklerini sıfırlar."""
    _SWEEP_STATE.update(
        {
            "runs": 0,
            "merged_total": 0,
            "deferred_total": 0,
            "stranded_moved_total": 0,
            "still_stranded": 0,
            "errors_total": 0,
            "last_started_at": None,
            "last_finished_at": None,
            "last_report": None,
            "last_error": None,
            "duration_samples_ms": [],
            "split_duration_samples_ms": [],
            "stranded_duration_samples_ms": [],
            "duration_total_ms": 0.0,
        }
    )
    _LOCK_METRICS.update(
        {
            "attempts": 0,
            "acquired": 0,
            "contended": 0,
            "unavailable": 0,
            "wait_samples_ms": [],
            "wait_total_ms": 0.0,
            "wait_max_ms": 0.0,
        }
    )
