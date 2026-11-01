"""AŞAMA 5.2 — `messages.upsert` `notify` / `append` davranış sözleşmesi.

Neden bu dosya var
------------------
Baileys `messages.upsert` olayı bir `type` taşır: `notify` (mesaj az önce
geldi) veya `append` (mesaj geçmiş/senkron kapsamında eklendi). Gateway bu
alanı uzun süre yalnızca teşhis log'una yazıyordu; `_ingestUpsertMessage` onu
hiç görmüyordu. Sonuç: geçmiş bir mesaj yeni gelmiş gibi rozeti artırıyor,
konuşma önizlemesini oynatıyor ve canlı yayın üretiyordu.

Bu dosya sözleşmeyi **gerçek ingestion zinciri** üzerinden doğrular
(`ingest_gateway_event`), ve köprü katmanını (`gateway_websocket_endpoint`)
ayrıca test eder — çünkü `_no_broadcast` kararı orada uygulanır.

Sözleşme
--------
NOTIFY : persist + canlı yayın + rozet + önizleme (mevcut davranış).
APPEND : persist edilir, canlı yayın YOK, rozet ARTMAZ, önizleme yalnızca
         gerçekten daha yeni ise oynar.

DB: `AsyncSessionLocal` (conftest'in `run_db_migrations` fixture'ı ile aynı
dosya). Her test kendi benzersiz jid'ini kullanır ve sonunda kendi satırlarını
siler, böylece diğer testlerin verisini görmez.
"""
import json
import uuid as _uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy import text, func, select

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.main import gateway_websocket_endpoint, ws_manager
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services import whatsapp_service
from backend.app.services.whatsapp_service import ingest_gateway_event, jid_to_phone

TEST_USER = "12345678-1234-1234-1234-123456789012"
OTHER_USER = "87654321-4321-4321-4321-210987654321"
TEST_GATEWAY_SECRET = "a" * 32

# Mesaj kimlikleri bu önekle başlar; temizlik yalnızca bu testin satırlarına
# dokunur. Benzersizlik jid'den gelir (aşağıdaki `_new_identity`).
_PREFIX = "asama52"


def _new_identity() -> str:
    """Benzersiz bir telefon numarası döndürür (+90XXXXXXXXXX)."""
    n = _uuid.uuid4().int % 10 ** 10
    return f"+90{n:010d}"


def _jid_for(phone: str) -> str:
    return f"{phone.lstrip('+')}@s.whatsapp.net"


async def _make_session(user_id: str = TEST_USER, label: str = "A52") -> str:
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=user_id,
            gateway_id=gw_id,
            session_name=f"{label}-{gw_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        ))
        await db.commit()
    return gw_id


def _event(
    gw_id: str,
    jid: str,
    wa_id: str,
    *,
    body: str = "Merhaba",
    direction: str = "INBOUND",
    created_at: str = "2025-01-15T10:00:00Z",
    upsert_type=None,
    **msg_extra,
):
    message = {
        "body": body,
        "direction": direction,
        "message_type": "TEXT",
        "wa_message_id": wa_id,
        "created_at": created_at,
    }
    message.update(msg_extra)
    event = {
        "event": "message_new",
        "gateway_session_id": gw_id,
        "conversation_id": jid,
        "message": message,
    }
    if upsert_type is not None:
        event["upsert_type"] = upsert_type
    return event


async def _purge(jid: str, gw_id: str) -> None:
    """Bu testin yazdığı satırları siler. Başka tenant'a dokunmaz."""
    async with AsyncSessionLocal() as db:
        conv_ids = (await db.execute(
            text(
                "SELECT id FROM conversations WHERE contact_id IN "
                "(SELECT id FROM contacts WHERE phone_e164 = :p)"
            ),
            {"p": jid_to_phone(jid)},
        )).scalars().all()
        for cid in conv_ids:
            await db.execute(text("DELETE FROM messages WHERE conversation_id = :c"), {"c": cid})
            await db.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        await db.execute(
            text("DELETE FROM contacts WHERE phone_e164 = :p"), {"p": jid_to_phone(jid)}
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE gateway_id = :g"), {"g": gw_id}
        )
        await db.commit()


async def _conversation_row(conv_id: int):
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            text(
                "SELECT unread_count, last_message_preview, last_message_at "
                "FROM conversations WHERE id = :i"
            ),
            {"i": conv_id},
        )).first()


async def _message_count(wa_id: str) -> int:
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(func.count()).select_from(Message).where(Message.wa_message_id == wa_id)
        )).scalar_one()


async def _message_row(wa_id: str):
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(Message).where(Message.wa_message_id == wa_id)
        )).scalar_one_or_none()


# ---------------------------------------------------------------------------
# 1-3. Temel notify / append ayrımı
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_notify_is_persisted_and_broadcastable():
    """`notify` mevcut davranışını korur: yazılır ve yayınlanabilir kalır."""
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-notify-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(gw_id, jid, wa_id))
        assert isinstance(result, dict), "notify persist edilmeli"
        assert result.get("_no_broadcast") is None, "notify yayini kapatmamali"
        assert result.get("message"), "yayinlanacak mesaj govdesi olmali"
        assert await _message_count(wa_id) == 1
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_append_is_persisted():
    """`append` geçmiş mesajdır ama DB'ye YAZILIR — geçmiş görünür kalmalı."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-append-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="append"))
        assert isinstance(result, dict), "append de persist edilmeli"
        row = await _message_row(wa_id)
        assert row is not None, "append mesaji DB'de olmali"
        assert row.body == "Merhaba"
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_append_is_marked_not_to_broadcast():
    """`append` canlı yayın üretmez: sonuç `_no_broadcast` taşır."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-nb-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="append"))
        assert result.get("_no_broadcast") is True, "append yayinlanmamali"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 4. Deduplication
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_append_then_notify_does_not_duplicate():
    """Aynı mesaj önce `append` sonra `notify` gelirse TEK satır kalır."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-dup1-{_uuid.uuid4().hex[:8]}"
    try:
        first = await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="append"))
        assert first.get("_no_broadcast") is True
        second = await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="notify"))
        assert await _message_count(wa_id) == 1, "ayni wa_message_id iki satir olmamali"
        # İkinci olay ya yayınlanabilir ya da "zaten var" diye atlanır; ikisi de
        # kabul: önemli olan satırın tek kalması.
        assert second is None or second.get("_no_broadcast") is None
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_notify_then_append_does_not_duplicate():
    """Ters sıra da tek satır bırakır (sıra bağımsızlığı)."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-dup2-{_uuid.uuid4().hex[:8]}"
    try:
        await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="notify"))
        second = await ingest_gateway_event(_event(gw_id, jid, wa_id, upsert_type="append"))
        assert await _message_count(wa_id) == 1
        # Append yine de yayın üretmemeli.
        assert second is None or second.get("_no_broadcast") is True
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 5-6. Önizleme ve rozet
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_append_does_not_move_conversation_preview():
    """Geçmiş mesaj, daha yeni bir canlı mesajın önizlemesini ezemez."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    live_id = f"{_PREFIX}-live-{_uuid.uuid4().hex[:8]}"
    old_id = f"{_PREFIX}-old-{_uuid.uuid4().hex[:8]}"
    try:
        live = await ingest_gateway_event(_event(
            gw_id, jid, live_id,
            body="En yeni mesaj", created_at="2025-03-01T12:00:00Z",
            upsert_type="notify",
        ))
        conv_id = live["conversation_id"]
        before = await _conversation_row(conv_id)
        assert before is not None

        await ingest_gateway_event(_event(
            gw_id, jid, old_id,
            body="Cok eski mesaj", created_at="2025-01-01T09:00:00Z",
            upsert_type="append",
        ))
        after = await _conversation_row(conv_id)
        assert after[1] == before[1], "append onizlemeyi degistirmemeli"
        assert str(after[2]) == str(before[2]), "append son aktiviteyi geri tasimamali"
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_append_does_not_increase_unread():
    """Geçmiş mesaj rozeti artırmaz."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    live_id = f"{_PREFIX}-u-live-{_uuid.uuid4().hex[:8]}"
    old_id = f"{_PREFIX}-u-old-{_uuid.uuid4().hex[:8]}"
    try:
        live = await ingest_gateway_event(_event(
            gw_id, jid, live_id, body="Canli", created_at="2025-03-01T12:00:00Z",
        ))
        conv_id = live["conversation_id"]
        before = (await _conversation_row(conv_id))[0]

        await ingest_gateway_event(_event(
            gw_id, jid, old_id, body="Gecmis", created_at="2025-01-01T09:00:00Z",
            upsert_type="append",
        ))
        after = (await _conversation_row(conv_id))[0]
        assert after == before, f"append rozeti artirmamali ({before} -> {after})"
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_append_without_timestamp_does_not_touch_preview():
    """Zaman damgası olmayan append 'şimdi' sayılmamalı (geçmişi en üste taşımaz)."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    live_id = f"{_PREFIX}-ts-live-{_uuid.uuid4().hex[:8]}"
    old_id = f"{_PREFIX}-ts-old-{_uuid.uuid4().hex[:8]}"
    try:
        live = await ingest_gateway_event(_event(
            gw_id, jid, live_id, body="Canli", created_at="2025-03-01T12:00:00Z",
        ))
        conv_id = live["conversation_id"]
        before = await _conversation_row(conv_id)

        evt = _event(gw_id, jid, old_id, body="Zamansiz gecmis", upsert_type="append")
        evt["message"].pop("created_at", None)
        await ingest_gateway_event(evt)

        after = await _conversation_row(conv_id)
        assert after[1] == before[1], "zamansiz append onizlemeyi ezmemeli"
        assert str(after[2]) == str(before[2])
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 7-9. Diğer mesaj türleri etkilenmemeli
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_outbound_notify_behaviour_unchanged():
    """OUTBOUND notify yayınlanabilir kalır ve rozeti artırmaz."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-out-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Giden", direction="OUTBOUND", upsert_type="notify",
        ))
        assert result.get("_no_broadcast") is None
        row = await _message_row(wa_id)
        assert row is not None
        assert row.direction.value == "OUTBOUND"
        conv = await _conversation_row(result["conversation_id"])
        assert (conv[0] or 0) == 0, "outbound rozeti artirmamali"
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_group_message_behaviour_unchanged():
    """Grup jid'i notify yolundan normal işlenir."""
    gw_id = await _make_session()
    group_jid = f"12036{_uuid.uuid4().int % 10**13}@g.us"
    wa_id = f"{_PREFIX}-grp-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(
            gw_id, group_jid, wa_id, body="Grup mesaji", upsert_type="notify",
        ))
        assert isinstance(result, dict)
        assert result.get("is_group") is True
        assert result.get("_no_broadcast") is None
        assert await _message_count(wa_id) == 1
    finally:
        async with AsyncSessionLocal() as db:
            conv_ids = (await db.execute(
                text("SELECT id FROM conversations WHERE contact_id IN "
                     "(SELECT id FROM contacts WHERE phone_e164 = :p)"),
                {"p": jid_to_phone(group_jid)},
            )).scalars().all()
            for cid in conv_ids:
                await db.execute(text("DELETE FROM messages WHERE conversation_id = :c"), {"c": cid})
                await db.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
            await db.execute(text("DELETE FROM contacts WHERE phone_e164 = :p"),
                             {"p": jid_to_phone(group_jid)})
            await db.execute(text("DELETE FROM whatsapp_sessions WHERE gateway_id = :g"), {"g": gw_id})
            await db.commit()


@pytest.mark.asyncio
async def test_reaction_event_is_unaffected():
    """`message_reaction` ayrı bir olaydır; `_no_broadcast` taşımaz."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-react-{_uuid.uuid4().hex[:8]}"
    try:
        await ingest_gateway_event(_event(gw_id, jid, wa_id, body="Tepki hedefi"))
        result = await ingest_gateway_event({
            "event": "message_reaction",
            "gateway_session_id": gw_id,
            "conversation_id": jid,
            "message_id": wa_id,
            "emoji": "\U0001F44D",
            "from_me": False,
            "sender_name": "Test",
        })
        # Reaksiyon yolu append'ten etkilenmemeli: ya işlenir ya atlanır, ama
        # asla `_no_broadcast` ile susturulmaz (o yalnızca append'e özgüdür).
        assert result is None or result.get("_no_broadcast") is None
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 10-13. Bozuk payload, bilinmeyen type, ACK semantiği, tenant izolasyonu
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_malformed_payload_is_skipped_safely():
    """Geçersiz jid güvenle atlanır — exception değil, `_skip`."""
    gw_id = await _make_session()
    try:
        result = await ingest_gateway_event({
            "event": "message_new",
            "gateway_session_id": gw_id,
            "conversation_id": "bozuk-jid",
            "message": {"body": "x", "wa_message_id": "broken", "direction": "INBOUND"},
            "upsert_type": "append",
        })
        assert result is None, "gecersiz jid atlanmali (None)"
    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(text("DELETE FROM whatsapp_sessions WHERE gateway_id = :g"), {"g": gw_id})
            await db.commit()


@pytest.mark.asyncio
async def test_unknown_upsert_type_falls_back_to_notify():
    """Bilinmeyen type sessizce yutulmaz; notify gibi işlenir ve yayın kapanmaz."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-unk-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Bilinmeyen", upsert_type="weird_future_type",
        ))
        assert isinstance(result, dict)
        assert result.get("_no_broadcast") is None, "bilinmeyen type append sayilmamali"
        assert await _message_count(wa_id) == 1
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_skip_semantics_preserved_for_broadcast_jid():
    """Broadcast-only jid hâlâ atlanır (append değişikliği bu yolu bozmadı)."""
    gw_id = await _make_session()
    try:
        result = await ingest_gateway_event({
            "event": "message_new",
            "gateway_session_id": gw_id,
            "conversation_id": "status@broadcast",
            "message": {
                "body": "durum", "wa_message_id": f"{_PREFIX}-bcast",
                "direction": "INBOUND", "created_at": "2025-01-15T10:00:00Z",
            },
            "upsert_type": "notify",
        })
        assert result is None
    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(text("DELETE FROM whatsapp_sessions WHERE gateway_id = :g"), {"g": gw_id})
            await db.commit()


@pytest.mark.asyncio
async def test_tenant_isolation_preserved():
    """Event, oturumun sahibine yazılır; başka tenant'a sızmaz."""
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_a = await _make_session(TEST_USER, "A52A")
    gw_b = await _make_session(OTHER_USER, "A52B")
    wa_a = f"{_PREFIX}-ten-a-{_uuid.uuid4().hex[:8]}"
    wa_b = f"{_PREFIX}-ten-b-{_uuid.uuid4().hex[:8]}"
    try:
        res_a = await ingest_gateway_event(_event(gw_a, jid, wa_a, upsert_type="notify"))
        res_b = await ingest_gateway_event(_event(gw_b, jid, wa_b, upsert_type="append"))
        assert res_a["user_id"] == TEST_USER
        assert res_b["user_id"] == OTHER_USER
        async with AsyncSessionLocal() as db:
            owners = (await db.execute(
                text("SELECT DISTINCT user_id FROM conversations WHERE id IN (:a, :b)"),
                {"a": res_a["conversation_id"], "b": res_b["conversation_id"]},
            )).scalars().all()
        # DB `user_id`'yi UUID'nin tiresiz hex haliyle tutar; olay ise tireli
        # UUID dondurur. Karsilastirma bu yuzden normalizes edilir.
        assert {str(o).replace("-", "") for o in owners} == {
            TEST_USER.replace("-", ""), OTHER_USER.replace("-", "")
        }, "iki tenant ayri sohbetlerde kalmali"
    finally:
        await _purge(jid, gw_a)
        await _purge(jid, gw_b)


# ---------------------------------------------------------------------------
# 14. Köprü katmanı: `_no_broadcast` gerçekten uygulanıyor mu?
# ---------------------------------------------------------------------------

class _FakeGatewaySocket:
    def __init__(self, event: dict) -> None:
        self._messages = [json.dumps(event)]
        self.sent: list[dict] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000) -> None:
        pass

    async def receive_text(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.fixture(autouse=True)
def _configure_gateway_secret(monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", TEST_GATEWAY_SECRET)


@pytest.mark.asyncio
async def test_bridge_acks_append_without_broadcast(monkeypatch) -> None:
    """`_no_broadcast` taşıyan olay ACK edilir ama yayınlanmaz."""
    event_id = str(_uuid.uuid4())
    socket = _FakeGatewaySocket({"event": "message_new", "event_id": event_id})
    monkeypatch.setattr(
        whatsapp_service,
        "ingest_gateway_event",
        AsyncMock(return_value={
            "event": "message_new",
            "user_id": "owner",
            "message": {"id": 1},
            "_no_broadcast": True,
        }),
    )
    broadcast = AsyncMock()
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=TEST_GATEWAY_SECRET)

    broadcast.assert_not_awaited()
    assert socket.sent == [{"type": "gateway_event_ack", "event_id": event_id}]


@pytest.mark.asyncio
async def test_bridge_still_broadcasts_notify(monkeypatch) -> None:
    """`_no_broadcast` yoksa mevcut davranış korunur: yayın + ACK."""
    event_id = str(_uuid.uuid4())
    socket = _FakeGatewaySocket({"event": "message_new", "event_id": event_id})
    monkeypatch.setattr(
        whatsapp_service,
        "ingest_gateway_event",
        AsyncMock(return_value={
            "event": "message_new",
            "user_id": "owner",
            "message": {"id": 2},
        }),
    )
    broadcast = AsyncMock()
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=TEST_GATEWAY_SECRET)

    broadcast.assert_awaited_once()
    assert socket.sent == [{"type": "gateway_event_ack", "event_id": event_id}]
