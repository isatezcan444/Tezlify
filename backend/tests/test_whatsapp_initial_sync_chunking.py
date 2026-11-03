"""AŞAMA 4.28 — Initial sync front-trim güvenliği (F2).

NEDEN BU DOSYA VAR
------------------
Initial sync `offset` + `perChatLimit=50` ile sayfalanıyordu. Gateway
`perChatLimit` kırpmasını **her istekte** yeniden uygular (`slice(-N)`), sonra
id'ye göre sıralayıp `[offset, offset+limit)` dilimini döner. Sayfalar arasında
bir sohbete yeni mesaj gelirse o sohbetin penceresi ilerler, global dizi SOLA
kayar ve `offset` bir kaydı **hiçbir sayfada döndürmeden** atlar.

Çözüm: istekleri `page_size // per_chat_limit` büyüklüğünde jid parçalarına
bölmek. Her parçada `total <= page_size` olduğu için istek **tek sayfada**
biter; offset kayması fiziksel olarak imkânsız hâle gelir. İstek SAYISI
değişmez: `ceil(chats/chunk) == ceil(chats*per_chat/page_size)`.

Bu dosya iki şeyi sabitler:
  1. `_bulk_chunks` parça matematiği (saf fonksiyon).
  2. Gerçek `_run_bulk_message_sync`'in **hiçbir zaman** sayfalar arası offset
     kullanmadığı ve front-trim sırasında pencere kaydı atlamadığı.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.message import Message
from backend.app.services.whatsapp.orchestration import sync as sync_mod
from backend.app.services.whatsapp.orchestration.sync import (
    SyncJob,
    WhatsAppSyncOrchestrator,
)

# Bu dosyaya özel kiracı.
U6 = "66666666-6666-6666-6666-666666666666"
U6_HEX = U6.replace("-", "")

PAGE_SIZE = 1000          # _SYNC_BULK_PAGE_SIZE
PER_CHAT = 50             # _SYNC_PER_CHAT_LIMIT
CHUNK = PAGE_SIZE // PER_CHAT   # 20
CHATS = 25                # 20 + 5 → 2 parça
PER_CHAT_TOTAL = 60       # yazılan; okuma anında son 50'ye kırpılır
LATE_ID = 9_999_999_000_000


def generic_jid() -> str:
    return f"9057{_uuid.uuid4().int % 10**10:010d}@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _clean_tenant():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U6_HEX}
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


# ---------------------------------------------------------------------------
# Gerçek gateway semantiğinin birebir taklidi
# ---------------------------------------------------------------------------
class TrimAwareGateway:
    """`listAllMessages` offset dalı: jids filtresi → son-N kırpma → id sırala → dilim."""

    def __init__(self) -> None:
        self.messages: Dict[str, List[Dict[str, Any]]] = {}
        self.calls: List[Dict[str, Any]] = []
        self.on_call = None  # callable(call_index) → araya canlı trafik enjekte eder

    def add(self, jid: str, msg_id: int, wa: str) -> None:
        self.messages.setdefault(jid, []).append(
            {
                "conversation_id": jid,
                "wa_message_id": wa,
                "direction": "INBOUND",
                "body": f"b{msg_id}",
                "message_type": "TEXT",
                "created_at": _iso(msg_id),
                "id": msg_id,
            }
        )

    def window(self, per_chat: int = PER_CHAT) -> set:
        """Okuma anındaki 'son N' penceresi (nihai hâl)."""
        out = set()
        for lst in self.messages.values():
            ordered = sorted(lst, key=lambda m: m["id"])
            for m in ordered[-per_chat:]:
                out.add(m["wa_message_id"])
        return out

    async def list_all_messages(
        self,
        _gateway_id,
        limit: int = 1000,
        offset: int = 0,
        since=None,
        per_chat_limit=None,
        jids=None,
        after_seq=None,
        seq_epoch=None,
        **_kw,
    ):
        self.calls.append(
            {
                "offset": offset,
                "limit": limit,
                "jids": list(jids) if jids else None,
            }
        )
        if self.on_call is not None:
            self.on_call(len(self.calls))

        wanted = set(jids) if jids else None
        allm: List[Dict[str, Any]] = []
        per = per_chat_limit or PER_CHAT
        for jid, lst in self.messages.items():
            if wanted is not None and jid not in wanted:
                continue
            ordered = sorted(lst, key=lambda m: m["id"])
            if per and len(ordered) > per:
                ordered = ordered[-per:]
            allm.extend(ordered)
        allm.sort(key=lambda m: m["id"])
        total = len(allm)
        return {"messages": allm[offset: offset + int(limit)], "total": total}


def _iso(msg_id: int) -> str:
    return datetime.fromtimestamp(msg_id / 1000.0, tz=timezone.utc).isoformat()


async def make_conversations(n: int) -> Dict[int, str]:
    orch = WhatsAppSyncOrchestrator()
    items = [
        {
            "jid": generic_jid(),
            "name": f"conv-{i}",
            "last_message_at": None,
            "last_message_preview": None,
        }
        for i in range(n)
    ]
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(db, U6, items)
    return jid_by_conv


async def run_bulk(jid_by_conv: Dict[int, str], fake: TrimAwareGateway) -> SyncJob:
    job = SyncJob(sync_id=f"sync-{_uuid.uuid4().hex[:8]}", user_id=U6)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(sync_mod, "gw", fake)
            await orch._run_bulk_message_sync(db, job, dict(jid_by_conv), "gw-tz428")
    return job


async def persisted_wa_ids(conv_ids: List[int]) -> set:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id.in_(conv_ids))
        )
        return {str(r[0]) for r in res.all() if r[0]}


# ---------------------------------------------------------------------------
# 1. Parça matematiği (saf fonksiyon)
# ---------------------------------------------------------------------------
def test_bulk_chunks_splits_so_every_request_fits_one_page():
    jids = [f"j{i}" for i in range(45)]
    chunks = sync_mod._bulk_chunks(jids, PAGE_SIZE, PER_CHAT)
    assert len(chunks) == 3
    assert all(len(c) <= CHUNK for c in chunks)
    # Her parça en fazla chunk*per_chat = page_size kayıt döndürebilir.
    assert all(len(c) * PER_CHAT <= PAGE_SIZE for c in chunks)
    assert [j for c in chunks for j in c] == jids, "parçalama kayıp/tekrar üretmemeli"


def test_bulk_chunks_is_a_noop_when_per_chat_limit_is_absent():
    jids = [f"j{i}" for i in range(5)]
    assert sync_mod._bulk_chunks(jids, PAGE_SIZE, None) == [jids]
    assert sync_mod._bulk_chunks(jids, PAGE_SIZE, 0) == [jids]


def test_bulk_chunks_handles_empty_and_exact_multiples():
    assert sync_mod._bulk_chunks([], PAGE_SIZE, PER_CHAT) == []
    exact = [f"j{i}" for i in range(CHUNK * 2)]
    assert [len(c) for c in sync_mod._bulk_chunks(exact, PAGE_SIZE, PER_CHAT)] == [CHUNK, CHUNK]


# ---------------------------------------------------------------------------
# 2. Gerçek bulk sync: sayfalar arası offset KULLANILMAMALI
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_initial_sync_never_pages_with_a_cross_request_offset():
    jid_by_conv = await make_conversations(CHATS)
    fake = TrimAwareGateway()
    base = datetime.now(timezone.utc) - timedelta(hours=2)
    for i, jid in enumerate(jid_by_conv.values()):
        for k in range(PER_CHAT_TOTAL):
            fake.add(jid, int(base.timestamp() * 1000) + k * 10 + i, f"w-{i}-{k}")

    await run_bulk(jid_by_conv, fake)

    assert fake.calls, "en az bir istek yapılmalı"
    # ASIL KONTROL: hiçbir istek offset>0 ile başlamamalı.
    assert [c["offset"] for c in fake.calls] == [0] * len(fake.calls), (
        f"sayfalar arası offset kullanılmamalı: {[c['offset'] for c in fake.calls]}"
    )
    # Ve her istek jids ile sınırlı olmalı (tüm depoyu tek seferde çekmemeli).
    assert all(c["jids"] is not None for c in fake.calls), "her istek jid parçası taşımalı"
    assert all(len(c["jids"]) <= CHUNK for c in fake.calls), "parça boyu aşılmamalı"
    assert len(fake.calls) == 2, f"25 sohbet → 2 parça, alınan={len(fake.calls)}"


# ---------------------------------------------------------------------------
# 3. Front-trim sırasında hiçbir pencere kaydı atlanmamalı
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_initial_sync_does_not_skip_a_windowed_message_during_front_trim():
    jid_by_conv = await make_conversations(CHATS)
    fake = TrimAwareGateway()
    base = datetime.now(timezone.utc) - timedelta(hours=2)
    jids = list(jid_by_conv.values())
    for i, jid in enumerate(jids):
        for k in range(PER_CHAT_TOTAL):
            fake.add(jid, int(base.timestamp() * 1000) + k * 10 + i, f"w-{i}-{k}")

    late_wa = "w-late-0"

    def inject(call_index: int) -> None:
        # İlk parça okunduktan SONRA ilk sohbete yeni mesaj: penceresi ilerler,
        # en eski kaydı düşer, global dizi sola kayar.
        # `on_call` isteğin BAŞINDA çalışır → enjeksiyon 2. istekte olmalı ki
        # 1. yanıt enjeksiyondan ÖNCE üretilmiş olsun.
        if call_index == 2:
            fake.add(jids[0], LATE_ID, late_wa)

    fake.on_call = inject
    await run_bulk(jid_by_conv, fake)

    conv_ids = list(jid_by_conv.keys())
    delivered = await persisted_wa_ids(conv_ids)
    window = fake.window(PER_CHAT)
    missing = window - delivered
    genuine = missing - {late_wa}

    assert genuine == set(), (
        f"pencere kaydı atlanmamalı; atlanan={sorted(genuine)[:5]} "
        f"(delivered={len(delivered)}, window={len(window)})"
    )
    # Geç gelen mesaj meşru biçimde kapsam dışıdır (snapshot davranışı).
    assert late_wa in missing, "geç gelen mesaj sonraki turda yakalanmalı, burada değil"


# ---------------------------------------------------------------------------
# 4. Boş sohbet ve kısa sohbet parçayı bozmamalı
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_initial_sync_tolerates_empty_and_short_chats():
    jid_by_conv = await make_conversations(3)
    jids = list(jid_by_conv.values())
    fake = TrimAwareGateway()
    base = datetime.now(timezone.utc) - timedelta(hours=1)
    fake.add(jids[0], int(base.timestamp() * 1000), "w-only-one")  # tek mesaj
    # jids[1], jids[2] hiç yazılmadı → boş

    await run_bulk(jid_by_conv, fake)

    delivered = await persisted_wa_ids(list(jid_by_conv.keys()))
    assert delivered == {"w-only-one"}
    assert all(c["offset"] == 0 for c in fake.calls)
