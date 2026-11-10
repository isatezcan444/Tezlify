"""AŞAMA 5.3.9 — `messages.update` içerik güncellemesi semantiği (backend).

Neden bu dosya var
------------------
Gateway `messages.update` içeriğini artık `upsert_type="replace"` ile gönderir.
Backend bu türü `notify` gibi işlerse:
  - yeni bir varış sanıp rozeti artırır,
  - zaman damgası yoksa önizlemeyi "şimdi" gibi oynatır,
  - içerik değişmese bile yayın üretir.

Sözleşme
--------
REPLACE : persist edilir, mevcut `wa_message_id` GÜNCELLENİR, rozet ARTMAZ,
          gerçek içerik değişikliği YAYINLANIR, içerik değişmemişse yayın YOK,
          eski/zamansız güncelleme önizlemeyi OYNATMAZ.
NOTIFY  : mevcut davranış (yayın + rozet + önizleme).
APPEND  : mevcut davranış (yayın yok, rozet yok, önizleme yalnızca daha yeniyse).

DB: `AsyncSessionLocal` (conftest `run_db_migrations` fixture'ı ile aynı dosya).
Her test kendi benzersiz jid'ini kullanır ve `_purge` ile kendi satırlarını siler.
"""
import uuid as _uuid

import pytest
from sqlalchemy import text, func, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.message import Message
from backend.app.services.whatsapp.identity import contact_phone_for_jid
from backend.app.services.whatsapp_service import ingest_gateway_event

TEST_USER = "12345678-1234-1234-1234-123456789012"
_PREFIX = "asama539"


def _new_identity() -> str:
    n = _uuid.uuid4().int % 10 ** 10
    return f"+90{n:010d}"


def _jid_for(phone: str) -> str:
    return f"{phone.lstrip('+')}@s.whatsapp.net"


async def _make_session(user_id: str = TEST_USER, label: str = "A539") -> str:
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
    key = contact_phone_for_jid(jid)
    async with AsyncSessionLocal() as db:
        conv_ids = (await db.execute(
            text(
                "SELECT id FROM conversations WHERE contact_id IN "
                "(SELECT id FROM contacts WHERE phone_e164 = :p)"
            ),
            {"p": key},
        )).scalars().all()
        for cid in conv_ids:
            await db.execute(text("DELETE FROM messages WHERE conversation_id = :c"), {"c": cid})
            await db.execute(text("DELETE FROM conversations WHERE id = :c"), {"c": cid})
        await db.execute(text("DELETE FROM contacts WHERE phone_e164 = :p"), {"p": key})
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
# 1. İçerik güncellemesi mevcut kaydı günceller (yeni satır açmaz)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_updates_existing_body():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-upd-{_uuid.uuid4().hex[:8]}"
    try:
        first = await ingest_gateway_event(_event(gw_id, jid, wa_id, body="Orijinal", upsert_type="notify"))
        assert first and first.get("message")
        second = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Duzenlenmis", created_at="2025-01-15T10:05:00Z",
            upsert_type="replace",
        ))
        assert second is not None, "replace islenmeli"
        row = await _message_row(wa_id)
        assert row is not None
        assert row.body == "Duzenlenmis", "govde guncellenmeli"
        assert await _message_count(wa_id) == 1, "ayni wa_message_id tek satir olmali"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 2. Unread artmaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_does_not_increment_unread():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-unread-{_uuid.uuid4().hex[:8]}"
    try:
        first = await ingest_gateway_event(_event(gw_id, jid, wa_id, body="Ilk", upsert_type="notify"))
        conv_id = first["conversation_id"]
        before = (await _conversation_row(conv_id))[0]
        await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Duzenlendi", created_at="2025-01-15T10:05:00Z",
            upsert_type="replace",
        ))
        after = (await _conversation_row(conv_id))[0]
        assert after == before, f"replace rozeti artirmamali ({before} -> {after})"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 3. Gerçek içerik değişikliği yayınlanır
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_broadcasts_real_content_change():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-bcast-{_uuid.uuid4().hex[:8]}"
    try:
        await ingest_gateway_event(_event(gw_id, jid, wa_id, body="Ilk", upsert_type="notify"))
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Yeni icerik", created_at="2025-01-15T10:05:00Z",
            upsert_type="replace",
        ))
        assert result.get("_no_broadcast") is None, "gercek degisiklik yayinlanmali"
        assert result.get("message"), "yayin govdesi olmali"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 4. İçerik değişmemiş duplicate update yayın üretmez
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_duplicate_does_not_broadcast():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-dup-{_uuid.uuid4().hex[:8]}"
    try:
        await ingest_gateway_event(_event(gw_id, jid, wa_id, body="Ayni", upsert_type="notify"))
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Ayni", created_at="2025-01-15T10:00:00Z",
            upsert_type="replace",
        ))
        assert result is not None
        assert result.get("_no_broadcast") is True, "degismeyen replace yayinlanmamali"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 5. Preview monotonicity — eski güncelleme önizlemeyi ezmez
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_older_does_not_move_preview():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    new_id = f"{_PREFIX}-new-{_uuid.uuid4().hex[:8]}"
    old_id = f"{_PREFIX}-old-{_uuid.uuid4().hex[:8]}"
    try:
        live = await ingest_gateway_event(_event(
            gw_id, jid, new_id, body="En yeni", created_at="2025-03-01T12:00:00Z",
        ))
        conv_id = live["conversation_id"]
        await ingest_gateway_event(_event(
            gw_id, jid, old_id, body="Eski", created_at="2025-01-01T09:00:00Z",
            upsert_type="append",
        ))
        before = await _conversation_row(conv_id)
        await ingest_gateway_event(_event(
            gw_id, jid, old_id, body="Eski duzenlendi", created_at="2025-01-02T09:00:00Z",
            upsert_type="replace",
        ))
        after = await _conversation_row(conv_id)
        assert after[1] == before[1], "eski replace onizlemeyi ezmemeli"
        assert str(after[2]) == str(before[2]), "eski replace son aktiviteyi geri tasimamali"
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_replace_without_timestamp_does_not_move_preview():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    new_id = f"{_PREFIX}-tsnew-{_uuid.uuid4().hex[:8]}"
    old_id = f"{_PREFIX}-tsold-{_uuid.uuid4().hex[:8]}"
    try:
        live = await ingest_gateway_event(_event(
            gw_id, jid, new_id, body="En yeni", created_at="2025-03-01T12:00:00Z",
        ))
        conv_id = live["conversation_id"]
        await ingest_gateway_event(_event(
            gw_id, jid, old_id, body="Eski", created_at="2025-01-01T09:00:00Z",
            upsert_type="append",
        ))
        before = await _conversation_row(conv_id)
        evt = _event(gw_id, jid, old_id, body="Zamansiz duzenleme", upsert_type="replace")
        evt["message"].pop("created_at", None)
        await ingest_gateway_event(evt)
        after = await _conversation_row(conv_id)
        assert after[1] == before[1], "zamansiz replace onizlemeyi ezmemeli"
        assert str(after[2]) == str(before[2])
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 6. Bilinmeyen mesaj için replace yanlış unread artırmaz
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replace_unknown_message_does_not_increment_unread():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-unk-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Gec gelen guncelleme",
            created_at="2025-01-01T09:00:00Z", upsert_type="replace",
        ))
        assert result is not None
        conv = await _conversation_row(result["conversation_id"])
        assert (conv[0] or 0) == 0, "bilinmeyen mesajin replace'i rozeti artirmamali"
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 7. Notify/append ve bilinmeyen tip geriye dönük uyumlu
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_notify_and_append_unchanged():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    notify_id = f"{_PREFIX}-n-{_uuid.uuid4().hex[:8]}"
    append_id = f"{_PREFIX}-a-{_uuid.uuid4().hex[:8]}"
    try:
        n = await ingest_gateway_event(_event(gw_id, jid, notify_id, body="Canli", upsert_type="notify"))
        assert n.get("_no_broadcast") is None
        a = await ingest_gateway_event({
            **_event(gw_id, jid, append_id, body="Gecmis", upsert_type="append"),
            "is_sync": True,
        })
        assert a.get("_no_broadcast") is True
    finally:
        await _purge(jid, gw_id)


@pytest.mark.asyncio
async def test_unknown_upsert_type_still_falls_back_to_notify():
    jid = _jid_for(_new_identity())
    gw_id = await _make_session()
    wa_id = f"{_PREFIX}-weird-{_uuid.uuid4().hex[:8]}"
    try:
        result = await ingest_gateway_event(_event(
            gw_id, jid, wa_id, body="Bilinmeyen", upsert_type="weird_future_type",
        ))
        assert isinstance(result, dict)
        assert result.get("_no_broadcast") is None, "bilinmeyen tip append sayilmamali"
        assert await _message_count(wa_id) == 1
    finally:
        await _purge(jid, gw_id)
