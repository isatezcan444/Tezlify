"""Tenant izolasyonu ve fail-closed regresyon testleri (Faz 13).

Bu dosya, tam-sistem code review'unda tespit edilen ve DUZELTILEN su
sinif hatalarin bir daha sizmasini engeller:

1. `ws_manager.broadcast` hedef `user_id` yokken TUM tenant'lara yayin
   yapiyordu (mesaj/telefon/lead sizintisi).
2. `_resolve_event_owner` sahibi cozemezse rastgele/SYSTEM tenant'a
   yaziyordu; iki oturum varsa `MultipleResultsFound` yutuluyordu.
3. Gateway olaylari hicbir tenant'a baglanamiyorsa bile UI'a yayinlaniyordu
   (DB'de olmayan veri gosteriliyordu).
4. Dejenere JID olaylari sessizce "sahipsiz" gibi loglaniyordu (neden
   belirsiz) — artik acik `_skip` nedeniyle ayrilir.
5. `_apply_last_message` eski zaman damgali mesajla yeni ozeti eziyordu.
"""
import asyncio
import uuid as _uuid
from typing import Any, Dict, List

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.api.v1.websocket import ws_manager
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws


# --- Tenant kimlikleri (her test dosyasi kendi UUID'sini kullanir) ---------
U1 = "11111111-1111-1111-1111-111111111111"
U2 = "22222222-2222-2222-2222-222222222222"
U1_HEX = U1.replace("-", "")
U2_HEX = U2.replace("-", "")
U3 = "33333333-3333-3333-3333-333333333333"
U3_HEX = U3.replace("-", "")

ALL_HEX = [U1_HEX, U2_HEX, U3_HEX]

# Dejenere JID: `is_degenerate_jid` bunu gercek kisi saymaz (5'ten az hane).
DEGENERATE_JID = "0@s.whatsapp.net"
REAL_JID = "905321004040@s.whatsapp.net"


class _FakeWS:
    """`ws_manager` icin asgari WebSocket sahtesi — yalnizca kaydeder."""

    def __init__(self) -> None:
        self.sent: List[str] = []

    async def accept(self) -> None:  # pragma: no cover - davranis onemsiz
        return None

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)


@pytest_asyncio.fixture(autouse=True)
async def _clean_tenant_state():
    """Bu dosyanin kullandigi tenant satirlarini ve WS kayitlarini temizle."""
    async def _wipe():
        async with AsyncSessionLocal() as db:
            for table in ("messages", "conversations", "contacts", "whatsapp_sessions"):
                await db.execute(
                    text(f"DELETE FROM {table} WHERE user_id IN (:a, :b, :c)"),
                    {"a": U1_HEX, "b": U2_HEX, "c": U3_HEX},
                )
            await db.commit()

    # WS singleton'i de sifirla: aksi halde soketler testler arasi tasinir.
    for sock in list(ws_manager.active_connections):
        ws_manager.disconnect(sock)
    ws_manager.active_connections.clear()
    ws_manager.user_connections.clear()
    ws_manager.socket_user_map.clear()

    await _wipe()
    yield
    await _wipe()
    for sock in list(ws_manager.active_connections):
        ws_manager.disconnect(sock)
    ws_manager.user_connections.clear()
    ws_manager.socket_user_map.clear()


async def _add_session(user_id: str, status: SessionStatus = SessionStatus.CONNECTED) -> str:
    gw_id = f"gw-{_uuid.uuid4().hex}"
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=user_id, gateway_id=gw_id, session_name=f"s-{gw_id[:8]}",
            status=status, is_active=True,
        ))
        await db.commit()
    return gw_id


# ===========================================================================
# 1) ws_manager.broadcast — fail-closed ve hedefe ozel yonlendirme
# ===========================================================================

@pytest.mark.asyncio
async def test_broadcast_without_target_user_is_rejected():
    """Hedef `user_id` yoksa HICBIR sokete yayin yapilmaz (genis yayin YOK)."""
    ws_a, ws_b = _FakeWS(), _FakeWS()
    await ws_manager.connect(ws_a, user_id=U1)
    await ws_manager.connect(ws_b, user_id=U2)

    sent = await ws_manager.broadcast({"event": "message_new", "body": "gizli"})

    assert sent == 0
    assert ws_a.sent == [] and ws_b.sent == [], "hedefsiz olay tenant'lara sizmamali"


@pytest.mark.asyncio
async def test_broadcast_targets_only_owner():
    """Yayin YALNIZCA hedef tenant'in soketine gider."""
    ws_a, ws_b = _FakeWS(), _FakeWS()
    await ws_manager.connect(ws_a, user_id=U1)
    await ws_manager.connect(ws_b, user_id=U2)

    sent = await ws_manager.broadcast({"event": "message_new", "user_id": U1})

    assert sent == 1
    assert len(ws_a.sent) == 1
    assert ws_b.sent == [], "diger tenant olayi GORMEMELI"


@pytest.mark.asyncio
async def test_explicit_target_overrides_payload_user_id():
    """Acik hedef, payload'daki `user_id`'yi EZER (payload'a guvenilmez)."""
    ws_a, ws_b = _FakeWS(), _FakeWS()
    await ws_manager.connect(ws_a, user_id=U1)
    await ws_manager.connect(ws_b, user_id=U2)

    # Payload U2 diyor ama cagiran U1'i hedefliyor → U1 kazanir.
    sent = await ws_manager.broadcast({"event": "x", "user_id": U2}, target_user_id=U1)

    assert sent == 1
    assert len(ws_a.sent) == 1
    assert ws_b.sent == []


@pytest.mark.asyncio
async def test_broadcast_drops_dead_socket():
    """Gonderim patlayan soket kayitli kalirsa tekrar denenmez (temizlenir)."""
    class _BoomWS(_FakeWS):
        async def send_text(self, payload: str) -> None:
            raise RuntimeError("socket kapandi")

    bad = _BoomWS()
    await ws_manager.connect(bad, user_id=U1)

    assert await ws_manager.broadcast({"event": "x", "user_id": U1}) == 0
    assert U1 not in ws_manager.user_connections or bad not in ws_manager.user_connections.get(U1, set())


# ===========================================================================
# 2) _resolve_event_owner — kesin sahiplik, tahmin yok
# ===========================================================================

@pytest.mark.asyncio
async def test_owner_resolved_via_gateway_session_id():
    """`gateway_session_id` verilirse sahip KESIN olarak o oturumdan cozulur."""
    gw_id = await _add_session(U1)
    async with AsyncSessionLocal() as db:
        owner = await ws._resolve_event_owner(db, REAL_JID, gw_id)
    assert str(owner).replace("-", "") == U1_HEX


@pytest.mark.asyncio
async def test_owner_unknown_gateway_session_id_raises():
    """Bilinmeyen gateway oturumu → tahmin YOK, fail-closed hata."""
    await _add_session(U1)
    async with AsyncSessionLocal() as db:
        with pytest.raises(ws.EventOwnerUnresolved):
            await ws._resolve_event_owner(db, REAL_JID, "gw-yok-boyle-bir-sey")


@pytest.mark.asyncio
async def test_owner_single_connected_session_is_unambiguous():
    """session_id yoksa ve TEK bagli oturum varsa sahip belirsiz degildir."""
    await _add_session(U1)
    async with AsyncSessionLocal() as db:
        owner = await ws._resolve_event_owner(db, REAL_JID, None)
    assert str(owner).replace("-", "") == U1_HEX


@pytest.mark.asyncio
async def test_owner_ambiguous_multiple_sessions_raises():
    """session_id yoksa ve BIRDEN FAZLA bagli oturum varsa olay reddedilir."""
    await _add_session(U1)
    await _add_session(U2)
    async with AsyncSessionLocal() as db:
        with pytest.raises(ws.EventOwnerUnresolved):
            await ws._resolve_event_owner(db, REAL_JID, None)


@pytest.mark.asyncio
async def test_owner_no_connected_session_raises():
    """Hic bagli oturum yoksa olay SYSTEM tenant'a YAZILMAZ (fail-closed)."""
    async with AsyncSessionLocal() as db:
        with pytest.raises(ws.EventOwnerUnresolved):
            await ws._resolve_event_owner(db, REAL_JID, None)


# ===========================================================================
# 3) ingest_gateway_event — yayin siniri
# ===========================================================================

@pytest.mark.asyncio
async def test_unknown_event_is_not_published():
    assert await ws.ingest_gateway_event({"event": "kesinlikle_yok_boyle_olay"}) is None


@pytest.mark.asyncio
async def test_message_event_without_owner_is_not_published():
    """Iki bagli oturum + session_id yok → olay UI'a CIKMAZ."""
    await _add_session(U1)
    await _add_session(U2)
    result = await ws.ingest_gateway_event({
        "event": "message_new",
        "conversation_id": REAL_JID,
        "message": {"body": "selam", "direction": "INBOUND", "message_type": "TEXT"},
    })
    assert result is None


@pytest.mark.asyncio
async def test_degenerate_jid_is_marked_skip_not_silently_dropped():
    """Dejenere JID: sessiz yutma DEGIL — acik `_skip` nedeniyle ayrilir."""
    await _add_session(U1)
    raw: Dict[str, Any] = {
        "event": "message_new",
        "conversation_id": DEGENERATE_JID,
        "message": {"body": "0", "direction": "INBOUND", "message_type": "TEXT"},
    }
    # Helper'in kendisi nedeni isaretler...
    async with AsyncSessionLocal() as db:
        marked = await ws._ingest_message(db, dict(raw))
    assert marked.get("_skip"), "dejenere JID nedeniyle isaretlenmeli"
    # ...ve sinirda yayinlanmaz.
    assert await ws.ingest_gateway_event(raw) is None


@pytest.mark.asyncio
async def test_message_event_attaches_resolved_owner():
    """Basarili ingest, cozulen sahibi olaya YAZAR (yayin siniri bunu ister)."""
    await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "message_new",
        "conversation_id": REAL_JID,
        "message": {
            "body": "merhaba", "direction": "INBOUND", "message_type": "TEXT",
            "wa_message_id": "wamid-tenant-1", "sender_name": "Kisi",
            "created_at": "2025-03-01T10:00:00Z",
        },
    })
    assert result is not None, "gercek mesaj yayinlanmali"
    assert str(result["user_id"]).replace("-", "") == U1_HEX
    assert result["conversation_id"] is not None


@pytest.mark.asyncio
async def test_conversation_event_attaches_resolved_owner():
    """conversation_updated de sahibini tasimali (aksi halde UI'a cikamaz)."""
    await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": REAL_JID,
        "conversation": {"id": REAL_JID, "name": "Kisi", "last_message_preview": "selam"},
    })
    assert result is not None
    assert str(result["user_id"]).replace("-", "") == U1_HEX


# ===========================================================================
# 3b) Passthrough olaylar — kalici yazilmaz ama UI'a ULASIR
# ===========================================================================
# Render log regresyonu: `history_sync_completed` "bilinmeyen olay" dalina
# dusup ERROR loglaniyor ve YAYINLANMIYORDU. Oysa gateway onu gecmis senkronu
# bitince uretir (session-manager.js) ve frontend sohbet listesini tazelemek
# icin tuketir (WhatsAppHubPage.tsx). Bu testler olayin geri donmesini engeller.

@pytest.mark.asyncio
async def test_history_sync_completed_is_published_with_owner():
    """`history_sync_completed` bilinmeyen olay DEGIL — sahibiyle yayinlanir."""
    gw_id = await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "history_sync_completed",
        "gateway_session_id": gw_id,
        "progress": 100,
        "is_latest": True,
        "chats_synced": 3,
        "messages_synced": 42,
    })
    assert result is not None, "history_sync_completed UI'a ulasmali (regresyon)"
    assert str(result["user_id"]).replace("-", "") == U1_HEX


@pytest.mark.asyncio
async def test_history_sync_completed_without_gateway_session_is_not_published():
    """`gateway_session_id` yoksa sahip KESIN cozulemez → yayinlanmaz."""
    await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "history_sync_completed",
        "progress": 100,
    })
    assert result is None, "sahipsiz passthrough olay yayinlanmamali"


@pytest.mark.asyncio
async def test_history_sync_completed_unknown_session_is_not_published():
    """Bilinmeyen gateway oturumu → tahmin yok, fail-closed."""
    await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "history_sync_completed",
        "gateway_session_id": "gw-boyle-bir-oturum-yok",
        "progress": 100,
    })
    assert result is None


@pytest.mark.asyncio
async def test_passthrough_allowlist_contains_only_known_events():
    """Allowlist dar tutulur — yeni olay sessizce gecmemeli."""
    assert ws._PASSTHROUGH_EVENTS == frozenset({"history_sync_completed"})


@pytest.mark.asyncio
async def test_genuinely_unknown_event_still_rejected():
    """Allowlist disindaki olay yine fail-closed (sozlesme kaymasi gorunur)."""
    gw_id = await _add_session(U1)
    assert await ws.ingest_gateway_event({
        "event": "hic_olmayan_bir_olay",
        "gateway_session_id": gw_id,
    }) is None


# ===========================================================================
# 3c) Broadcast-only JID filtreleri (Durum / kanal sohbet listesine karismaz)
# ===========================================================================
# Prod geri bildirim: WhatsApp Durum/Hikaye (`status@broadcast`) ve kanal
# (`@newsletter`) mesajlari sohbet listesinde gorunuyordu. WhatsApp Web
# paritesi: bu JID'ler sohbet listesinde YER ALMAZ — backend'de
# contact/conversation/mesaj HIC uretilmez.

BROADCAST_JID = "status@broadcast"
NEWSLETTER_JID = "120363123456789012@newsletter"


def test_broadcast_only_jid_helper():
    """Helper dogru JID'leri tanimli; normal JID'leri es gecer."""
    assert ws.is_broadcast_only_jid(BROADCAST_JID) is True
    assert ws.is_broadcast_only_jid(NEWSLETTER_JID) is True
    assert ws.is_broadcast_only_jid(REAL_JID) is False
    assert ws.is_broadcast_only_jid("120363@g.us") is False
    assert ws.is_broadcast_only_jid(None) is False
    assert ws.is_broadcast_only_jid("") is False


@pytest.mark.asyncio
async def test_status_broadcast_message_is_not_persisted():
    """`status@broadcast` mesaji contact/conversation/message OLUSTURMAZ."""
    gw_id = await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "message_new",
        "conversation_id": BROADCAST_JID,
        "gateway_session_id": gw_id,
        "message": {
            "body": "durum guncellemesi", "direction": "INBOUND", "message_type": "TEXT",
            "wa_message_id": "wamid-status-1",
        },
    })
    assert result is None, "status@broadcast mesaji yayinlanmamali"
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            text("SELECT COUNT(*) FROM conversations WHERE user_id = :u"),
            {"u": U1_HEX},
        )).scalar()
    assert rows == 0, "status@broadcast icin conversation olusturulmamali"


@pytest.mark.asyncio
async def test_newsletter_message_is_not_persisted():
    """`@newsletter` (kanal) mesaji sohbet listesine dusmez."""
    gw_id = await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "message_new",
        "conversation_id": NEWSLETTER_JID,
        "gateway_session_id": gw_id,
        "message": {
            "body": "kanal paylasimi", "direction": "INBOUND", "message_type": "TEXT",
            "wa_message_id": "wamid-news-1",
        },
    })
    assert result is None


@pytest.mark.asyncio
async def test_status_broadcast_conversation_event_is_skipped():
    """conversation_updated bile olsa broadcast JID DB'ye yazilmaz."""
    gw_id = await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": BROADCAST_JID,
        "gateway_session_id": gw_id,
        "conversation": {"id": BROADCAST_JID, "name": "Durum", "last_message_preview": "x"},
    })
    assert result is None


@pytest.mark.asyncio
async def test_status_broadcast_contact_is_not_created():
    """`status@broadcast` icin contact satiri olusmaz."""
    gw_id = await _add_session(U1)
    result = await ws.ingest_gateway_event({
        "event": "contact_synced",
        "gateway_session_id": gw_id,
        "contact": {"id": BROADCAST_JID, "name": "Durum"},
    })
    assert result is None
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            text("SELECT COUNT(*) FROM contacts WHERE user_id = :u AND phone_e164 LIKE '%broadcast%'"),
            {"u": U1_HEX},
        )).scalar()
    assert rows == 0


@pytest.mark.asyncio
async def test_existing_broadcast_junk_is_excluded_from_listing():
    """Eski kirli satirlar (varsa) list_conversations sonucunda GORUNMEZ."""
    from backend.app.models.contact import Contact
    await _add_session(U1)
    # Eski kaydi dogrudan DB'ye yaz (ingest filtrelerini atlayarak) — prod'daki
    # mevcut kirli durumu simule eder.
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=U1_HEX, phone_e164="jid:status@broadcast", display_name="Durum")
        db.add(contact)
        await db.flush()
        db.add(Conversation(
            user_id=U1_HEX, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        ))
        await db.commit()
    async with AsyncSessionLocal() as db:
        convs, total = await ws.list_conversations(db, U1)
    assert total == 0, "broadcast-only sohbet listede gorunmemeli"
    assert convs == []


# ===========================================================================
# 4) _apply_last_message — zaman damgasi korumasi
# ===========================================================================

def _conv() -> Conversation:
    return Conversation(
        user_id=U1, channel="WHATSAPP", status=ConversationStatus.ACTIVE,
        unread_count=0, last_message_preview="YENI", last_message_at=None,
    )


def test_apply_last_message_ignores_older_timestamp():
    """Gecmis (retry/duplicate) mesaj, daha yeni ozeti EZMEZ."""
    from datetime import datetime

    conv = _conv()
    newer = datetime(2025, 3, 1, 12, 0, 0)
    older = datetime(2025, 3, 1, 10, 0, 0)

    assert ws._apply_last_message(conv, newer, "YENI MESAJ") is True
    assert conv.last_message_preview == "YENI MESAJ"

    assert ws._apply_last_message(conv, older, "ESKI MESAJ") is False
    assert conv.last_message_preview == "YENI MESAJ", "eski mesaj yeni ozeti bozmamali"
    assert conv.last_message_at == newer


def test_apply_last_message_empty_summary_is_noop():
    from datetime import datetime

    conv = _conv()
    ws._apply_last_message(conv, datetime(2025, 3, 1, 12, 0, 0), "DOLU")
    assert ws._apply_last_message(conv, datetime(2025, 3, 2, 12, 0, 0), "") is False
    assert conv.last_message_preview == "DOLU"


def test_apply_last_message_newer_timestamp_wins():
    from datetime import datetime

    conv = _conv()
    ws._apply_last_message(conv, datetime(2025, 3, 1, 10, 0, 0), "ILK")
    assert ws._apply_last_message(conv, datetime(2025, 3, 1, 11, 0, 0), "IKINCI") is True
    assert conv.last_message_preview == "IKINCI"
