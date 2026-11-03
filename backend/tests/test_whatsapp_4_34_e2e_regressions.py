"""AŞAMA 4.34 — E2E kabul için deterministik regresyonlar.

Kapsam (4.28'de açık kalanlar + iki P2 açığı):

  * P2-1: `only_conv_ids` daraltması + jid parçalama KOMBİNASYONU.
    (4.28'de yalnızca `request_jids` "tek daraltma kaynağı" olarak
     belirtilmişti; parçalamayla birlikte hiç test edilmemişti.)
  * P2-2: `recovery_pass` ilerleme sayaçlarını EZMEMELİ.
  * Senaryo 11: büyük grup — grup jid'i TEK sohbet sayılır, atlama yok.
  * Senaryo 10 (proxy): yeniden sync (reconnect sonrası) idempotent olmalı.

Bu testler CANLI mesaj göndermez ve production'a YAZMAZ; sahte gateway ile
gerçek `_run_bulk_message_sync` kod yolunu çalıştırır.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

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

# Bu dosyaya özel kiracı (U5/U6 ile çakışmasın).
U7 = "77777777-7777-7777-7777-777777777777"
U7_HEX = U7.replace("-", "")

PAGE_SIZE = 1000          # _SYNC_BULK_PAGE_SIZE
PER_CHAT = 50             # _SYNC_PER_CHAT_LIMIT
CHUNK = PAGE_SIZE // PER_CHAT   # 20


def generic_jid() -> str:
    return f"9057{_uuid.uuid4().int % 10**10:010d}@s.whatsapp.net"


def group_jid() -> str:
    return f"12036{_uuid.uuid4().int % 10**13:013d}@g.us"


@pytest_asyncio.fixture(autouse=True)
async def _clean_tenant():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id = :u"), {"u": U7_HEX}
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


# ---------------------------------------------------------------------------
# Gerçek gateway offset dalının birebir taklidi (4.28 dosyasıyla aynı)
# ---------------------------------------------------------------------------
class TrimAwareGateway:
    """`listAllMessages` offset dalı: jids filtresi → son-N kırpma → id sırala → dilim."""

    def __init__(self) -> None:
        self.messages: Dict[str, List[Dict[str, Any]]] = {}
        self.calls: List[Dict[str, Any]] = []
        self.on_call = None

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
            {"offset": offset, "limit": limit, "jids": list(jids) if jids else None}
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


async def make_conversations(n: int, jid_factory=generic_jid) -> Dict[int, str]:
    orch = WhatsAppSyncOrchestrator()
    items = [
        {
            "jid": jid_factory(),
            "name": f"conv-{i}",
            "last_message_at": None,
            "last_message_preview": None,
        }
        for i in range(n)
    ]
    async with AsyncSessionLocal() as db:
        _out, jid_by_conv = await orch._persist_chat_snapshot(db, U7, items)
    return jid_by_conv


async def run_bulk(
    jid_by_conv: Dict[int, str],
    fake: TrimAwareGateway,
    *,
    recovery_pass: bool = False,
    only_conv_ids=None,
    is_initial: bool = True,
    job: SyncJob | None = None,
) -> SyncJob:
    job = job or SyncJob(sync_id=f"sync-{_uuid.uuid4().hex[:8]}", user_id=U7)
    orch = WhatsAppSyncOrchestrator()
    async with AsyncSessionLocal() as db:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(sync_mod, "gw", fake)
            await orch._run_bulk_message_sync(
                db,
                job,
                dict(jid_by_conv),
                "gw-tz434",
                recovery_pass=recovery_pass,
                only_conv_ids=only_conv_ids,
                is_initial=is_initial,
            )
    return job


async def persisted_wa_ids(conv_ids) -> set:
    async with AsyncSessionLocal() as db:
        res = await db.execute(
            select(Message.wa_message_id).where(Message.conversation_id.in_(conv_ids))
        )
        return {str(r[0]) for r in res.all() if r[0]}


def fill(fake: TrimAwareGateway, jid_by_conv: Dict[int, str], per_chat: int = 60) -> None:
    base = datetime.now(timezone.utc) - timedelta(hours=2)
    for i, jid in enumerate(jid_by_conv.values()):
        for k in range(per_chat):
            fake.add(jid, int(base.timestamp() * 1000) + k * 10 + i, f"w-{i}-{k}")


# ---------------------------------------------------------------------------
# P2-1: only_conv_ids + chunking KOMBİNASYONU
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_only_conv_ids_narrows_the_request_before_chunking():
    """Daraltma ÖNCE, parçalama SONRA. Hedef dışı sohbet istenmemeli/yazılmamalı."""
    jid_by_conv = await make_conversations(25)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv)

    target_ids = set(list(jid_by_conv.keys())[:5])
    target_jids = {jid_by_conv[c] for c in target_ids}

    job = await run_bulk(jid_by_conv, fake, only_conv_ids=target_ids)

    assert len(fake.calls) == 1, f"5 sohbet tek parça olmalı: {fake.calls}"
    assert fake.calls[0]["jids"] is not None
    assert set(fake.calls[0]["jids"]) == target_jids, "istek yalnızca hedefleri taşımalı"
    assert fake.calls[0]["offset"] == 0

    got = await persisted_wa_ids(list(jid_by_conv.keys()))
    expected = set()
    for jid in target_jids:
        ordered = sorted(fake.messages[jid], key=lambda m: m["id"])[-PER_CHAT:]
        expected |= {m["wa_message_id"] for m in ordered}
    assert got == expected, "yalnızca hedef sohbetler yazılmalı"
    assert job.messages_total == len(expected)


@pytest.mark.asyncio
async def test_only_conv_ids_full_set_still_chunks():
    """Daraltma tüm sohbetleri kapsasa bile parçalama uygulanmalı (2 parça)."""
    jid_by_conv = await make_conversations(25)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv)
    all_ids = set(jid_by_conv.keys())

    await run_bulk(jid_by_conv, fake, only_conv_ids=all_ids)

    assert len(fake.calls) == 2, f"25 sohbet → 2 parça, alınan={len(fake.calls)}"
    assert all(c["jids"] is not None for c in fake.calls)
    assert all(len(c["jids"]) <= CHUNK for c in fake.calls)
    assert all(c["offset"] == 0 for c in fake.calls)

    got = await persisted_wa_ids(list(jid_by_conv.keys()))
    assert len(got) == 25 * PER_CHAT, "25 sohbet × 50 pencere = 1250"


# ---------------------------------------------------------------------------
# P2-2: recovery_pass sayaç koruması
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_recovery_pass_does_not_overwrite_messages_total():
    jid_by_conv = await make_conversations(3)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv, per_chat=10)

    job = SyncJob(sync_id=f"sync-{_uuid.uuid4().hex[:8]}", user_id=U7)
    job.messages_total = 424242  # kullanıcının gördüğü ilk senkron ilerlemesi

    await run_bulk(jid_by_conv, fake, recovery_pass=True, job=job)

    assert job.messages_total == 424242, "recovery_pass ilerleme sayacını EZMEMELİ"
    got = await persisted_wa_ids(list(jid_by_conv.keys()))
    assert len(got) == 30, "recovery_pass yine de veriyi yazmalı (sayaç korunur)"


@pytest.mark.asyncio
async def test_normal_pass_does_overwrite_messages_total():
    """Kontrol grubu: recovery_pass DEĞİLken sayaç gerçek toplama güncellenir."""
    jid_by_conv = await make_conversations(3)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv, per_chat=10)

    job = SyncJob(sync_id=f"sync-{_uuid.uuid4().hex[:8]}", user_id=U7)
    job.messages_total = 0

    await run_bulk(jid_by_conv, fake, recovery_pass=False, job=job)

    assert job.messages_total == 30, f"normal tur sayacı güncellemeli: {job.messages_total}"


# ---------------------------------------------------------------------------
# Senaryo 11: büyük grup — grup jid'i tek sohbet
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_group_jid_is_treated_as_one_conversation_without_skipping():
    jid_by_conv = await make_conversations(1, jid_factory=group_jid)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv, per_chat=60)  # 60 > 50 → pencere kırpması tetiklenir

    await run_bulk(jid_by_conv, fake)

    assert len(fake.calls) == 1, "grup jid'i tek sohbet → tek istek"
    assert fake.calls[0]["jids"] == list(jid_by_conv.values())
    assert fake.calls[0]["offset"] == 0

    got = await persisted_wa_ids(list(jid_by_conv.keys()))
    assert got == fake.window(PER_CHAT), "grup penceresinde kayıt atlanmamalı"
    assert len(got) == PER_CHAT


# ---------------------------------------------------------------------------
# Senaryo 10 (proxy): reconnect sonrası yeniden sync idempotent
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_second_initial_sync_is_idempotent():
    """Reconnect'in tetiklediği yeniden sync yeni satır ÜRETMEMELİ, veri kaybetmemeli."""
    jid_by_conv = await make_conversations(4)
    fake = TrimAwareGateway()
    fill(fake, jid_by_conv, per_chat=20)

    await run_bulk(jid_by_conv, fake)
    first = await persisted_wa_ids(list(jid_by_conv.keys()))

    job2 = await run_bulk(jid_by_conv, fake)
    second = await persisted_wa_ids(list(jid_by_conv.keys()))

    assert first == second, "yeniden sync veri kümesini değiştirmemeli"
    assert len(first) == 4 * 20
    assert job2.messages_synced == 0, f"ikinci tur yeni mesaj yazmamalı: {job2.messages_synced}"
