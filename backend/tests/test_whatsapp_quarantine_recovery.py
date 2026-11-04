"""Automated tests for AŞAMA 7.1 — WhatsApp Identity Quarantine Kurtarma ve Veri Güvenliği.

Verifies the 10 core safety scenarios:
1. Eşleşmesi bulunmayan LID mesajı karantinada kalır.
2. Sonradan öğrenilen LID → PN eşleşmesi karantinadaki mesajı başarıyla kurtarır.
3. Yanlış session eşleşmesi durumunda kurtarma yapılmaz, kayıt korunur.
4. Tenant izolasyonu: Başka kullanıcıya ait oturum veya LID karantinayı çözemez.
5. Çoklu olası PN eşleşmesinde (belirsizlik durumunda) kurtarma yapılmaz.
6. Kurtarma işlemi idempotenttir; ikinci kez çalıştığında duplicate oluşturmaz.
7. Kurtarma esnasında hata oluşursa transaction rollback olur, veri kaybolmaz.
8. Yeniden başlatma sonrasında kurtarılmamış kayıtlar sistem tarafından tekrar taranabilir.
9. Mesaj timestamp, yön (inbound/outbound) ve içerikleri bozulmadan korunur.
10. Daha önce çözülmüş veya serbest bırakılmış kayıtlar yeniden işlenmez.
"""

import json
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.core.migrations import (
    ensure_whatsapp_identity_quarantine_table,
    purge_raw_jid_identity_data,
    quarantine_counts,
)
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_identity_quarantine import WhatsAppIdentityQuarantine
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.reconciliation import (
    candidate_quarantine_recovery_pairs,
    recover_quarantined_identities,
    recover_quarantined_record,
    resolve_quarantine_row,
    run_identity_sweep_once,
)

USER_A = "aaaa1111-2222-3333-4444-555566667777"
USER_A_HEX = USER_A.replace("-", "")
USER_B = "bbbb1111-2222-3333-4444-555566667777"
USER_B_HEX = USER_B.replace("-", "")

GW_A1 = "gw-quarantine-session-a1"
GW_A2 = "gw-quarantine-session-a2"
GW_B1 = "gw-quarantine-session-b1"

LID_A = "218107046027315@lid"
PHONE_A = "+905321110001"
PHONE_JID_A = "905321110001@s.whatsapp.net"
PHONE_JID_ALT = "905329998877@s.whatsapp.net"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    await ensure_whatsapp_identity_quarantine_table(engine)

    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS lid_mappings (
                        session_id TEXT NOT NULL,
                        lid_jid VARCHAR(100) NOT NULL,
                        phone_jid VARCHAR(100) NOT NULL DEFAULT '',
                        created_at TIMESTAMP,
                        PRIMARY KEY (session_id, lid_jid)
                    )
                    """
                )
            )
            await db.execute(text("DELETE FROM lid_mappings"))
            await db.execute(text("DELETE FROM whatsapp_identity_quarantine"))
            for u in (USER_A_HEX, USER_B_HEX):
                await db.execute(text("DELETE FROM messages WHERE user_id = :u"), {"u": u})
                await db.execute(
                    text("DELETE FROM conversations WHERE user_id = :u"), {"u": u}
                )
                await db.execute(text("DELETE FROM contacts WHERE user_id = :u"), {"u": u})
                await db.execute(
                    text("DELETE FROM whatsapp_sessions WHERE user_id = :u"), {"u": u}
                )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


async def _seed_quarantine_fixture(
    *,
    user_id_hex: str = USER_A_HEX,
    gateway_id: str = GW_A1,
    lid_jid: str = LID_A,
    num_messages: int = 9,
    status: str = "QUARANTINED",
    reason: str = "bridge_unknown_has_messages",
):
    """Production Seyma Aden anomalisine birebir eşdeğer veri seti oluşturur."""
    async with AsyncSessionLocal() as db:
        ws = WhatsAppSession(
            user_id=user_id_hex,
            phone_number="+905413749073",
            session_name="Hat 1",
            status=SessionStatus.CONNECTED,
            gateway_id=gateway_id,
        )
        db.add(ws)
        await db.flush()

        contact = Contact(
            user_id=user_id_hex,
            phone_e164=f"jid:{lid_jid}",
            display_name="Seyma Aden",
            custom_attributes={"name_source": "addressbook"},
        )
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=user_id_hex,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            session_id=ws.id,
            is_group=False,
            is_archived=False,
            last_message_preview="Test mesajı",
        )
        db.add(conv)
        await db.flush()

        msgs = []
        base_time = utc_now_naive() - timedelta(hours=2)
        for i in range(num_messages):
            direction = (
                MessageDirection.OUTBOUND if i == num_messages - 1 else MessageDirection.INBOUND
            )
            sender_phone = "ME" if direction == MessageDirection.OUTBOUND else lid_jid
            msg_status = (
                ConversationMessageStatus.SENT
                if direction == MessageDirection.OUTBOUND
                else ConversationMessageStatus.RECEIVED
            )
            msg = Message(
                user_id=user_id_hex,
                conversation_id=conv.id,
                direction=direction,
                message_type=MessageType.TEXT,
                body=f"Quarantine test message {i + 1}",
                sender_phone=sender_phone,
                recipient_phone="ME" if direction == MessageDirection.INBOUND else lid_jid,
                status=msg_status,
                created_at=base_time + timedelta(minutes=i),
                external_timestamp=base_time + timedelta(minutes=i),
                wa_message_id=f"WA_MSG_Q_{i + 1}_{conv.id}",
            )
            msgs.append(msg)
            db.add(msg)
        await db.flush()

        q_entry = WhatsAppIdentityQuarantine(
            contact_id=contact.id,
            conversation_id=conv.id,
            user_id=user_id_hex,
            phone_e164=f"jid:{lid_jid}",
            reason=reason,
            status=status,
            message_count=num_messages,
            detail=json.dumps(
                {
                    "bridge_known": False,
                    "conversation_count": 1,
                    "message_count": num_messages,
                }
            ),
        )
        db.add(q_entry)
        await db.commit()
        return {
            "session_id": ws.id,
            "gateway_id": gateway_id,
            "contact_id": contact.id,
            "conversation_id": conv.id,
            "quarantine_id": q_entry.id,
            "lid_jid": lid_jid,
        }


@pytest.mark.asyncio
async def test_01_unmapped_lid_message_stays_quarantined():
    """1. Eşleşmesi bulunmayan LID mesajı karantinada kalır."""
    fixture = await _seed_quarantine_fixture()

    async with AsyncSessionLocal() as db:
        pairs = await candidate_quarantine_recovery_pairs(db, user_id=USER_A_HEX)
        assert len(pairs) == 0, "Eşleşmesi olmayan kayıt aday olmamalıdır"

        # Karantina durumu değişmemeli
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "QUARANTINED"
        assert q_row.message_count == 9

        # Mesajlar ve sohbet korunmalı
        msg_count = await db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == fixture["conversation_id"]
            )
        )
        assert msg_count == 9


@pytest.mark.asyncio
async def test_02_learned_lid_mapping_recovers_quarantined_messages():
    """2. Sonradan öğrenilen LID → PN eşleşmesi karantinadaki mesajı başarıyla kurtarır."""
    fixture = await _seed_quarantine_fixture()

    # Eşleşmeyi lid_mappings tablosuna yaz
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    # Kurtarma taraması çalıştır
    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["scanned"] == 1
    assert report["recovered"] == 1
    assert report["errors"] == 0

    async with AsyncSessionLocal() as db:
        # Karantina durumu RESOLVED olmalı
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "RESOLVED"
        detail = json.loads(q_row.detail)
        assert detail["resolved_phone_jid"] == PHONE_JID_A
        assert detail["canonical_conversation_id"] is not None
        canonical_conv_id = detail["canonical_conversation_id"]

        # Eski sohbet arşivlenmeli, silinmemeli
        old_conv = await db.get(Conversation, fixture["conversation_id"])
        assert old_conv.is_archived is True
        assert old_conv.status == ConversationStatus.ARCHIVED

        # Mesajlar kanonik sohbete taşınmış olmalı
        canon_msg_count = await db.scalar(
            select(func.count(Message.id)).where(Message.conversation_id == canonical_conv_id)
        )
        assert canon_msg_count == 9, "Tüm 9 mesaj kanonik sohbette bulunmalıdır"


@pytest.mark.asyncio
async def test_03_wrong_session_mapping_does_not_recover():
    """3. Yanlış session eşleşmesi durumunda kurtarma yapılmaz, kayıt korunur."""
    fixture = await _seed_quarantine_fixture(gateway_id=GW_A1)

    # İkinci bir oturum oluştur (GW_A2)
    async with AsyncSessionLocal() as db:
        ws2 = WhatsAppSession(
            user_id=USER_A_HEX,
            phone_number="+905419998877",
            session_name="Hat 2",
            status=SessionStatus.CONNECTED,
            gateway_id=GW_A2,
        )
        db.add(ws2)
        await db.flush()

        # Eşleşmeyi Hat 2'ye (GW_A2) kaydet — Hat 1'in sohbeti bunu kullanamaz!
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": GW_A2, "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    # Hat 1'e ait sohbet Hat 2'nin köprüsüyle kurtarılamaz (Session scoping)
    async with AsyncSessionLocal() as db:
        pairs = await candidate_quarantine_recovery_pairs(db, user_id=USER_A_HEX)
        assert len(pairs) == 0, "Farklı oturuma ait köprü aday listesine girmemeli"

    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["recovered"] == 0

    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "QUARANTINED"


@pytest.mark.asyncio
async def test_04_tenant_isolation_prevents_cross_tenant_recovery():
    """4. Tenant izolasyonu: Başka kullanıcıya ait oturum veya LID karantinayı çözemez."""
    # User A için karantina kaydı
    fixture_a = await _seed_quarantine_fixture(user_id_hex=USER_A_HEX, gateway_id=GW_A1)

    # User B için bir oturum ve aynı LID eşleştirmesi oluştur
    async with AsyncSessionLocal() as db:
        ws_b = WhatsAppSession(
            user_id=USER_B_HEX,
            phone_number="+905553332211",
            session_name="User B Hat",
            status=SessionStatus.CONNECTED,
            gateway_id=GW_B1,
        )
        db.add(ws_b)
        await db.flush()

        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": GW_B1, "l": fixture_a["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    # User A kapsamındaki tarama User B'nin eşleştirmesini kullanamaz
    async with AsyncSessionLocal() as db:
        pairs = await candidate_quarantine_recovery_pairs(db, user_id=USER_A_HEX)
        assert len(pairs) == 0, "Başka kiracının eşleştirmesiyle aday oluşturulamaz"

    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["recovered"] == 0

    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture_a["quarantine_id"])
        assert q_row.status == "QUARANTINED", "Kiracı yalıtımı karantinayı korur"


@pytest.mark.asyncio
async def test_05_ambiguous_mappings_prevent_recovery():
    """5. Çoklu olası PN eşleşmesinde (belirsizlik durumunda) kurtarma yapılmaz."""
    fixture = await _seed_quarantine_fixture()

    # Aynı LID için oturum içinde iki farklı telefon numarası kaydedilmiş olsun (anomali)
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        # İkinci bir sahte kayıt oluşturmak için composite key'e ufak varyasyon ekleyelim veya
        # conversations.session_id NULL durumunda iki farklı hat farklı numaralar dönüyorsa:
        ws_alt = WhatsAppSession(
            user_id=USER_A_HEX,
            phone_number="+905418887766",
            session_name="Hat Alternatif",
            status=SessionStatus.CONNECTED,
            gateway_id="gw-alt-session",
        )
        db.add(ws_alt)
        await db.flush()

        # Sohbette session_id'yi NULL yapalım (eski anomali) ve iki oturum farklı numaralar eşlesin
        await db.execute(
            text("UPDATE conversations SET session_id = NULL WHERE id = :cid"),
            {"cid": fixture["conversation_id"]},
        )
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": "gw-alt-session", "l": fixture["lid_jid"], "p": PHONE_JID_ALT},
        )
        await db.commit()

    async with AsyncSessionLocal() as db:
        pairs = await candidate_quarantine_recovery_pairs(db, user_id=USER_A_HEX)
        assert len(pairs) == 0, "Çoklu/belirsiz PN eşleşmesinde kurtarma reddedilmeli"

    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["recovered"] == 0

    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "QUARANTINED"


@pytest.mark.asyncio
async def test_06_recovery_is_idempotent():
    """6. Kurtarma işlemi idempotenttir; ikinci kez çalıştığında duplicate oluşturmaz."""
    fixture = await _seed_quarantine_fixture()

    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    first_report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert first_report["recovered"] == 1

    second_report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert second_report["recovered"] == 0
    assert second_report["scanned"] == 0

    async with AsyncSessionLocal() as db:
        # Mesaj sayısı duplicate olmamalı, tam 9 olmalı
        total_msgs = await db.scalar(
            select(func.count(Message.id)).where(Message.user_id == USER_A_HEX)
        )
        assert total_msgs == 9


@pytest.mark.asyncio
async def test_07_transaction_rollback_on_failure_preserves_data():
    """7. Kurtarma esnasında hata oluşursa transaction rollback olur, veri kaybolmaz."""
    fixture = await _seed_quarantine_fixture()

    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    # `merge_split_conversation` esnasında yapay bir hata fırlat
    with patch(
        "backend.app.services.whatsapp.reconciliation.merge_split_conversation",
        side_effect=RuntimeError("Simulated DB Disk Failure during merge"),
    ):
        report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
        assert report["errors"] == 1
        assert report["recovered"] == 0

    # Veri bütünlüğünü doğrula: Rollback gerçekleşti mi?
    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "QUARANTINED", "Hata anında durum QUARANTINED kalmalı"

        # Mesajlar hâlâ orijinal sohbette ve tam sayıda mı?
        msg_count = await db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == fixture["conversation_id"]
            )
        )
        assert msg_count == 9, "Hiçbir mesaj silinmemeli veya kaybolmamalı"


@pytest.mark.asyncio
async def test_08_restart_recovery_scans_and_recovers():
    """8. Yeniden başlatma sonrasında kurtarılmamış kayıtlar sistem tarafından tekrar taranabilir."""
    fixture = await _seed_quarantine_fixture()

    # Gateway eşleşmeyi kaydetti
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    # Startup simülasyonu: purge + deferred merge + quarantine recovery + sweep
    await purge_raw_jid_identity_data(engine)
    sweep_result = await run_identity_sweep_once(engine, limit=10)

    assert sweep_result["quarantine"]["recovered"] == 1
    assert sweep_result["quarantine"]["errors"] == 0

    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "RESOLVED"


@pytest.mark.asyncio
async def test_09_message_timestamps_direction_and_content_preserved():
    """9. Mesaj timestamp, yön (inbound/outbound) ve içerikleri bozulmadan korunur."""
    fixture = await _seed_quarantine_fixture()

    # Önceden orijinal mesajların detaylarını kaydet
    async with AsyncSessionLocal() as db:
        orig_msgs = (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == fixture["conversation_id"])
                .order_by(Message.id.asc())
            )
        ).scalars().all()
        orig_data = [
            (
                m.body,
                m.direction,
                m.wa_message_id,
                m.created_at,
                m.external_timestamp,
            )
            for m in orig_msgs
        ]

    # Eşleşmeyi ekle ve kurtar
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
            ),
            {"s": fixture["gateway_id"], "l": fixture["lid_jid"], "p": PHONE_JID_A},
        )
        await db.commit()

    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["recovered"] == 1

    # Kanonik sohbetteki mesajları oku ve karşılaştır
    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        detail = json.loads(q_row.detail)
        canonical_conv_id = detail["canonical_conversation_id"]

        moved_msgs = (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == canonical_conv_id)
                .order_by(Message.id.asc())
            )
        ).scalars().all()

        assert len(moved_msgs) == 9
        for i, m in enumerate(moved_msgs):
            expected_body, expected_dir, expected_wa_id, exp_created, exp_ext = orig_data[i]
            assert m.body == expected_body
            assert m.direction == expected_dir
            assert m.wa_message_id == expected_wa_id
            assert m.created_at == exp_created
            assert m.external_timestamp == exp_ext


@pytest.mark.asyncio
async def test_10_already_resolved_or_released_records_ignored():
    """10. Daha önce çözülmüş veya serbest bırakılmış kayıtlar yeniden işlenmez."""
    # RESOLVED olarak oluştur
    res_fixture = await _seed_quarantine_fixture(status="RESOLVED", lid_jid="111@lid", gateway_id=GW_A1)
    # RELEASED olarak oluştur
    rel_fixture = await _seed_quarantine_fixture(status="RELEASED", lid_jid="222@lid", gateway_id="gw-quarantine-session-rel")

    async with AsyncSessionLocal() as db:
        # İkisi için de mapping olsun
        for lid in ("111@lid", "222@lid"):
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid, created_at) "
                    "VALUES (:s, :l, :p, CURRENT_TIMESTAMP)"
                ),
                {"s": GW_A1, "l": lid, "p": PHONE_JID_A},
            )
        await db.commit()

        pairs = await candidate_quarantine_recovery_pairs(db, user_id=USER_A_HEX)
        assert len(pairs) == 0, "RESOLVED ve RELEASED kayıtlar asla aday olamaz"

    report = await recover_quarantined_identities(engine, user_id=USER_A_HEX)
    assert report["scanned"] == 0
    assert report["recovered"] == 0


@pytest.mark.asyncio
async def test_11_live_path_ingest_lid_mapped_resolves_quarantine():
    """Ek Doğrulama: Canlı WebSocket `lid_mapped` olayı karantina kaydını anında çözer."""
    fixture = await _seed_quarantine_fixture()

    orchestrator = WhatsAppEventOrchestrator()
    event = {
        "event": "lid_mapped",
        "lid": fixture["lid_jid"],
        "phone_jid": PHONE_JID_A,
        "gateway_session_id": fixture["gateway_id"],
    }

    async with AsyncSessionLocal() as db:
        # Gateway event ingestion çağrısı
        await orchestrator._ingest_lid_mapped(db, event)
        await db.commit()

    async with AsyncSessionLocal() as db:
        q_row = await db.get(WhatsAppIdentityQuarantine, fixture["quarantine_id"])
        assert q_row.status == "RESOLVED"
        detail = json.loads(q_row.detail)
        assert detail["recovery_source"] == "live_event"
        assert detail["resolved_phone_jid"] == PHONE_JID_A
