"""Startup'ta ERTELENEN LID hayaletleri gerçekten BİRLEŞTİRİLİR.

Context (2026-10-01). `purge_raw_jid_identity_data` (startup migration) artık
köprüsü `lid_mappings` üzerinden BİLİNEN hayaletleri silmiyor, "onarıma bırakıyor".
Erteleme birleştirme değildir: boot yalnızca silmekten vazgeçtiyse satırlar
isimsiz bir sohbet olarak durur ve kullanıcı mesajlarını bulamaz.

Bu kapı, `merge_deferred_lid_ghosts` (boot adımı) sözleşmesini çiviler:

- boot, köprüsü bilinen hayaleti GERÇEKTEN canonical sohbete taşır (mesaj kaybı
  yok), okunmamışı toplar ve eski sohbeti arşivler — silmez,
- ikinci boot'ta yapılacak iş KALMAZ (arşivlenmiş LID sohbeti aday değildir);
  onsuz her restart aynı çiftleri yeniden "birleştirilmiş" diye raporlardı,
- köprüsü bilinmeyen kimlik TAHMİN EDİLMEZ,
- koşu `limit` ile sınırlıdır ve artanı dürüstçe söyler,
- hiçbir hata startup'ı düşürmez (`error` alanıyla raporlanır),
- canlı yol, boot ve onarım işi TEK bir birleştirme uygulamasını çağırır.
"""
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal, engine
from backend.app.core.migrations import purge_raw_jid_identity_data
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator

import backend.app.services.whatsapp.orchestration.events as events_module
import backend.app.services.whatsapp.reconciliation as reconciliation_module
import scripts.diagnostics.whatsapp_lid_split_repair as repair_module
from backend.app.services.whatsapp.reconciliation import (
    _merge_lease,
    _merge_lock_key,
    collect_stranded_lid_messages,
    merge_deferred_lid_ghosts,
    merge_split_conversation,
    merge_sweep_status,
    run_identity_sweep_once,
)

# Diğer WhatsApp kapılarıyla paylaşılmayan kullanıcı/numaralar: bu kapı
# "kimin satırı birleşti" sayısını kanıt olarak okuduğu için yalıtım şart.
TEST_USER = "a1b2c3d4-1111-4222-8333-444455556666"
TEST_USER_HEX = TEST_USER.replace("-", "")
LID_JID = "999000111222333@lid"
PHONE = "+905559990001"
PHONE_JID = "905559990001@s.whatsapp.net"
GW_ID = "gw-boot-lid-merge"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup():
    async def _wipe(create_table=True):
        async with AsyncSessionLocal() as db:
            if create_table:
                # Mirrors `_ensure_sqlite_lid_and_history_tables`; the gateway
                # owns this table, so the isolated test DB may not have it.
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
            await db.execute(
                text("DELETE FROM messages WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM conversations WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id = :h"), {"h": TEST_USER_HEX}
            )
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id = :h"),
                {"h": TEST_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe(create_table=False)


async def _seed_split(
    mapping: bool = True,
    *,
    lid_jid: str = LID_JID,
    phone: str = PHONE,
    phone_jid: str = PHONE_JID,
    gw_id: str = GW_ID,
    wa_tag: str = "",
    archive_legacy: bool = False,
    user_id: str = TEST_USER,
):
    """Bir hayalet LID kimliği ile kanonik telefon kimliğini bölünmüş halde tohumlar."""
    lid_phone = f"jid:{lid_jid}"
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=user_id,
            gateway_id=gw_id,
            session_name="LID Boot Hat",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        ghost = Contact(user_id=user_id, phone_e164=lid_phone, display_name="Syafira")
        db.add(ghost)
        await db.flush()
        legacy_conv = Conversation(
            user_id=user_id,
            contact_id=ghost.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ARCHIVED if archive_legacy else ConversationStatus.ACTIVE,
            is_archived=archive_legacy,
            unread_count=2,
        )
        db.add(legacy_conv)
        await db.flush()

        canonical = Contact(user_id=user_id, phone_e164=phone, display_name=None)
        db.add(canonical)
        await db.flush()
        canonical_conv = Conversation(
            user_id=user_id,
            contact_id=canonical.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            unread_count=1,
        )
        db.add(canonical_conv)
        await db.flush()

        # One wa_message_id is SHARED: that is the duplicate the merge must
        # collapse rather than clone.
        for i in range(2):
            db.add(
                Message(
                    user_id=TEST_USER_HEX,
                    conversation_id=legacy_conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"lid-{i}",
                    sender_phone=phone,
                    recipient_phone="ME",
                    wa_message_id=f"SHARED_{wa_tag}" if i == 0 else f"LID_{wa_tag}{i}",
                )
            )
        db.add(
            Message(
                user_id=TEST_USER_HEX,
                conversation_id=canonical_conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="already-canonical",
                sender_phone=phone,
                recipient_phone="ME",
                wa_message_id=f"SHARED_{wa_tag}",
            )
        )

        if mapping:
            await db.execute(
                text(
                    "INSERT INTO lid_mappings (session_id, lid_jid, phone_jid) "
                    "VALUES (:s, :l, :p)"
                ),
                {"s": gw_id, "l": lid_jid, "p": phone_jid},
            )
        await db.commit()
        return legacy_conv.id, canonical_conv.id


async def _message_conversations():
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message.conversation_id, Message.wa_message_id, Message.body)
            )
        ).all()
    return [(r[0], r[1], r[2]) for r in rows]


async def _legacy_state(legacy_conv_id):
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(Conversation).where(Conversation.id == legacy_conv_id))
        ).scalar_one_or_none()


async def _canonical_unread(canonical_conv_id):
    async with AsyncSessionLocal() as db:
        return await db.scalar(
            select(Conversation.unread_count).where(Conversation.id == canonical_conv_id)
        )


@pytest.mark.asyncio
async def test_boot_merge_actually_moves_the_ghost_conversation():
    """Erteleme birleştirme değildi; bu adım onu birleştirir — kanıtla birlikte."""
    legacy_id, canonical_id = await _seed_split()

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["merged"] == 1, report
    assert report["scanned"] == 1
    assert report["remaining_at_least"] == 0
    assert "error" not in report, report
    pair = report["merged_pairs"][0]
    assert pair["legacy_conversation_id"] == legacy_id
    assert pair["canonical_conversation_id"] == canonical_id
    assert pair["canonical_unread_count"] == 3, "1 (kanonik) + 2 (LID) toplanmalı"
    assert pair["moved_unique"] == 1
    assert pair["deduped_duplicates"] == 1, "paylaşılan wa_message_id tekilleşmeli"
    assert pair["stranded_unique"] == 0, "sahipsiz mesaj iddiası ölçülerek söylenir"

    rows = await _message_conversations()
    canonical_rows = [r for r in rows if r[0] == canonical_id]
    assert sorted(body for _c, _w, body in canonical_rows) == [
        "already-canonical",
        "lid-1",
    ], f"benzersiz mesaj taşınmalı, kopya tekilleşmeli; got {rows}"

    legacy = await _legacy_state(legacy_id)
    assert legacy is not None, "LID sohbeti ARŞİVLENİR, silinmez"
    assert legacy.is_archived is True
    assert legacy.unread_count == 0


@pytest.mark.asyncio
async def test_purge_defers_then_merge_repairs_on_the_same_boot():
    """Boot sırası: purge köprüsü bilineni ERTELER, hemen ardından merge BİRLEŞTİRİR.

    Ertelenen satırın boot'ta gerçekten canonical sohbete girdiğini, ayrı ayrı
    iki kapının değil, ikisinin BİRLİKTE çalıştığının kanıtı.
    """
    legacy_id, canonical_id = await _seed_split()

    await purge_raw_jid_identity_data(engine)
    ghost = await _legacy_state(legacy_id)
    assert ghost is not None, "köprüsü bilinen hayalet purge tarafından silinmemeli"
    assert ghost.is_archived is False, "erteleme birleştirme değildir — henüz dokunulmadı"

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["merged"] == 1
    rows = await _message_conversations()
    assert sorted(body for c, _w, body in rows if c == canonical_id) == [
        "already-canonical",
        "lid-1",
    ], "purge sonrası merge mesajları taşımalı (hiçbiri kaybolmadan)"
    assert (await _legacy_state(legacy_id)).is_archived is True


@pytest.mark.asyncio
async def test_a_merge_lease_held_elsewhere_defers_instead_of_racing():
    """İki süreç aynı çifti birleştiremez: ikincisi ERTELENİR, yalan söylemez.

    Erteleme kayıp değildir: LID sohbeti arşivlenmediği için aday kalır ve bir
    sonraki süpürme onu birleştirir. Yarışa izin vermek ise okunmamışı iki kez
    toplar ve arada gelen mesajı arşivlenen sohbette sahipsiz bırakır.
    """
    legacy_id, canonical_id = await _seed_split()

    async with AsyncSessionLocal() as holder_db:
        async with _merge_lease(
            holder_db,
            # Anahtar PAYLAŞILAN yardımcıyla üretilir: dash'li/dash'siz user_id
            # aynı kilide düşmezse iki süreç birbirini görmez.
            lock_key=_merge_lock_key(TEST_USER, f"jid:{LID_JID}"),
            wait_seconds=0.0,
        ) as (held, _h):
            assert held is True, "lease alınmalıydı"

            info: Dict[str, Any] = {}
            async with AsyncSessionLocal() as other_db:
                merged = await merge_split_conversation(
                    other_db,
                    TEST_USER,
                    LID_JID,
                    PHONE_JID,
                    session_id=None,
                    lock_wait_seconds=0.0,
                    result_info=info,
                )
            assert merged is None, "kilitliyken birleştirme YAPILMAMALI"
            assert info.get("skipped_reason") == "merge_lease_held"

            legacy = await _legacy_state(legacy_id)
            assert legacy.is_archived is False, "erteleme sohbete dokunmamalı"
            assert await _canonical_unread(canonical_id) == 1, "okunmamış iki kez toplanmamalı"

    # Kilit bırakıldıktan sonra aynı iş normal biçimde tamamlanır.
    info2: Dict[str, Any] = {}
    async with AsyncSessionLocal() as db:
        merged = await merge_split_conversation(
            db, TEST_USER, LID_JID, PHONE_JID, session_id=None, result_info=info2
        )
    assert merged is not None and merged.id == canonical_id
    assert info2.get("moved_unique") == 1, "benzersiz mesaj taşınmış olmalı"
    assert info2.get("merge_passes", 0) >= 2, (
        "taşıma sonrası DOĞRULAMA turu koşmalı: tek tur, arada gelmiş bir mesajı "
        "arşivlenen sohbette bırakabilir"
    )
    assert info2.get("stranded_unique") == 0
    assert await _canonical_unread(canonical_id) == 3
    assert (await _legacy_state(legacy_id)).is_archived is True


def test_the_lease_key_ignores_user_id_spelling():
    """Kayıtlı user_id dash'siz, canlı yol tireli: anahtar YİNE aynı olmalı."""
    from backend.app.services.whatsapp.reconciliation import _merge_lock_key as key

    assert key(TEST_USER, f"jid:{LID_JID}") == key(TEST_USER_HEX, f"jid:{LID_JID}")


@pytest.mark.asyncio
async def test_boot_reports_a_lease_deferral_as_deferred_not_as_silence():
    """Boot raporu ertelenen işi `deferred` olarak söyler; `merged` demez."""
    await _seed_split()

    async with AsyncSessionLocal() as holder_db:
        async with _merge_lease(
            holder_db,
            lock_key=_merge_lock_key(TEST_USER, f"jid:{LID_JID}"),
            wait_seconds=0.0,
        ) as (held, _h):
            assert held is True
            report = await merge_deferred_lid_ghosts(engine, limit=10, user_id=TEST_USER)

    assert report["merged"] == 0
    assert report["deferred"] == 1, report
    assert report["deferred_pairs"][0]["reason"] == "merge_lease_held"


@pytest.mark.asyncio
async def test_a_message_stranded_by_the_race_is_collected_later():
    """Yarışta arşivlenen sohbete düşen mesaj KAYBOLMAZ: süpürme onu taşır."""
    legacy_id, canonical_id = await _seed_split()
    await merge_deferred_lid_ghosts(engine, limit=10)
    assert await _canonical_unread(canonical_id) == 3

    # Canlı ingest'in yarışını simüle et: eski sohbet arşivlendi ama bir mesaj
    # hâlâ oraya yazıldı (arşivlemeden önce çözülmüş olan sohbet).
    async with AsyncSessionLocal() as db:
        db.add(
            Message(
                user_id=TEST_USER_HEX,
                conversation_id=legacy_id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="race-message",
                sender_phone=PHONE,
                recipient_phone="ME",
                wa_message_id="RACE_1",
            )
        )
        await db.commit()

    report = await collect_stranded_lid_messages(engine, limit=10, user_id=TEST_USER)

    assert report["scanned"] == 1, report
    assert report["merged"] == 1
    assert report["moved_unique_total"] == 1
    assert report["still_stranded"] == 0

    rows = await _message_conversations()
    canonical_bodies = sorted(b for c, _w, b in rows if c == canonical_id)
    assert canonical_bodies == ["already-canonical", "lid-1", "race-message"], (
        f"sahipsiz mesaj canonical sohbete taşınmalı; got {rows}"
    )

    # İkinci koşu iş ÜRETMEZ: sahipsiz satır kalmadıysa aday da yoktur.
    again = await collect_stranded_lid_messages(engine, limit=10, user_id=TEST_USER)
    assert again["scanned"] == 0
    assert again["merged"] == 0


@pytest.mark.asyncio
async def test_one_sweep_run_merges_and_collects_and_reports_state():
    """Süpürme hem birleştirir hem artığı toplar; durumu `/health` için kaydeder."""
    legacy_id, canonical_id = await _seed_split()

    first = await run_identity_sweep_once(engine, limit=10)

    assert first["splits"]["merged"] == 1
    assert first["stranded"]["scanned"] == 0, "aynı turda artık kalmadı"
    status = merge_sweep_status()
    assert status["runs"] == 1
    assert status["merged_total"] == 1
    assert status["pending_at_least"] == 0
    assert status["last_finished_at"] is not None
    assert "last_report" not in status, "tam rapor /health gövdesini şişirmemeli"

    # Yarış artığı aynı süpürme turunda toplanır.
    async with AsyncSessionLocal() as db:
        db.add(
            Message(
                user_id=TEST_USER_HEX,
                conversation_id=legacy_id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="sweep-race",
                sender_phone=PHONE,
                recipient_phone="ME",
                wa_message_id="RACE_2",
            )
        )
        await db.commit()

    second = await run_identity_sweep_once(engine, limit=10)
    assert second["stranded"]["moved_unique_total"] == 1
    assert merge_sweep_status()["stranded_moved_total"] == 1
    assert await _canonical_unread(canonical_id) == 3


@pytest.mark.asyncio
async def test_second_boot_has_nothing_left_to_merge():
    """İdempotans: arşivlenen satır aday değil, yoksa her restart aynı işi yapar."""
    _legacy_id, canonical_id = await _seed_split()

    first = await merge_deferred_lid_ghosts(engine, limit=10)
    assert first["merged"] == 1
    before = await _message_conversations()

    second = await merge_deferred_lid_ghosts(engine, limit=10)

    assert second["scanned"] == 0, "arşivlenmiş LID sohbeti yeniden iş görmez"
    assert second["merged"] == 0
    assert await _message_conversations() == before, "ikinci boot hiçbir satıra dokunmamalı"
    assert await _canonical_unread(canonical_id) == 3, "okunmamış iki kez toplanmamalı"


@pytest.mark.asyncio
async def test_a_lid_without_a_known_bridge_is_never_guessed_at():
    """Köprü yoksa birleştirme de yok: yanlış iki kişiyi birleştirmek daha kötü."""
    await _seed_split(mapping=False)

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["scanned"] == 0
    assert report["merged"] == 0
    assert len(await _message_conversations()) == 3, "hiçbir satır dokunulmamalı"


@pytest.mark.asyncio
async def test_an_already_archived_ghost_conversation_is_not_a_candidate():
    """Arşiv = birleştirme zaten yapıldı; tekrar iş üretilmez."""
    await _seed_split(archive_legacy=True)

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["scanned"] == 0
    assert report["merged"] == 0


@pytest.mark.asyncio
async def test_the_boot_run_is_bounded_and_reports_what_is_still_waiting():
    """Sınırsız bir boot adımı olamaz; artan iş dürüstçe bildirilir."""
    await _seed_split(
        lid_jid="999000111222334@lid",
        phone="+905559990002",
        phone_jid="905559990002@s.whatsapp.net",
        gw_id="gw-boot-lid-merge-a",
        wa_tag="a",
    )
    await _seed_split(
        lid_jid="999000111222335@lid",
        phone="+905559990003",
        phone_jid="905559990003@s.whatsapp.net",
        gw_id="gw-boot-lid-merge-b",
        wa_tag="b",
    )

    bounded = await merge_deferred_lid_ghosts(engine, limit=1, user_id=TEST_USER)

    assert bounded["merged"] == 1, "limit gerçekten işi sınırlamalı"
    assert bounded["remaining_at_least"] == 1, "artan iş saklanmamalı"

    rest = await merge_deferred_lid_ghosts(engine, limit=1, user_id=TEST_USER)
    assert rest["merged"] == 1
    assert rest["remaining_at_least"] == 0


@pytest.mark.asyncio
async def test_boot_step_never_crashes_startup(monkeypatch):
    """Kimlik birleştirmesi şema bütünlüğüne dokunmaz: hata loglanır, boot devam eder."""
    async def _boom(*_a, **_kw):
        raise RuntimeError("lid_mappings okunamadi")

    monkeypatch.setattr(reconciliation_module, "candidate_lid_split_pairs", _boom)

    report = await merge_deferred_lid_ghosts(engine, limit=10)

    assert report["merged"] == 0
    assert "lid_mappings okunamadi" in (report.get("error") or "")


@pytest.mark.asyncio
async def test_health_exposes_the_sweep_state_without_shell_commands():
    """Operatör "bekleyen iş var mı"yı docker exec etmeden `/health`ten okur."""
    from backend.app.main import health_check

    await run_identity_sweep_once(engine, limit=5)
    body = await health_check()

    block = body["whatsapp_identity_sweep"]
    assert block["runs"] == 1
    assert "pending_at_least" in block
    assert "last_deferred" in block
    assert "still_stranded" in block
    assert block["last_finished_at"] is not None
    assert "last_report" not in block


def test_live_boot_and_repair_share_one_merge_implementation():
    """Üç çağrı yeri, TEK uygulama: kopya bir mantık zamanla ayrışırdı."""
    assert (
        events_module._merge_split_conversation
        is reconciliation_module.merge_split_conversation
    )
    assert (
        repair_module.merge_split_conversation
        is reconciliation_module.merge_split_conversation
    )


@pytest.mark.asyncio
async def test_live_path_delegates_with_its_own_mockable_helpers(monkeypatch):
    """Canlı yol gövdeyi kopyalamaz; orchestrator'a özgü yardımcıları enjekte eder."""
    seen = {}

    async def _fake_merge(db, user_id, lid_jid, phone_jid, session_id=None, **kwargs):
        seen.update(
            {
                "user_id": user_id,
                "lid_jid": lid_jid,
                "phone_jid": phone_jid,
                "session_id": session_id,
                **kwargs,
            }
        )
        return None

    monkeypatch.setattr(events_module, "_merge_split_conversation", _fake_merge)

    orchestrator = WhatsAppEventOrchestrator()
    db = AsyncMock(spec=AsyncSession)
    result = await orchestrator.reconcile_legacy_split_conversation(
        db, "user-1", "123@lid", "905551234567@s.whatsapp.net"
    )

    assert result is None
    assert seen["lid_jid"] == "123@lid"
    assert seen["phone_jid"] == "905551234567@s.whatsapp.net"
    assert callable(seen["upsert_contact"]), "orchestrator kendi üretim yardımcısını vermeli"
    assert callable(seen["ensure_conversation"])
