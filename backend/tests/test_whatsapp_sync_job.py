"""WhatsApp Initial-Sync job mimarisi — 25 zorunlu test (§43).

Kapsam:
- Event sozlesmesi: 7 `whatsapp_sync_*` olayi, snake_case, sync_id + user_id (§13/§25)
- sync_id bazli stale-filtre semantigi ve job registry (§14)
- Cift-sync korumasi (IDLE/SYNCING/COMPLETED/FAILED durum makinesi) (§17)
- HTTP kisa omurlulugu (POST /sync 202, GET /sync/job, sync=true 502 yok) (§15/§16/§28)
- Korunan degismezler: +0 kapisi, grup/rehber adlari, preview kurallari (§5/§24, §27)
- Bulk sayfalam + batch'li dedup/INSERT + <=100'luk WS chunk (flush sonrasi serilesme) (§21/§23/§29/§30)
- Idempotency (wa_message_id), tenant izolasyonu (WS user_id routing) (§22/§40)
- Cancel (delete_session), legacy fallback, bulk-probe cache'i (§19/§26)
"""
import asyncio
import base64
import json
import time
import uuid as _uuid
from typing import Any, Dict, List

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select, func, text

from backend.app.main import app
from backend.app.api.v1.websocket import ConnectionManager
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.schemas.whatsapp import WhatsAppSyncJobResponse
from backend.app.services import whatsapp_service as ws

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"


def _make_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({
            "sub": user_id,
            "email": "sync-test@tezlify.com",
            "user_metadata": {"full_name": "Sync Test User"},
        }).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {_make_jwt()}"}


# ---------------------------------------------------------------------------
# Fixtures / yardımcilar
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture(autouse=True)
async def _isolate():
    """Her testtan once/sonra: suren job'lari bosalt + kullanici WA verisini sil."""
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "DELETE FROM messages WHERE user_id IN (:h1, :h2)"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM conversations WHERE user_id IN (:h1, :h2) AND channel = 'WHATSAPP'"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM contacts WHERE user_id IN (:h1, :h2)"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.execute(text(
                "DELETE FROM whatsapp_sessions WHERE user_id IN (:h1, :h2)"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX})
            await db.commit()

    await _drain_jobs()
    await _wipe()
    yield
    await _drain_jobs()
    await _wipe()


async def _drain_jobs():
    for _ in range(3):
        jobs = [j for j in ws._sync_jobs.values() if j.state == "SYNCING"]
        if not jobs:
            break
        await asyncio.wait_for(
            asyncio.gather(*[j.done.wait() for j in jobs], return_exceptions=True),
            timeout=10,
        )
    ws._sync_jobs.clear()
    ws._bulk_channel_cache["ok"] = False
    ws._bulk_channel_cache["checked_at"] = 0.0


@pytest.fixture
def mock_gateway():
    """Gateway fonksiyonlarini AsyncMock ile gomecek — bulk varsayilan bos."""
    from unittest.mock import AsyncMock, patch as _p

    patches = []

    def _patch(name: str, value: Any):
        p = _p(f"backend.app.services.whatsapp_gateway.{name}",
               new_callable=AsyncMock, return_value=value)
        patches.append(p)
        return p.start()

    _patch("health", {"status": "ok"})
    _patch("list_sessions", [])
    _patch("create_session", {"id": "gw-x"})
    delete = _patch("delete_session", {"success": True})
    _patch("logout_session", {"success": True})
    contacts = _patch("list_contacts", [])
    convs = _patch("list_conversations", {"items": [], "total": 0})
    messages = _patch("get_messages", {"messages": [], "has_more": False})
    subjects = _patch("sync_group_subjects", {"success": True, "resolved": 0})
    bulk = _patch("list_all_messages", {"messages": [], "total": 0, "offset": 0, "limit": 1000})

    yield type("MockGW", (), {
        "list_contacts": contacts,
        "list_conversations": convs,
        "get_messages": messages,
        "sync_group_subjects": subjects,
        "list_all_messages": bulk,
        "delete_session": delete,
    })()

    for p in patches:
        p.stop()


@pytest.fixture
def events():
    """_broadcast_sync_event'i yakala — payload sozlesmesi testleri icin."""
    captured: List[Dict[str, Any]] = []

    async def _capture(payload: Dict[str, Any]) -> None:
        captured.append(dict(payload))

    from unittest.mock import patch
    with patch("backend.app.services.whatsapp_service._broadcast_sync_event", new=_capture):
        yield captured


def _chat(jid: str, name: str, preview: Any = "Selam",
          ts: Any = "2025-01-15T10:00:00.000Z", unread: int = 0) -> Dict[str, Any]:
    return {"jid": jid, "id": jid, "name": name, "last_message_preview": preview,
            "last_message_at": ts, "unread_count": unread}


def _msg(jid: str, wa: str, body: str = "mesaj", direction: str = "INBOUND",
         ts: str = "2025-01-15T09:00:00.000Z", mtype: str = "TEXT") -> Dict[str, Any]:
    return {"conversation_id": jid, "direction": direction, "message_type": mtype,
            "status": "RECEIVED" if direction == "INBOUND" else "SENT", "body": body,
            "wa_message_id": wa, "sender_phone": jid.split("@")[0],
            "recipient_phone": "ME", "created_at": ts}


def _fake_bulk(all_msgs: List[Dict[str, Any]], data_delay: float = 0.0):
    """limit=1 → probe; aksi halde offset/limit sayfalamasi. P0.13: `since`
    (epoch sn) verildiginde gercek gateway gibi created_at filtresi uygular."""
    async def _bulk(limit: int = 1000, offset: int = 0, since=None):
        if limit == 1:
            return {"messages": [], "total": len(all_msgs), "offset": 0, "limit": 1}
        if data_delay:
            await asyncio.sleep(data_delay)
        pool = all_msgs
        if since is not None:
            from datetime import datetime, timezone
            pool = [m for m in all_msgs
                    if datetime.fromisoformat(str(m["created_at"]).replace("Z", "+00:00"))
                    .timestamp() >= since]
        return {"messages": pool[offset:offset + limit], "total": len(pool),
                "offset": offset, "limit": limit}
    return _bulk


async def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _drain_active():
    jobs = [j for j in ws._sync_jobs.values() if j.state == "SYNCING"]
    if jobs:
        await asyncio.wait_for(
            asyncio.gather(*[j.done.wait() for j in jobs], return_exceptions=True),
            timeout=10,
        )
    return jobs


def _of(events, name):
    return [e for e in events if e.get("event") == name]


# ---------------------------------------------------------------------------
# 1) Cift-sync korumasi / durum makinesi (§17)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_01_request_sync_dedupes_while_syncing():
    """SYNCING job varken ikinci request_sync AYNI sync_id'yi doner, yeni task yok."""
    from unittest.mock import AsyncMock, patch
    with patch("backend.app.services.whatsapp_service._run_sync_job", new_callable=AsyncMock) as runner:
        j1 = await ws.request_sync(None, TEST_USER)
        j2 = await ws.request_sync(None, TEST_USER)
        assert j1 is j2
        assert j1.sync_id == j2.sync_id
        assert j1.state == "SYNCING"
        await asyncio.sleep(0.01)
        runner.assert_awaited_once()
        # temizlik: job'u tamamla ki drain beklemesin
        j1.state = "COMPLETED"
        j1.done.set()
    ws._sync_jobs.clear()


@pytest.mark.asyncio
async def test_02_request_sync_new_job_after_completed(auth_headers, mock_gateway, events):
    """COMPLETED job sonrasi request_sync YENI sync_id ile taze job baslatir."""
    j1 = await ws.request_sync(None, TEST_USER)
    await j1.done.wait()
    assert j1.state == "COMPLETED"
    j2 = await ws.request_sync(None, TEST_USER)
    assert j2.sync_id != j1.sync_id
    await j2.done.wait()
    assert j2.state in ("COMPLETED", "FAILED")


# ---------------------------------------------------------------------------
# 2) Event sozlesmesi + tenant izolasyonu (§13/§25/§40)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_03_event_contract_all_events_carry_sync_id_and_user_id(
        auth_headers, mock_gateway, events):
    """Tam akis: started→contacts→chats→chunk→progress→complete; hepsinde sync_id+user_id."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Ayse Yilmaz")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(
        [_msg(MOCK_JID, "wamid_c1", "Bir"), _msg(MOCK_JID, "wamid_c2", "Iki", "OUTBOUND")])

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    names = [e["event"] for e in events]
    for required in ("whatsapp_sync_started", "whatsapp_sync_contacts_snapshot",
                     "whatsapp_sync_chats_snapshot", "whatsapp_sync_messages_chunk",
                     "whatsapp_sync_progress", "whatsapp_sync_complete"):
        assert required in names, f"{required} yok: {names}"
    assert names[0] == "whatsapp_sync_started"
    assert names[-1] == "whatsapp_sync_complete"
    for e in events:
        assert e["sync_id"] == job.sync_id
        assert e["user_id"] == TEST_USER
        assert str(e["event"]).islower() and " " not in e["event"]  # snake_case


@pytest.mark.asyncio
async def test_04_tenant_isolation_events_route_to_owner_only(mock_gateway):
    """Payload user_id tasir; ConnectionManager yalnizca o tenant'in socket'ine iletir."""
    captured: List[Dict[str, Any]] = []
    from unittest.mock import AsyncMock, patch

    async def _cap(payload):
        captured.append(payload)

    with patch("backend.app.api.v1.websocket.ws_manager.broadcast", new=AsyncMock(side_effect=_cap)):
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()

    assert captured, "ws_manager.broadcast hic cagrilmadi"
    for payload in captured:
        assert str(payload.get("user_id")) == TEST_USER  # §40: her olayda owner var

    # ConnectionManager birim testi: strict user routing — B kullanıcisi A olayini almaz
    class _FakeWS:
        def __init__(self):
            self.sent: List[str] = []

        async def accept(self):
            pass

        async def send_text(self, t):
            self.sent.append(t)

    mgr = ConnectionManager()
    a, b = _FakeWS(), _FakeWS()
    await mgr.connect(a, "user-A")
    await mgr.connect(b, "user-B")
    await mgr.broadcast({"event": "whatsapp_sync_progress", "user_id": "user-A"})
    assert len(a.sent) == 1
    assert len(b.sent) == 0


# ---------------------------------------------------------------------------
# 3) Sohbet snapshot'i: sayfalama + per-chat gateway cagrisi YOK (§21)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_05_chats_snapshot_paged_40_and_no_per_chat_fetch(mock_gateway, events):
    """45 sohbet → 2 chats_snapshot sayfasi (40+5); get_messages chat basina CAGRILMAZ."""
    jids = [f"9055500{i:05d}@s.whatsapp.net" for i in range(45)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(j, f"Musteri {i}") for i, j in enumerate(jids)], "total": 45}

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    snaps = _of(events, "whatsapp_sync_chats_snapshot")
    assert len(snaps) == 2
    assert [len(s["conversations"]) for s in snaps] == [40, 5]
    assert all(s["total"] == 45 for s in snaps)
    # Bulk hatti: chat basina gecmis cekim yok (§21 forbids per-chat requests)
    mock_gateway.get_messages.assert_not_awaited()


# ---------------------------------------------------------------------------
# 4) Bulk sayfalam + batch'li persist (§21/§23)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_06_bulk_paging_uses_offset_limit_and_total(mock_gateway, events):
    """2500 mesaj → limit=1000 ile offset 0/1000/2000 cagrilari; total job'a islenir."""
    msgs = [_msg(MOCK_JID, f"wamid_p{i}", f"m{i}",
                 ts=f"2025-01-15T09:{i % 60:02d}:00.000Z") for i in range(2500)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Paging")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    data_calls = [
        (c.kwargs.get("limit"), c.kwargs.get("offset"))
        for c in mock_gateway.list_all_messages.await_args_list
        if c.kwargs.get("limit") != 1
    ]
    assert data_calls == [(1000, 0), (1000, 1000), (1000, 2000)]
    assert job.messages_total == 2500
    assert job.messages_synced == 2500


@pytest.mark.asyncio
async def test_07_batched_dedup_single_select_per_batch(mock_gateway, events):
    """300 mesaj / 2 sohbet → dedup ICIN mesaj basina SELECT degil, batch basina 1 SELECT."""
    jid_a = "905551110001@s.whatsapp.net"
    jid_b = "905551110002@s.whatsapp.net"
    msgs = ([_msg(jid_a, f"wamid_a{i}", "x") for i in range(150)]
            + [_msg(jid_b, f"wamid_b{i}", "y") for i in range(150)])
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(jid_a, "A"), _chat(jid_b, "B")], "total": 2}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    real_factory = ws.AsyncSessionLocal
    sessions: List[Any] = []

    class _CountingSession:
        def __init__(self, inner):
            self._inner = inner
            self.message_selects = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return await self._inner.__aexit__(*exc)

        def __getattr__(self, name):
            return getattr(self._inner, name)

        async def execute(self, stmt, *a, **k):
            if "FROM messages" in str(stmt):
                self.message_selects += 1
            return await self._inner.execute(stmt, *a, **k)

    from unittest.mock import patch
    def _factory():
        s = _CountingSession(real_factory())
        sessions.append(s)
        return s

    with patch("backend.app.services.whatsapp_service.AsyncSessionLocal", new=_factory):
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()
    assert job.state == "COMPLETED", job.error

    total_message_selects = sum(s.message_selects for s in sessions)
    # Legacy yol 300 dedup SELECT atardi; yeni yol: 1 batch dedup (+ onarim 0 — preview'ler var)
    # + 1 P0.13 delta suucu SELECT'i (MAX external_timestamp, job basi tek seferlik).
    assert total_message_selects <= 3, f"mesaj SELECT sayisi: {total_message_selects}"


# ---------------------------------------------------------------------------
# 5) Idempotency (§22)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_08_idempotent_rerun_no_duplicate_rows(mock_gateway, events):
    """Ayni wa_message_id'li payload ile ikinci job: DB'de tek satir."""
    msgs = [_msg(MOCK_JID, "wamid_idem_1", "tek"),
            _msg(MOCK_JID, "wamid_idem_2", "iki")]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Idem")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    for _ in range(2):
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()
        assert job.state == "COMPLETED", job.error

    async with AsyncSessionLocal() as db:
        n1 = (await db.execute(select(func.count()).select_from(Message).where(
            Message.wa_message_id == "wamid_idem_1"))).scalar()
        n2 = (await db.execute(select(func.count()).select_from(Message).where(
            Message.wa_message_id == "wamid_idem_2"))).scalar()
    assert n1 == 1 and n2 == 1


# ---------------------------------------------------------------------------
# 6) Korunan degismezler: +0 kapisi, preview durum makinesi (§5/§24/§27)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_09_degenerate_jid_never_persisted_no_plus_zero(mock_gateway, events):
    """0@s.whatsapp.net DB'ye hic yazilmaz; +0 telefon/sihirli 'Grup' uretilmez."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat("0@s.whatsapp.net", "Status"), _chat(MOCK_JID, "Gercek")],
        "total": 2,
    }
    mock_gateway.list_contacts.return_value = [
        {"id": "0@s.whatsapp.net", "name": "WhatsApp"},
        {"id": MOCK_JID, "name": "Ali Ekincioğlu", "name_source": "addressbook"},
    ]

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    snaps = _of(events, "whatsapp_sync_chats_snapshot")
    ids = [c["id"] for s in snaps for c in s["conversations"]]
    assert len(ids) == 1  # dejenere sohbet snapshot'a da giremez
    async with AsyncSessionLocal() as db:
        zero = (await db.execute(select(func.count()).select_from(Contact).where(
            Contact.phone_e164 == "+0"))).scalar()
        conv_count = (await db.execute(select(func.count()).select_from(Conversation).where(
            Conversation.user_id.in_([TEST_USER, TEST_USER_HEX])))).scalar()
        ali = (await db.execute(select(Contact).where(
            Contact.phone_e164 == MOCK_PHONE))).scalar_one()
    assert zero == 0
    assert conv_count == 1
    assert ali.display_name == "Ali Ekincioğlu"  # rehber adi korunur (§27)


@pytest.mark.asyncio
async def test_10_preview_states_resolved_repairing_then_repaired(mock_gateway, events):
    """Preview'i olan sohbet RESOLVED; olmayan REPAIRING → complete'te mesajdan cozulur."""
    jid_b = "905551110009@s.whatsapp.net"
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Onlu", preview="Selam A"),
                  _chat(jid_b, "Eksik", preview=None, ts=None)],
        "total": 2,
    }
    mock_gateway.list_all_messages.side_effect = _fake_bulk(
        [_msg(jid_b, "wamid_r1", "B'nin mesaji", ts="2025-01-15T08:00:00.000Z")])

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    chats = {c["name"]: c for s in _of(events, "whatsapp_sync_chats_snapshot")
             for c in s["conversations"]}
    assert chats["Onlu"]["last_message_state"] == "RESOLVED"
    assert chats["Onlu"]["last_message_preview"] == "Selam A"
    assert chats["Eksik"]["last_message_state"] == "REPAIRING"

    done = _of(events, "whatsapp_sync_complete")[0]
    final = {c["name"]: c for c in done["conversations"]}
    assert final["Eksik"]["last_message_preview"] == "B'nin mesaji"
    assert final["Onlu"]["last_message_preview"] == "Selam A"


# ---------------------------------------------------------------------------
# 7) Cancel + fallback + failure (§19/§26)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_11_session_delete_cancels_running_job(auth_headers, mock_gateway, events):
    """delete_session → süren job iptal: FAILED + 'sync iptal edildi', yeni istek yok."""
    release = asyncio.Event()
    calls: List[Dict[str, Any]] = []

    async def _hanging_bulk(limit: int = 1000, offset: int = 0, since=None):
        if limit == 1:
            return {"messages": [], "total": 1, "offset": 0, "limit": 1}
        calls.append({"limit": limit, "offset": offset})
        await asyncio.wait_for(release.wait(), timeout=5)
        return {"messages": [], "total": 0, "offset": offset, "limit": limit}

    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Canceller")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _hanging_bulk

    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
            session_name="Cancel Hat", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()

    job = await ws.request_sync(None, TEST_USER)
    for _ in range(50):
        await asyncio.sleep(0.02)
        if calls:
            break
    assert calls, "bulk cagrisi beklenmedi"

    async with AsyncSessionLocal() as db:
        sid = (await db.execute(select(WhatsAppSession.id).where(
            WhatsAppSession.user_id.in_([TEST_USER, TEST_USER_HEX])))).scalars().first()
        assert sid is not None
    async with await _client() as client:
        res = await client.delete(f"/api/v1/whatsapp/sessions/{sid}", headers=auth_headers)
        assert res.status_code == 200

    assert job.cancel_requested is True
    release.set()
    await asyncio.wait_for(job.done.wait(), timeout=5)
    assert job.state == "FAILED"
    assert job.error == "sync iptal edildi"
    failed = _of(events, "whatsapp_sync_failed")
    assert not failed  # iptal, kullici hatasi degil — UI'a failed yayinlanmaz (§26)


@pytest.mark.asyncio
async def test_12_bulk_unavailable_falls_back_to_legacy(mock_gateway, events):
    """Eski gateway (bulk 404) → job legacy per-chat hattina fail-soft duser."""
    mock_gateway.list_all_messages.side_effect = Exception("Gateway hatasi 404: not found")
    from unittest.mock import AsyncMock, patch
    with patch("backend.app.services.whatsapp_service._sync_conversations_impl",
               new_callable=AsyncMock, return_value=[]) as legacy:
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()
    assert job.state == "COMPLETED", job.error  # fallback hata degil, tamamlanir
    legacy.assert_awaited_once()


@pytest.mark.asyncio
async def test_13_legacy_fallback_receives_db_and_owner(mock_gateway, events):
    """Fallback cagrisi (db, owner) ile yapilir — owner izolasyonu korunur."""
    mock_gateway.list_all_messages.side_effect = Exception("Gateway hatasi 404")
    from unittest.mock import AsyncMock, patch
    with patch("backend.app.services.whatsapp_service._sync_conversations_impl",
               new_callable=AsyncMock, return_value=[]) as legacy:
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()
    args = legacy.await_args.args
    assert str(args[1]) == TEST_USER


@pytest.mark.asyncio
async def test_14_failure_emits_failed_event_with_error_and_stage(mock_gateway, events):
    """Chats asamasinda gateway patlarsa: whatsapp_sync_failed {error, stage='chats'}."""
    mock_gateway.list_conversations.side_effect = Exception("gw down")

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "FAILED"
    assert "gw down" in (job.error or "")

    failed = _of(events, "whatsapp_sync_failed")
    assert len(failed) == 1
    assert failed[0]["stage"] == "chats"
    assert "gw down" in failed[0]["error"]
    assert failed[0]["sync_id"] == job.sync_id
    assert not _of(events, "whatsapp_sync_complete")  # sahte tamamlanma YOK (§1)


# ---------------------------------------------------------------------------
# 8) HTTP kisa omurlulugu (§15/§16/§28)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_15_get_sync_job_idle_when_no_job(auth_headers):
    """Job registry bosken GET /sync/job → state IDLE, sync_id None (uydurma durum yok)."""
    async with await _client() as client:
        res = await client.get("/api/v1/whatsapp/sync/job", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["state"] == "IDLE"
        assert data["sync_id"] is None


@pytest.mark.asyncio
async def test_16_post_sync_returns_202_with_snapshot(auth_headers, mock_gateway, events):
    """POST /sync → 202 + gercek job snapshot'i (sync_id dolu, state SYNCING/COMPLETED)."""
    async with await _client() as client:
        res = await client.post("/api/v1/whatsapp/sync", headers=auth_headers)
        assert res.status_code == 202
        data = res.json()
        assert data["sync_id"]
        assert data["state"] in ("SYNCING", "COMPLETED", "FAILED")
        # Ayni anda ikinci POST ayni job'i doner (cift-sync yok, §17)
        res2 = await client.post("/api/v1/whatsapp/sync", headers=auth_headers)
        data2 = res2.json()
        if data["state"] == "SYNCING":
            assert data2["sync_id"] == data["sync_id"]
        await _drain_active()


@pytest.mark.asyncio
async def test_17_sync_true_endpoint_is_short_lived(auth_headers, mock_gateway, events):
    """sync=true agir isi BEKLEMEZ: 200 + aninda snapshot, job arka planda surer."""
    msgs = [_msg(MOCK_JID, f"wamid_slow{i}", "x") for i in range(5)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Yavas")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs, data_delay=0.6)

    async with await _client() as client:
        t0 = time.monotonic()
        res = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        elapsed = time.monotonic() - t0
        assert res.status_code == 200  # eskiden 502'se bu 200 + kisa
        assert elapsed < 0.5, f"endpoint {elapsed:.2f}s bekletti — kisa omurlu degil"
        active = [j for j in ws._sync_jobs.values() if j.state == "SYNCING"]
        assert active, "job arka planda surmuyor"
        await _drain_active()


@pytest.mark.asyncio
async def test_18_run_initial_sync_broadcasts_conversations_updated(mock_gateway):
    """Faz 8 sozlesmesi (§25 kirilmaz): _run_initial_sync COMPLETED → conversations_updated."""
    from unittest.mock import AsyncMock, patch
    captured: List[Dict[str, Any]] = []

    async def _cap(payload):
        captured.append(payload)

    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Faz8")], "total": 1}
    with patch("backend.app.api.v1.websocket.ws_manager.broadcast", new=AsyncMock(side_effect=_cap)):
        await ws._run_initial_sync(TEST_USER)

    assert any(c.get("event") == "conversations_updated" for c in captured)


# ---------------------------------------------------------------------------
# 9) Chunk sozlesmesi: <=100, sayisal DB kimligi, flush sonrasi serilesme (§29/§30)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_19_message_chunks_max_100_with_numeric_db_ids(mock_gateway, events):
    """250 mesaj → 100/100/50 chunk; her mesajda sayisal id + conversation_id (ham jid YOK)."""
    msgs = [_msg(MOCK_JID, f"wamid_ch{i}", f"m{i}") for i in range(250)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Chunk")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    chunks = _of(events, "whatsapp_sync_messages_chunk")
    assert [len(c["messages"]) for c in chunks] == [100, 100, 50]
    for c in chunks:
        assert c["total"] == 250
        assert all(isinstance(m["id"], int) and m["id"] > 0 for m in c["messages"])
        assert all(isinstance(m["conversation_id"], int) for m in c["messages"])
        # §30: frontend'e ham WhatsApp nesnesi/jid sizmaz
        assert all("key" not in m and "jid" not in m for m in c["messages"])
        assert all("@" not in str(m.get("conversation_id")) for m in c["messages"])


@pytest.mark.asyncio
async def test_20_progress_event_carries_stage_and_real_counters(mock_gateway, events):
    """whatsapp_sync_progress: stage + chats/messages sayaclari GERCEK durumdan."""
    msgs = [_msg(MOCK_JID, f"wamid_pg{i}", "x") for i in range(3)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Progress")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    progs = _of(events, "whatsapp_sync_progress")
    assert progs, "progress olayi yok"
    p = progs[-1]
    assert p["stage"] == "messages"
    assert p["chats_total"] == 1 and p["chats_synced"] == 1
    assert p["messages_total"] == 3 and p["messages_synced"] == 3


@pytest.mark.asyncio
async def test_21_complete_event_carries_full_resolved_list(mock_gateway, events):
    """whatsapp_sync_complete: cozulmus tam sohbet listesi + final sayaclar."""
    jid_b = "905551110007@s.whatsapp.net"
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Tam A"), _chat(jid_b, "Tam B")], "total": 2}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(
        [_msg(MOCK_JID, "wamid_t1", "x"), _msg(jid_b, "wamid_t2", "y")])

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    done = _of(events, "whatsapp_sync_complete")[0]
    assert done["chats_synced"] == 2
    assert done["messages_synced"] == 2
    assert len(done["conversations"]) == 2
    for c in done["conversations"]:
        assert isinstance(c["id"], int)
        assert c["name"] in ("Tam A", "Tam B")
        assert c["last_message_preview"]  # complete listesi cozulmus preview tasir
    async with AsyncSessionLocal() as db:
        db_ids = set((await db.execute(select(Conversation.id).where(
            Conversation.user_id.in_([TEST_USER, TEST_USER_HEX])))).scalars().all())
    assert db_ids == {c["id"] for c in done["conversations"]}


# ---------------------------------------------------------------------------
# 10) Sozlesme yapi + registry semantigi + cache + DB oturum ayari
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_22_snapshot_shape_matches_job_response_schema():
    """SyncJob.snapshot() → WhatsAppSyncJobResponse dogrudan doğrulayabilmeli (§28)."""
    job = ws.SyncJob(sync_id="sid-123", user_id=TEST_USER)
    snap = job.snapshot()
    resp = WhatsAppSyncJobResponse(**snap)
    assert resp.sync_id == "sid-123"
    assert resp.state == "SYNCING"
    assert resp.stage == "starting"
    assert set(snap.keys()) == set(WhatsAppSyncJobResponse.model_fields.keys())


@pytest.mark.asyncio
async def test_23_stale_sync_id_semantics_new_job_supersedes_old(mock_gateway, events):
    """Eski job'in olaylari eski sync_id tasir; yeni job'un sync_id'si farklidir →
    frontend stale-filtresi (§14) eski olaylari bu karsilastirmayla eleyebilir."""
    job1 = await ws.request_sync(None, TEST_USER)
    await job1.done.wait()
    stale_event = ws._sync_event(job1, "whatsapp_sync_progress", stage="messages")

    job2 = await ws.request_sync(None, TEST_USER)
    await job2.done.wait()

    assert stale_event["sync_id"] == job1.sync_id != job2.sync_id
    # Registry guncel job'u tasiyor (reconnect kurtarmasi GET /sync/job kaynagi)
    snap = ws.get_sync_job(TEST_USER)
    assert snap and snap["sync_id"] == job2.sync_id


@pytest.mark.asyncio
async def test_24_bulk_probe_cached_five_minutes(mock_gateway):
    """Bulk-kanal algilama tek probe; 5 dk cache — her job probe atmaz (§21 storm yok)."""
    mock_gateway.list_all_messages.side_effect = None
    mock_gateway.list_all_messages.return_value = {"messages": [], "total": 0}
    assert await ws._bulk_channel_available() is True
    assert await ws._bulk_channel_available() is True
    probe_calls = [c for c in mock_gateway.list_all_messages.await_args_list
                   if c.kwargs.get("limit") == 1]
    assert len(probe_calls) == 1

    # Cache suresi dolunca yeniden probe
    ws._bulk_channel_cache["checked_at"] = time.monotonic() - 301
    assert await ws._bulk_channel_available() is True
    probe_calls = [c for c in mock_gateway.list_all_messages.await_args_list
                   if c.kwargs.get("limit") == 1]
    assert len(probe_calls) == 2


@pytest.mark.asyncio
async def test_25_sessionmaker_expire_on_commit_false_preserved():
    """Flush/commit sonrasi serilesme + preview onarimi expire_on_commit=False'a dayanir."""
    assert AsyncSessionLocal.kw.get("expire_on_commit") is False
    # Job icerisindeki session da ayni factory'den uretilir (kullanim hatasi olmasin)
    assert ws.AsyncSessionLocal is AsyncSessionLocal


# ---------------------------------------------------------------------------
# Faz 6 — P0 performans yeniden siralama / batch / bootstrap sozlesmeleri
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_26_chats_snapshot_precedes_contacts_snapshot(mock_gateway, events):
    """P0.3: sohbet anlik goruntusu REHBER fazindan once yayinlanir — kullanici
    sohbete job'un ilk fazinda baslar (WhatsApp Web sirasi)."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Ayse Yilmaz")], "total": 1}
    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    names = [e["event"] for e in events]
    i_chats = names.index("whatsapp_sync_chats_snapshot")
    i_contacts = names.index("whatsapp_sync_contacts_snapshot")
    assert i_chats < i_contacts, f"chats_oncelikli olmali: {names}"


@pytest.mark.asyncio
async def test_27_sync_contacts_single_prefetch_select_no_n_plus_one(mock_gateway):
    """P0.6: 50 kisilik rehberde kisi basina SELECT YOK — tek prefetch SELECT.
    (Eski yol: 50 SELECT + 50 flush; yeni yol: 1 SELECT + 1 flush.)"""
    from sqlalchemy import event as sa_event
    from backend.app.core.database import engine

    jids = [f"9055511{i:05d}@s.whatsapp.net" for i in range(50)]
    mock_gateway.list_contacts.return_value = [
        {"id": j, "name": f"Musteri {i}", "name_source": "addressbook"}
        for i, j in enumerate(jids)]

    contact_selects: List[str] = []

    def _count(conn, cursor, statement, parameters, context, executemany):
        if "FROM contacts" in statement.lower().replace('"', ""):
            contact_selects.append(statement)

    sa_event.listen(engine.sync_engine, "before_cursor_execute", _count)
    try:
        async with AsyncSessionLocal() as db:
            out = await ws.sync_contacts(db, TEST_USER)
    finally:
        sa_event.remove(engine.sync_engine, "before_cursor_execute", _count)

    assert len(out) == 50
    # 50 kisi icin en fazla 2 SELECT (prefetch + flush sonrasi hic); N+1 olsaydi
    # 50+ olurdu.
    assert len(contact_selects) <= 2, f"N+1 dondu: {len(contact_selects)} SELECT"
    async with AsyncSessionLocal() as db:
        n = (await db.execute(select(func.count()).select_from(Contact).where(
            Contact.user_id.in_([TEST_USER, TEST_USER_HEX])))).scalar()
    assert n == 50


@pytest.mark.asyncio
async def test_28_bulk_dedup_select_once_per_conversation_across_pages(mock_gateway, events):
    """P0.8: 3 sayfa x 1000 mesaj, TEK sohbet — dedup SELECT sayfa basina
    DEĞIL, sohbet basina bir kez calisir (eski yol: 3 tam tarama)."""
    from sqlalchemy import event as sa_event
    from backend.app.core.database import engine

    msgs = [_msg(MOCK_JID, f"wamid_d{i}", f"m{i}",
                 ts=f"2025-02-01T09:{i % 60:02d}:00.000Z") for i in range(2500)]
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Dedup")], "total": 1}
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    dedup_selects: List[str] = []

    def _count(conn, cursor, statement, parameters, context, executemany):
        s = statement.lower().replace('"', "")
        if "from messages" in s and "wa_message_id" in s and "in (" in s:
            dedup_selects.append(statement)

    sa_event.listen(engine.sync_engine, "before_cursor_execute", _count)
    try:
        job = await ws.request_sync(None, TEST_USER)
        await job.done.wait()
    finally:
        sa_event.remove(engine.sync_engine, "before_cursor_execute", _count)

    assert job.state == "COMPLETED", job.error
    assert job.messages_synced == 2500
    # 3 sayfada ayni sohbet icin dedup SELECT TEK sefer (onbellek calisiyor).
    assert len(dedup_selects) == 1, f"dedup sayfalar arasi onbellek kirildi: {len(dedup_selects)}"


@pytest.mark.asyncio
async def test_29_conversation_updated_emits_throttled_bootstrap_signal(mock_gateway, events):
    """P0.4/PHASE-28: history-sync sirasinda DB'ye yazilan her
    conversation_updated, owner'in WS'ine (2 sn throttle'li)
    whatsapp_sync_chats_bootstrap sinyali verir — UI job'u beklemez."""
    from unittest.mock import patch

    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=TEST_USER, gateway_id="gw-boot", session_name="boot",
            status=SessionStatus.CONNECTED))
        await db.commit()

    ws._last_bootstrap_emit.clear()
    captured: List[Dict[str, Any]] = []

    async def _cap(payload):
        captured.append(dict(payload))

    with patch("backend.app.services.whatsapp_service._broadcast_sync_event", new=_cap):
        async with AsyncSessionLocal() as db:
            await ws._map_conversation_event(db, {
                "event": "conversation_updated",
                "conversation_id": MOCK_JID,
                "conversation": {
                    "id": MOCK_JID, "name": "Canli Kisi",
                    "last_message_preview": "Merhaba",
                    "last_message_at": "2025-03-01T10:00:00.000Z",
                },
            })
            # ikinci olay throttle araliginda — ikinci sinyal OLMAMALI
            await ws._map_conversation_event(db, {
                "event": "conversation_updated",
                "conversation_id": MOCK_JID,
                "conversation": {
                    "id": MOCK_JID, "name": "Canli Kisi",
                    "last_message_preview": "Merhaba 2",
                    "last_message_at": "2025-03-01T10:00:05.000Z",
                },
            })
        await asyncio.sleep(0.05)  # fire-and-forget task'lari bosalt

    boots = [e for e in captured if e.get("event") == "whatsapp_sync_chats_bootstrap"]
    assert len(boots) == 1, f"throttle calismadi: {len(boots)} sinyal"
    assert boots[0]["user_id"] == TEST_USER
    assert boots[0]["sync_id"] == "live"


@pytest.mark.asyncio
async def test_30_stage_timings_instrumented_in_snapshot_and_complete(mock_gateway, events):
    """P0.1: her fazin GERCEK suresi (monotonic delta) snapshot + complete
    olayinda ve GET /sync/job semasinda yayinlanir."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Timed")], "total": 1}
    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    for phase in ("group_subjects", "chats", "contacts", "messages", "finalizing"):
        assert phase in job.stage_timings, f"faz olcumu yok: {phase}"
        assert job.stage_timings[phase] >= 0.0

    done = _of(events, "whatsapp_sync_complete")[0]
    assert done["stage_timings"] == job.stage_timings
    assert done["duration_s"] >= 0.0
    snap = job.snapshot()
    assert snap["stage_timings"] == job.stage_timings
    # Schema dogrulamasi (test_22 sozlesmesi genisletildi):
    resp = WhatsAppSyncJobResponse(**snap)
    assert resp.stage_timings == job.stage_timings


@pytest.mark.asyncio
async def test_31_chat_name_authority_survives_chats_first_order(mock_gateway, events):
    """P0.3 regresyon: chats->contacts sirasinda rehber fazindaki es-rutbeli
    (history) ad sohbet adini EZEMEZ — _reapply_chat_names otoriteyi korur.
    Yuksek rutbe (addressbook) ise sohbet adini ezmeye DEVAM EDER (§27)."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Ayse Yilmaz")], "total": 1}
    # Eski (mock) davranis: rehber, ayni kisi icin farkli es-rutbeli ad tasir.
    mock_gateway.list_contacts.return_value = [
        {"id": MOCK_JID, "name": "Test Lead"},  # name_source yok -> history
        {"id": "905320000001@s.whatsapp.net", "name": "Rehber Adi",
         "name_source": "addressbook"},
    ]

    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    async with AsyncSessionLocal() as db:
        ayse = (await db.execute(select(Contact).where(
            Contact.phone_e164 == MOCK_PHONE))).scalar_one()
    assert ayse.display_name == "Ayse Yilmaz"  # sohbet adli kazanir (tie-break)


@pytest.mark.asyncio
async def test_32_delta_sync_uses_real_db_watermark(mock_gateway, events):
    """P0.13: ikinci job, gateway'den DB'deki en son mesaj zamanindan
    (5 dk overlap'li GERCEK suuc) sonrasi ister — uydurma suuc yok; ilk
    senkronda suuc None → tam cekim."""
    from datetime import datetime, timezone

    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Delta")], "total": 1}
    msgs = [_msg(MOCK_JID, f"wamid_d{i}", ts="2025-01-15T09:00:00.000Z")
            for i in range(3)]
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    job1 = await ws.request_sync(None, TEST_USER)
    await job1.done.wait()
    assert job1.state == "COMPLETED", job1.error
    assert job1.messages_synced == 3

    # Ilk job'taki bulk cagrilarinda suuc yok (DB bos) → None/gecersiz.
    real_calls = [c for c in mock_gateway.list_all_messages.call_args_list
                  if c.kwargs.get("limit") != 1]
    assert all(c.kwargs.get("since") is None for c in real_calls)

    mock_gateway.list_all_messages.reset_mock()
    mock_gateway.list_all_messages.side_effect = _fake_bulk(msgs)

    job2 = await ws.request_sync(None, TEST_USER)
    await job2.done.wait()
    assert job2.state == "COMPLETED", job2.error

    expected = int(datetime(2025, 1, 15, 9, 0, tzinfo=timezone.utc).timestamp()) - 300
    real_calls2 = [c for c in mock_gateway.list_all_messages.call_args_list
                   if c.kwargs.get("limit") != 1]
    assert real_calls2, "ikinci job bulk kanalina dokunmadi"
    for c in real_calls2:
        assert c.kwargs.get("since") == expected
    # Dedup: suuc'ya ragmen ayni mesajlar gelirse tekrar YAZILMAZ.
    assert job2.messages_synced == 0
    async with AsyncSessionLocal() as db:
        n = (await db.execute(select(func.count()).select_from(Message).where(
            Message.user_id == TEST_USER))).scalar()
    assert n == 3


@pytest.mark.asyncio
async def test_33_lazy_hydration_on_open_before_job(mock_gateway, events):
    """P0.11: job mesajlari henuz hydrate ETMEDEN kullanici sohbeti actiginda
    get_messages gateway belleğinden gercek mesajlari cekip kalici yazar;
    tekrar acista dedup sayesinde duplicate olusmaz."""
    mock_gateway.list_conversations.return_value = {
        "items": [_chat(MOCK_JID, "Lazy", preview=None, ts=None)], "total": 1}
    # Bulk kanali bos → job hic mesaj yazmadi (hydrate edilmemis sohbet).
    job = await ws.request_sync(None, TEST_USER)
    await job.done.wait()
    assert job.state == "COMPLETED", job.error

    async with AsyncSessionLocal() as db:
        conv = (await db.execute(select(Conversation).where(
            Conversation.user_id == TEST_USER,
            Conversation.channel == "WHATSAPP"))).scalar_one()
        assert conv is not None
        cid = conv.id

    mock_gateway.get_messages.return_value = {
        "messages": [
            _msg(MOCK_JID, "wamid_h1", "Ilk", ts="2025-01-14T08:00:00.000Z"),
            _msg(MOCK_JID, "wamid_h2", "Ikinci", ts="2025-01-14T09:00:00.000Z"),
        ], "has_more": False}

    async with AsyncSessionLocal() as db:
        out = await ws.get_messages(db, TEST_USER, cid, limit=50)
    bodies = [m["body"] for m in out["messages"]]
    assert bodies == ["Ilk", "Ikinci"]  # kronolojik sira korunur

    # Idempotency: ikinci acilis gateway'i tekrar sorsa da duplicate yazilmaz.
    async with AsyncSessionLocal() as db:
        out2 = await ws.get_messages(db, TEST_USER, cid, limit=50)
    assert len(out2["messages"]) == 2
    async with AsyncSessionLocal() as db:
        n = (await db.execute(select(func.count()).select_from(Message).where(
            Message.conversation_id == cid))).scalar()
    assert n == 2

    # Preview de hydrate edilen gercek mesajla guncellendi (§29 tutarliligi).
    async with AsyncSessionLocal() as db:
        conv2 = (await db.execute(select(Conversation).where(
            Conversation.id == cid))).scalar_one()
    assert conv2.last_message_at is not None
