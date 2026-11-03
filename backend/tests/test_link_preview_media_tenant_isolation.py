"""AŞAMA 5.4.3 — Link preview proxy medya tenant izolasyonu.

Neden bu dosya var
------------------
`LinkPreview` tablosu URL hash'i üzerinde GLOBAL tekildir: satırda tenant
sütunu yoktur. Proxy ucu kimlik doğrular, ancak eski kod kullanıcı kimliğini
servise hiç geçmiyordu ve dahili WhatsApp medyasını (`/api/v1/whatsapp/media/...`)
`Message.media_id` üzerinden **tenant'sız** çözüyordu. Sonuç: bir tenant'ın
öni zleme hash'ini bilen başka bir tenant, o medyayı okuyabiliyordu.

Sözleşme
--------
- Proxy yalnızca çağıranın SAHİP olduğu mesajın medyasını döndürür.
- Medya sorgusu tenant kapsamlıdır; sohbet sahipliği ayrıca doğrulanır.
- `media_id`/hash bilmek tek başına erişim hakkı vermez.
- `user_id` yok/boş → DB'ye dokunmadan fail-closed.
- DB hatası yetkilendirmeyi atlamaz (gateway çağrısı yapılmaz).
- Hata mesajı başka tenant'ın dosya kimliğini/metadata'sını sızdırmaz.
- Uzak (harici) görsel yolu mevcut davranışını korur.

DB: conftest ile aynı izole SQLite dosyası (`AsyncSessionLocal`). Her test
kendi benzersiz tenant/URL/medya kimliklerini üretir ve temizler.
"""
import uuid as _uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from sqlalchemy import text

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.conversation import Conversation
from backend.app.models.link_preview import LinkPreview
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_gateway as gw_module
from backend.app.services.link_preview import service as preview_service
from backend.app.services.link_preview.urls import normalize_url, url_hash

TENANT_A = "cccccccc-3333-4333-8333-cccccccccccc"
TENANT_B = "dddddddd-4444-4444-8444-dddddddddddd"

A_BYTES = b"A-TENANT-PREVIEW-BYTES"
B_BYTES = b"B-TENANT-PRIVATE-PREVIEW-BYTES"
B_PRIVATE_MEDIA = "B-PRIVATE-MEDIA-DO-NOT-LEAK"
B_PRIVATE_FILENAME = "tenant-b-preview-private.pdf"

_SAME = object()


class _FakeGateway:
    def __init__(self):
        self.calls = []

    async def fetch_media(self, gateway_id, media_id, **kwargs):
        self.calls.append({"gateway_id": gateway_id, "media_id": media_id, **kwargs})
        return A_BYTES


@pytest.fixture
def fake_gw(monkeypatch):
    fake = _FakeGateway()
    monkeypatch.setattr(gw_module, "fetch_media", fake.fetch_media)
    return fake


@pytest_asyncio.fixture
async def seeded():
    created = []
    yield created
    async with AsyncSessionLocal() as db:
        for item in reversed(created):
            await db.execute(
                text("DELETE FROM link_previews WHERE url_hash = :h"), {"h": item["digest"]}
            )
            if "msg_id" in item:
                await db.execute(
                    text("DELETE FROM messages WHERE id = :i"), {"i": item["msg_id"]}
                )
                await db.execute(
                    text("DELETE FROM conversations WHERE id = :i"), {"i": item["conv_id"]}
                )
                await db.execute(
                    text("DELETE FROM whatsapp_sessions WHERE id = :i"),
                    {"i": item["session_id"]},
                )
        await db.commit()


async def _seed(
    tenant_id,
    phone,
    *,
    message_tenant=_SAME,
    conversation_tenant=_SAME,
    media_id=None,
    image_url=None,
    filename=None,
):
    digest = url_hash(normalize_url(f"https://example.com/{_uuid.uuid4().hex}"))
    media_id = media_id or f"MEDIA-{_uuid.uuid4().hex}"
    gateway_id = str(_uuid.uuid4())
    now = utc_now_naive()
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
        conv = Conversation(
            user_id=tenant_id if conversation_tenant is _SAME else conversation_tenant,
            session_id=sess.id,
            channel="WHATSAPP",
        )
        db.add(conv)
        await db.flush()
        msg = Message(
            user_id=tenant_id if message_tenant is _SAME else message_tenant,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.IMAGE,
            body=None,
            media_id=media_id,
            media_mime_type="image/png",
            media_filename=filename,
            recipient_phone=phone,
        )
        db.add(msg)
        await db.flush()
        preview = LinkPreview(
            url_hash=digest,
            url=f"https://example.com/{digest}",
            status="OK",
            kind="IMAGE",
            image_url=image_url or f"/api/v1/whatsapp/media/{media_id}",
            fetched_at=now,
            expires_at=now + timedelta(days=1),
        )
        db.add(preview)
        await db.commit()
        result = {
            "gateway_id": gateway_id,
            "session_id": sess.id,
            "conv_id": conv.id,
            "msg_id": msg.id,
            "media_id": media_id,
            "digest": digest,
        }
    return result


async def _seed_remote_preview(image_url="https://cdn.example.com/cover.png"):
    digest = url_hash(normalize_url(f"https://example.com/{_uuid.uuid4().hex}"))
    now = utc_now_naive()
    async with AsyncSessionLocal() as db:
        db.add(
            LinkPreview(
                url_hash=digest,
                url=f"https://example.com/{digest}",
                status="OK",
                kind="IMAGE",
                image_url=image_url,
                fetched_at=now,
                expires_at=now + timedelta(days=1),
            )
        )
        await db.commit()
    return digest


class _NoTouchDb:
    async def scalar(self, *args, **kwargs):
        raise AssertionError("DB must not be queried")

    async def get(self, *args, **kwargs):
        raise AssertionError("DB must not be queried")


class _RowThenFailDb:
    """İlk `scalar` önizleme satırını döner, ikincisi (medya yetki sorgusu) patlar."""

    def __init__(self, row):
        self._row = row
        self._calls = 0

    async def scalar(self, *args, **kwargs):
        self._calls += 1
        if self._calls == 1:
            return self._row
        raise RuntimeError("database unavailable")

    async def get(self, *args, **kwargs):
        raise RuntimeError("database unavailable")


class _ForeignRowThenFineDb:
    """Tenant filtresi hatalı olsa bile açık sahiplik kontrolünü kanıtlar.

    İlk `scalar` önizleme satırını, ikincisi BAŞKA tenant'a ait mesaj satırını
    döner (filtre sızdırmış gibi). Servis bunu açık `_same_tenant` kontrolüyle
    reddetmelidir.
    """

    def __init__(self, row, foreign_message):
        self._row = row
        self._foreign = foreign_message
        self._calls = 0

    async def scalar(self, *args, **kwargs):
        self._calls += 1
        return self._row if self._calls == 1 else self._foreign

    async def get(self, *args, **kwargs):
        raise AssertionError("foreign row must be rejected before conversation lookup")


# ---------------------------------------------------------------------------
# 1. Sahip olduğu medyayı alır (gateway çağrısı çağıranın oturumuna kapsanır)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_receives_own_preview_media(fake_gw, seeded):
    row = await _seed(TENANT_A, "+905550000201", filename="own.png")
    seeded.append(row)

    async with AsyncSessionLocal() as db:
        data, mime = await preview_service.get_preview_image_bytes(db, row["digest"], TENANT_A)

    assert data == A_BYTES
    assert mime == "image/png"
    assert len(fake_gw.calls) == 1
    assert fake_gw.calls[0]["gateway_id"] == row["gateway_id"]
    assert fake_gw.calls[0]["media_id"] == row["media_id"]


# ---------------------------------------------------------------------------
# 2. Başka tenant'ın önizleme hash'i ile o tenant'ın medyasını okuyamaz
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_foreign_tenant_cannot_read_internal_media(fake_gw, seeded):
    foreign = await _seed(
        TENANT_B,
        "+905550000202",
        media_id=B_PRIVATE_MEDIA,
        filename=B_PRIVATE_FILENAME,
    )
    seeded.append(foreign)

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError) as exc:
            await preview_service.get_preview_image_bytes(
                db, foreign["digest"], TENANT_A
            )

    assert fake_gw.calls == []
    assert str(exc.value) == "Medyaya ulasilamadi."
    assert B_PRIVATE_FILENAME not in str(exc.value)
    assert B_PRIVATE_MEDIA not in str(exc.value)


# ---------------------------------------------------------------------------
# 3. Bilinmeyen hash → hata, gateway'e gitmez
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_digest_is_rejected(fake_gw):
    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await preview_service.get_preview_image_bytes(
                db, f"unknown-{_uuid.uuid4().hex}", TENANT_A
            )

    assert fake_gw.calls == []


# ---------------------------------------------------------------------------
# 4. Eksik/boş tenant → DB'ye dokunmadan fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("user_id", [None, "", "   "])
async def test_blank_tenant_fails_closed_without_db_or_gateway(fake_gw, user_id):
    with pytest.raises(LookupError):
        await preview_service.get_preview_image_bytes(
            _NoTouchDb(), "some-digest", user_id
        )

    assert fake_gw.calls == []


# ---------------------------------------------------------------------------
# 5. Medya yetki sorgusundaki DB hatası yetkilendirmeyi atlamaz
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_db_error_does_not_bypass_authorization(fake_gw, seeded):
    row = await _seed(TENANT_A, "+905550000205")
    seeded.append(row)

    async with AsyncSessionLocal() as db:
        preview = await preview_service.lookup_preview_for_proxy(db, row["digest"])

    with pytest.raises(RuntimeError, match="database unavailable"):
        await preview_service.get_preview_image_bytes(
            _RowThenFailDb(preview), row["digest"], TENANT_A
        )

    assert fake_gw.calls == []


# ---------------------------------------------------------------------------
# 6. Tenant filtresi sızdırsa bile açık sahiplik kontrolü reddeder
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_explicit_tenant_check_rejects_foreign_row(fake_gw, seeded):
    row = await _seed(TENANT_A, "+905550000206")
    seeded.append(row)

    async with AsyncSessionLocal() as db:
        preview = await preview_service.lookup_preview_for_proxy(db, row["digest"])

    foreign_message = Message(
        user_id=TENANT_B,
        conversation_id=row["conv_id"],
        direction=MessageDirection.INBOUND,
        message_type=MessageType.IMAGE,
        recipient_phone="+905550000206",
        media_id=row["media_id"],
        media_mime_type="image/png",
    )

    with pytest.raises(LookupError):
        await preview_service.get_preview_image_bytes(
            _ForeignRowThenFineDb(preview, foreign_message), row["digest"], TENANT_A
        )

    assert fake_gw.calls == []


# ---------------------------------------------------------------------------
# 7. Mesaj çağırana ait olsa da sohbet başka tenant'a aitse reddedilir
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_conversation_tenant_mismatch_is_rejected(fake_gw, seeded):
    anomaly = await _seed(
        TENANT_A,
        "+905550000207",
        conversation_tenant=TENANT_B,
        filename=B_PRIVATE_FILENAME,
    )
    seeded.append(anomaly)

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await preview_service.get_preview_image_bytes(
                db, anomaly["digest"], TENANT_A
            )

    assert fake_gw.calls == []


# ---------------------------------------------------------------------------
# 8. Uzak (harici) görsel yolu mevcut sözleşmesini korur
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remote_image_url_still_proxied(monkeypatch, seeded):
    digest = await _seed_remote_preview()
    seeded.append({"digest": digest})

    async def _fake_fetch(url):
        return b"REMOTE-IMAGE", "image/png"

    import backend.app.services.link_preview.unfurl as unfurl_module

    monkeypatch.setattr(unfurl_module, "fetch_image_bytes", _fake_fetch)

    async with AsyncSessionLocal() as db:
        data, mime = await preview_service.get_preview_image_bytes(db, digest, TENANT_A)

    assert data == b"REMOTE-IMAGE"
    assert mime == "image/png"


# ---------------------------------------------------------------------------
# 9. Önizleme satırı var ama görsel yok → hata
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preview_without_image_is_rejected(fake_gw, seeded):
    digest = url_hash(normalize_url(f"https://example.com/{_uuid.uuid4().hex}"))
    now = utc_now_naive()
    async with AsyncSessionLocal() as db:
        db.add(
            LinkPreview(
                url_hash=digest,
                url=f"https://example.com/{digest}",
                status="OK",
                kind="LINK",
                image_url=None,
                fetched_at=now,
                expires_at=now + timedelta(days=1),
            )
        )
        await db.commit()
    seeded.append({"digest": digest})

    async with AsyncSessionLocal() as db:
        with pytest.raises(LookupError):
            await preview_service.get_preview_image_bytes(db, digest, TENANT_A)

    assert fake_gw.calls == []
