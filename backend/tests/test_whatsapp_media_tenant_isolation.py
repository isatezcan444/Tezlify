"""AŞAMA 5.4.2 — `get_media_bytes` tenant izolasyonu (F-10).

Neden bu dosya var
------------------
Eski davranış: `media_id` çağıran kullanıcının hiçbir mesajına çözülemezse
backend `fetch_media_unscoped` ile gateway'den medyayı TENANT'SIZ çekiyordu.
Gateway'de baytlar duruyorsa, başka bir tenant'ın `media_id`'sini bilen bir
kullanıcı o medyayı okuyabiliyordu.

Sözleşme
--------
- `media_id`/`wa_message_id` yalnızca çağıran tenant'ın mesajına çözülür.
- Çözülemezse `LookupError`; gateway'e HİÇ gidilmez (global fallback yok).
- `user_id` boş/None ise istek DB'ye dokunmadan reddedilir.
- DB erişim hatası yetkilendirmeyi atlamaz (gateway çağrısı yapılmaz).
- Legacy ama doğru tenant'a ait kayıtlar çalışmaya devam eder.

DB: `AsyncSessionLocal` (conftest `run_db_migrations` fixture'ı ile aynı dosya).
Her test kendi benzersiz tenant/telefon/medya kimliklerini üretir ve temizler.
"""
import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration import messaging
from backend.app.services.whatsapp.orchestration.messaging import get_media_bytes

TENANT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
TENANT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

A_BYTES = b"A-OWNED-MEDIA-BYTES"
B_BYTES = b"B-PRIVATE-MEDIA-BYTES"
B_PRIVATE_FILENAME = "tenant-b-private-contract.pdf"

_SAME = object()


class _FakeGateway:
    def __init__(self):
        self.calls = []
        self.unscoped_calls = 0

    async def fetch_media(self, gateway_id, media_id, **kwargs):
        self.calls.append({"gateway_id": gateway_id, "media_id": media_id, **kwargs})
        return A_BYTES

    async def fetch_media_unscoped(self, *args, **kwargs):
        self.unscoped_calls += 1
        raise AssertionError("fetch_media_unscoped must never be called")


@pytest.fixture
def fake_gw(monkeypatch):
    fake = _FakeGateway()
    monkeypatch.setattr(messaging.gw, "fetch_media", fake.fetch_media)
    monkeypatch.setattr(messaging.gw, "fetch_media_unscoped", fake.fetch_media_unscoped)
    return fake


@pytest_asyncio.fixture
async def seeded():
    created = []
    yield created
    async with AsyncSessionLocal() as db:
        for item in reversed(created):
            await db.execute(text("DELETE FROM messages WHERE id = :i"), {"i": item["msg_id"]})
            await db.execute(text("DELETE FROM conversations WHERE id = :i"), {"i": item["conv_id"]})
            await db.execute(text("DELETE FROM contacts WHERE id = :i"), {"i": item["contact_id"]})
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE id = :i"), {"i": item["session_id"]}
            )
        await db.commit()


async def _seed(
    tenant_id,
    phone,
    *,
    message_tenant=_SAME,
    conversation_tenant=_SAME,
    media_id=None,
    wa_id=None,
    filename=None,
):
    media_id = media_id or f"MEDIA-{_uuid.uuid4().hex}"
    wa_id = wa_id or f"WA-{_uuid.uuid4().hex}"
    gateway_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=tenant_id,
            gateway_id=gateway_id,
            session_name=f"S-{phone}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()
        contact = Contact(user_id=tenant_id, phone_e164=phone)
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=tenant_id if conversation_tenant is _SAME else conversation_tenant,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
        )
        db.add(conv)
        await db.flush()
        msg = Message(
            user_id=tenant_id if message_tenant is _SAME else message_tenant,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.DOCUMENT,
            body="ek",
            wa_message_id=wa_id,
            media_id=media_id,
            media_filename=filename,
            recipient_phone=phone,
        )
        db.add(msg)
        await db.flush()
        result = {
            "gateway_id": gateway_id,
            "session_id": sess.id,
            "contact_id": contact.id,
            "conv_id": conv.id,
            "msg_id": msg.id,
            "media_id": media_id,
            "wa_id": wa_id,
        }
        await db.commit()
    return result


class _NoTouchDb:
    async def execute(self, *args, **kwargs):
        raise AssertionError("DB must not be queried")

    async def get(self, *args, **kwargs):
        raise AssertionError("DB must not be queried")


class _ExplodingDb:
    async def execute(self, *args, **kwargs):
        raise RuntimeError("database unavailable")

    async def get(self, *args, **kwargs):
        raise RuntimeError("database unavailable")


# ---------------------------------------------------------------------------
# 1. Sahip olduğu medyayı alır
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tenant_can_fetch_own_media(fake_gw, seeded):
    row = await _seed(TENANT_A, "+905550000101")
    seeded.append(row)

    async with AsyncSessionLocal() as db:
        data, _mime, _filename = await get_media_bytes(db, TENANT_A, row["media_id"])

    assert data == A_BYTES
    assert len(fake_gw.calls) == 1
    assert fake_gw.calls[0]["gateway_id"] == row["gateway_id"]
    assert fake_gw.calls[0]["media_id"] == row["media_id"]
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 2. Başka tenant'ın media_id'si ile okuyamaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tenant_cannot_fetch_foreign_media_id(fake_gw, seeded):
    foreign = await _seed(TENANT_B, "+905550000102", filename=B_PRIVATE_FILENAME)
    seeded.append(foreign)

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError) as exc:
            await get_media_bytes(db, TENANT_A, foreign["media_id"])

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0
    assert str(exc.value) == "Medya bulunamadi"
    assert B_PRIVATE_FILENAME not in str(exc.value)


# ---------------------------------------------------------------------------
# 3. Başka tenant'ın wa_message_id'si ile okuyamaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tenant_cannot_fetch_foreign_wa_message_id(fake_gw, seeded):
    foreign = await _seed(TENANT_B, "+905550000103")
    seeded.append(foreign)

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await get_media_bytes(db, TENANT_A, foreign["wa_id"])

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 4. DB satırı yoksa global fallback yok
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_missing_row_does_not_fall_back_to_unscoped_gateway(fake_gw):
    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await get_media_bytes(db, TENANT_A, f"UNKNOWN-{_uuid.uuid4().hex}")

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 5. Tenant bilgisi yoksa fail-closed
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("user_id", ["", "   ", None])
async def test_blank_tenant_fails_closed_without_db_or_gateway(fake_gw, user_id):
    with pytest.raises(LookupError):
        await get_media_bytes(_NoTouchDb(), user_id, "MEDIA-anything")

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 6. DB hatası yetkilendirmeyi atlamaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_db_error_does_not_bypass_authorization(fake_gw):
    with pytest.raises(RuntimeError, match="database unavailable"):
        await get_media_bytes(_ExplodingDb(), TENANT_A, "MEDIA-unknown")

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 7. Legacy ama doğru tenant'a ait kayıt çalışır (media_filename NULL)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_legacy_record_without_filename_still_served_for_owner(fake_gw, seeded):
    legacy = await _seed(TENANT_A, "+905550000107", filename=None)
    seeded.append(legacy)

    async with AsyncSessionLocal() as db:
        data, _mime, filename = await get_media_bytes(db, TENANT_A, legacy["wa_id"])

    assert data == A_BYTES
    assert filename is None
    assert fake_gw.unscoped_calls == 0


# ---------------------------------------------------------------------------
# 8. Mesaj A'ya ait olsa da sohbet B'ye aitse reddedilir
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_message_conversation_tenant_mismatch_is_rejected(fake_gw, seeded):
    anomaly = await _seed(
        TENANT_A,
        "+905550000108",
        conversation_tenant=TENANT_B,
        filename=B_PRIVATE_FILENAME,
    )
    seeded.append(anomaly)

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await get_media_bytes(db, TENANT_A, anomaly["media_id"])

    assert fake_gw.calls == []
    assert fake_gw.unscoped_calls == 0
