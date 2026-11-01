"""AŞAMA 5.2.3 — PostgreSQL üzerinde GERÇEK `IntegrityError` yarışı.

Neden bu dosya var
------------------
AŞAMA 5.2.1 denetiminde `IntegrityError` kurtarma yolu **tetiklenemedi**:
SQLite yazma kilidi eşzamanlı yazarları serileştirdiği için iki ingest hiçbir
zaman aynı anda pre-flight SELECT'ini geçemiyordu. O yol "doğrulanamadı" olarak
kaydedildi — "geçti" diye değil. Bu dosya o boşluğu kapatır: yarış, gerçek
PostgreSQL kısmi unique indeksi (`uq_msg_conv_wa_message_id`) üzerinde kurulur.

Yarış nasıl deterministik yapılıyor
-----------------------------------
Rastgele `sleep` ile yarış "umut edilmez". INSERT ile commit arasında duran
gerçek bir `await` noktası kullanılır:

    _ingest_message:  pre-flight SELECT → INSERT (flush) → ... → commit
                                                       ↑
                                      `_preview_for_text_message` (await)

Kazanan (A) o noktada bekletilir: satırı INSERT edilmiş, transaction'ı AÇIK,
commit edilmemiş. Bu sırada B başlatılır — pre-flight'ı A'nın commit edilmemiş
satırını GÖRMEZ (READ COMMITTED), INSERT'i ise A'nın tuttuğu indeks girdisinde
KİLİTLENİR. B'nin kilitlendiği `pg_stat_activity`'den doğrulanır, sonra A
serbest bırakılır. B artık gerçek bir unique ihlali alır.

Üretim kodu DEĞİŞTİRİLMEZ: bekletme noktası yalnızca test içinde, modül
globali üzerinden enjekte edilir (`monkeypatch`).

Kapsam
------
Yarış, gerçek köprü uç noktasından (`gateway_websocket_endpoint`) sürülür;
böylece ACK / NACK / broadcast kararı da gerçek kodla verilir.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid as _uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.main import gateway_websocket_endpoint, ws_manager
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_service
from backend.app.services.whatsapp.orchestration import events as events_module
from backend.app.services.whatsapp_service import jid_to_phone

# ---------------------------------------------------------------------------
# PostgreSQL zorunlu
# ---------------------------------------------------------------------------
_IS_POSTGRES = settings.DATABASE_URL.startswith("postgresql")
pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not _IS_POSTGRES,
        reason=(
            "Bu test gerçek PostgreSQL unique index davranışını ölçer; "
            "SQLite yazma kilidi yarışı serileştirdiği için yol tetiklenemez."
        ),
    ),
]

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_GATEWAY_SECRET = "a" * 32

_EVENTS_LOGGER = "backend.app.services.whatsapp.orchestration.events"
_RACE_LOG_FRAGMENT = "Duplicate WhatsApp message ignored (concurrent ingest race)"


# ---------------------------------------------------------------------------
# Event loop / connection pool izolasyonu
# ---------------------------------------------------------------------------
# Bu dosya kendi havuz tazeleme fixture'ını TAŞIMAZ: AŞAMA 5.2.4 ile
# `conftest.postgres_fresh_pool` ortak hâle getirildi ve yalnız PostgreSQL
# dialect'inde etkin. Yerel bir kopya bırakmak, aynı testte iki kez dispose
# çağırmak olurdu (zararsız ama yanıltıcı: "bu dosya özel" izlenimi verir).


@pytest.fixture(autouse=True)
def _configure_gateway_secret(monkeypatch):
    monkeypatch.setattr(settings, "WHATSAPP_GATEWAY_SECRET", TEST_GATEWAY_SECRET)


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------
def _new_identity() -> str:
    n = _uuid.uuid4().int % 10 ** 10
    return f"+90{n:010d}"


def _jid_for(phone: str) -> str:
    return f"{phone.lstrip('+')}@s.whatsapp.net"


async def _make_session(user_id: str = TEST_USER) -> str:
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(
            user_id=user_id,
            gateway_id=gw_id,
            session_name=f"A523-{gw_id[:8]}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        ))
        await db.commit()
    return gw_id


def _event(gw_id, jid, wa_id, *, event_id=None, upsert_type="append",
           body="Merhaba", created_at="2025-01-15T10:00:00Z",
           direction="INBOUND"):
    message = {
        "body": body,
        "direction": direction,
        "message_type": "TEXT",
        "wa_message_id": wa_id,
        "created_at": created_at,
    }
    event = {
        "event": "message_new",
        "gateway_session_id": gw_id,
        "conversation_id": jid,
        "upsert_type": upsert_type,
        "message": message,
    }
    if event_id:
        event["event_id"] = event_id
    return event


async def _conversation_row(jid: str):
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            text(
                "SELECT c.id, c.unread_count, c.last_message_preview, c.last_message_at "
                "FROM conversations c JOIN contacts k ON k.id = c.contact_id "
                "WHERE k.phone_e164 = :p ORDER BY c.id DESC LIMIT 1"
            ),
            {"p": jid_to_phone(jid)},
        )).first()


async def _message_count(wa_id: str) -> int:
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(func.count()).select_from(Message).where(Message.wa_message_id == wa_id)
        )).scalar_one()


async def _message_rows(wa_id: str):
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(Message.id, Message.body).where(Message.wa_message_id == wa_id)
        )).all()


async def _purge_processed_events(event_ids) -> None:
    """Yarışta kullanılan `event_id`'leri idempotency tablosundan siler.

    `ingest_gateway_event` her `event_id`'yi `whatsapp_private.processed_events`
    tablosuna yazar. Bu tablo iş verisi değil, ama test artığıdır: silinmezse
    aynı `event_id` ile ikinci koşu "duplicate" sayılırdı. Yalnızca bu testin
    kimlikleri silinir — tablo tümden boşaltılmaz (paylaşılan bir DB'de bu,
    başka bir koşunun idempotency kaydını uçururdu).
    """
    ids = [e for e in event_ids if e]
    if not ids:
        return
    async with AsyncSessionLocal() as db:
        for eid in ids:
            await db.execute(
                text("DELETE FROM whatsapp_private.processed_events WHERE event_id = :e"),
                {"e": eid},
            )
        await db.commit()


async def _purge(jid: str, gw_id: str) -> None:
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


async def _bootstrap_live_conversation(gw_id: str, jid: str) -> int:
    """Konuşmayı CANLI bir `notify` ile kurar (önizleme + zaman damgası + rozet).

    Append yarışı bu satırın ÜZERİNE kurulur; böylece "append önizlemeyi ileri
    taşımadı" iddiası, taşınabilecek bir önizleme varken ölçülür.
    """
    live_id = f"a523-live-{_uuid.uuid4()}"
    await whatsapp_service.ingest_gateway_event(
        _event(gw_id, jid, live_id, upsert_type="notify", created_at="2026-01-01T00:00:00Z")
    )
    row = await _conversation_row(jid)
    assert row is not None, "canlı mesaj konuşmayı kurmadı"
    return row[0]


async def _wait_until_insert_blocked(timeout: float = 10.0) -> tuple:
    """B'nin INSERT üzerinde kilitlendiğini `pg_stat_activity`'den doğrular.

    Bu bekleme yarışı ÜRETMEZ; yarış zaten kurulmuştur. Yalnızca "A'yı şimdi
    serbest bırakırsam B gerçekten INSERT'in içinde bekliyor olacak" kanıtıdır.
    Aradığımız durum: aktif + kilit bekleyen + `INSERT INTO messages`.
    A bu sırada Python tarafında beklediği için `idle in transaction`'dır ve
    bu filtreye girmez; dolayısıyla eşleşme tekildir.

    Dönen demet raporun kanıtıdır: (pid, wait_event, query kırpıntısı).
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        async with AsyncSessionLocal() as db:
            row = (await db.execute(text(
                "SELECT pid, wait_event_type, wait_event, left(query, 70) "
                "FROM pg_stat_activity "
                "WHERE wait_event_type = 'Lock' AND state = 'active' "
                "AND query ILIKE '%INSERT INTO messages%' "
                "ORDER BY query_start LIMIT 1"
            ))).first()
        if row is not None:
            print(f"\n[KANIT] B kilitli: pid={row[0]} {row[1]}/{row[2]} query={row[3]!r}")
            return tuple(row)
        await asyncio.sleep(0.02)
    raise AssertionError(
        "B INSERT üzerinde kilitlenmedi — yarış kurulamadı (test başarısız sayılır)"
    )


async def _count_idle_in_transaction() -> int:
    async with AsyncSessionLocal() as db:
        return (await db.execute(text(
            "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'"
        ))).scalar_one()


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


class _WebhookSpy:
    """`WebhookDispatcher.emit` yerine geçer; çağrıları sayar.

    `events.py` sınıfı modül globali olarak kullanır, bu yüzden modül
    attribute'unu değiştirmek yeterlidir — üretim kodu değişmez.
    """

    calls: list[dict] = []

    @classmethod
    def emit(cls, user_id=None, event_type=None, data=None) -> None:
        cls.calls.append({"user_id": user_id, "event_type": event_type, "data": data})

    @classmethod
    def reset(cls) -> None:
        cls.calls = []


def _acks(sock) -> list[dict]:
    return [m for m in sock.sent if m.get("type") == "gateway_event_ack"]


def _nacks(sock) -> list[dict]:
    return [m for m in sock.sent if m.get("type") == "gateway_event_nack"]


# ---------------------------------------------------------------------------
# 0. Gerçekten PostgreSQL'e mi bağlıyız? (skip/fallback değil)
# ---------------------------------------------------------------------------
async def test_engine_is_really_postgresql():
    """Testlerin gerçekten PostgreSQL'e bağlandığını POZİTİF olarak kanıtlar.

    Neden ayrı bir test: modül düzeyindeki `skipif` yalnızca URL'e bakar ve
    "skip oldu" ile "gerçekten PG'ye koştu" aynı renkte görünmez. Burada sunucuya
    soruyoruz: dialect adı `postgresql` mi, `version()` PostgreSQL diyor mu,
    ve `inet_server_addr()` gerçekten yerel loopback mı?

    Aynı zamanda yarış testlerinin sessizce SQLite'a düşmediğinin kanıtıdır:
    SQLite'ta `select version()` diye bir şey yoktur.
    """
    from backend.app.core.database import engine

    assert engine.dialect.name == "postgresql", (
        f"engine dialect {engine.dialect.name!r} — PostgreSQL bekleniyordu"
    )
    async with AsyncSessionLocal() as db:
        version = (await db.execute(text("select version()"))).scalar_one()
        addr = (await db.execute(text("select host(inet_server_addr())"))).scalar_one()
        dbname = (await db.execute(text("select current_database()"))).scalar_one()
        backend_pid = (await db.execute(text("select pg_backend_pid()"))).scalar_one()
    assert version.startswith("PostgreSQL"), f"beklenen PostgreSQL, gelen: {version!r}"
    assert addr == "127.0.0.1", f"sunucu adresi {addr!r} — yerel olmalı"
    print(
        f"\n[KANIT] gerçek PG bağlantısı: db={dbname} addr={addr} "
        f"pid={backend_pid} version={version.split(',')[0]}"
    )


# ---------------------------------------------------------------------------
# 1. Hangi kısıt ihlal ediliyor? — ham iki transaction ile literal kanıt
# ---------------------------------------------------------------------------
async def test_raw_unique_violation_names_the_constraint():
    """Aynı (conversation_id, wa_message_id) için PostgreSQL'in verdiği hüküm.

    Ürün kodunu değil, VERİTABANINI ölçer: yarışta ihlal edilen kısıtın adını
    tahmin etmek yerine PostgreSQL'in kendi mesajından okuruz. Bu ad, ürün
    kodundaki `except IntegrityError` dalının yakaladığı hatanın ta kendisidir.
    """
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    try:
        conv_id = await _bootstrap_live_conversation(gw_id, jid)
        wa_id = f"a523-raw-{_uuid.uuid4()}"

        inserted = asyncio.Event()
        release = asyncio.Event()

        def _row() -> Message:
            return Message(
                user_id=TEST_USER,
                conversation_id=conv_id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="ham yaris",
                wa_message_id=wa_id,
                recipient_phone="ME",
                status=ConversationMessageStatus.RECEIVED,
            )

        async def winner() -> None:
            async with AsyncSessionLocal() as db:
                db.add(_row())
                await db.flush()          # INSERT yayınlandı, COMMIT YOK
                inserted.set()
                await release.wait()
                await db.commit()

        async def loser():
            await inserted.wait()
            async with AsyncSessionLocal() as db:
                db.add(_row())
                try:
                    await db.flush()
                    await db.commit()
                    return None
                except IntegrityError as exc:      # noqa: BLE001 - kanıt topluyoruz
                    await db.rollback()
                    return exc

        win_task = asyncio.create_task(winner())
        await asyncio.wait_for(inserted.wait(), timeout=10)
        lose_task = asyncio.create_task(loser())
        await _wait_until_insert_blocked()
        release.set()
        await asyncio.wait_for(win_task, timeout=15)
        exc = await asyncio.wait_for(lose_task, timeout=15)

        assert exc is not None, "ikinci INSERT hata almadı — kısıt yok demektir"
        message = str(getattr(exc, "orig", exc))
        print(f"\n[KANIT] PostgreSQL hata metni: {message}")
        assert "uq_msg_conv_wa_message_id" in message, (
            f"beklenen kısıt ihlal edilmedi: {message}"
        )
        # Aynı satırın iki kez yazılmadığı, DB'nin kendi sayımıyla:
        assert await _message_count(wa_id) == 1
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 2. Gerçek yarış: köprü ucundan iki eşzamanlı append
# ---------------------------------------------------------------------------
async def test_append_race_takes_integrity_error_path(monkeypatch, caplog):
    """Kazanan A, kaybeden B; B GERÇEKTEN `IntegrityError` alır ve kurtarılır.

    Ölçülen sözleşme:
      * tek DB satırı,
      * B `_no_broadcast=True` ile güvenli sonuç döner (NACK yok, ACK var),
      * hiç canlı yayın yok (iki olay da append),
      * rozet/önizleme/zaman damgası ileri taşınmaz,
      * kurtarma sonrası oturum kullanılabilir kalır.
    """
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    caplog.set_level(logging.INFO, logger=_EVENTS_LOGGER)

    try:
        await _bootstrap_live_conversation(gw_id, jid)
        before = await _conversation_row(jid)
        assert before is not None
        conv_id, unread_before, preview_before, ts_before = before
        assert unread_before == 1, f"canlı notify rozeti artırmadı: {unread_before}"

        wa_id = f"a523-race-{_uuid.uuid4()}"
        ev_a = _event(gw_id, jid, wa_id, event_id=str(_uuid.uuid4()),
                      body="gecmis mesaj")
        ev_b = _event(gw_id, jid, wa_id, event_id=str(_uuid.uuid4()),
                      body="gecmis mesaj")

        # --- Bekletme noktası: INSERT ile commit arasındaki gerçek await ---
        original_preview = events_module._preview_for_text_message
        inserted = asyncio.Event()
        release = asyncio.Event()
        held = {"once": False}

        async def held_preview(db, body, user_id=None, conversation_id=None):
            if not held["once"]:
                held["once"] = True
                inserted.set()      # "satır INSERT edildi, commit edilmedi"
                await release.wait()
            return await original_preview(
                db, body, user_id=user_id, conversation_id=conversation_id
            )

        monkeypatch.setattr(events_module, "_preview_for_text_message", held_preview)

        # Köprünün gerçek kararını saymak için broadcast'i gözetliyoruz.
        broadcast = AsyncMock()
        monkeypatch.setattr(ws_manager, "broadcast", broadcast)

        # Dış webhook: append hiçbir zaman `whatsapp.message_received` üretmemeli.
        _WebhookSpy.reset()
        monkeypatch.setattr(events_module, "WebhookDispatcher", _WebhookSpy)

        # Her olayın ingest sonucunu olay kimliğiyle eşleştir.
        real_ingest = whatsapp_service.ingest_gateway_event
        results: dict[str, dict] = {}

        async def spy_ingest(ev):
            res = await real_ingest(ev)
            results[str(ev.get("event_id"))] = res
            return res

        monkeypatch.setattr(whatsapp_service, "ingest_gateway_event", spy_ingest)

        sock_a = _FakeGatewaySocket(ev_a)
        sock_b = _FakeGatewaySocket(ev_b)

        task_a = asyncio.create_task(
            gateway_websocket_endpoint(sock_a, token=TEST_GATEWAY_SECRET)
        )
        await asyncio.wait_for(inserted.wait(), timeout=15)   # A: INSERT edildi, bekliyor

        task_b = asyncio.create_task(
            gateway_websocket_endpoint(sock_b, token=TEST_GATEWAY_SECRET)
        )
        await _wait_until_insert_blocked()                    # B: INSERT'te kilitli

        release.set()                                          # A commit eder
        await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=30)

        # ---------------- ASSERTION'LAR ----------------
        # 1) Tek satır
        assert await _message_count(wa_id) == 1, "yarış iki satır üretti"
        rows = await _message_rows(wa_id)
        winner_id, winner_body = rows[0]
        assert winner_body == "gecmis mesaj"

        # 2) IntegrityError yolu GERÇEKTEN çalıştı: log satırı yalnızca
        #    `except IntegrityError` dalında üretilir ve tam olarak bir kez.
        race_logs = [
            r for r in caplog.records
            if r.name == _EVENTS_LOGGER and _RACE_LOG_FRAGMENT in r.getMessage()
            and wa_id in r.getMessage()
        ]
        assert len(race_logs) == 1, (
            f"IntegrityError dalı tam bir kez çalışmadı (adet={len(race_logs)})"
        )

        # 3) Her iki taraf da güvenli sonuç döndü ve append işaretini taşıdı
        res_a = results.get(ev_a["event_id"])
        res_b = results.get(ev_b["event_id"])
        for label, res in (("A", res_a), ("B", res_b)):
            assert isinstance(res, dict), f"{label} sözlük döndürmedi: {res!r}"
            assert not res.get("_skip"), f"{label} beklenmedik şekilde atlandı"
            assert res.get("_no_broadcast") is True, (
                f"{label} append için yayın bastırma işareti taşımıyor"
            )
        # Kurtarma kazanan satırı yeniden okur: kimlik kazananla aynı olmalı.
        assert res_b.get("message", {}).get("id") == winner_id or \
            res_a.get("message", {}).get("id") == winner_id

        # 4) Hiç canlı yayın yok
        broadcast.assert_not_awaited()

        # 5) ACK var, NACK yok
        assert _acks(sock_a) == [{"type": "gateway_event_ack", "event_id": ev_a["event_id"]}]
        assert _acks(sock_b) == [{"type": "gateway_event_ack", "event_id": ev_b["event_id"]}]
        assert _nacks(sock_a) == [] and _nacks(sock_b) == []

        # 6) Rozet / önizleme / zaman damgası ileri taşınmadı
        after = await _conversation_row(jid)
        assert after is not None
        _, unread_after, preview_after, ts_after = after
        assert unread_after == unread_before, (
            f"append rozeti artırdı: {unread_before} -> {unread_after}"
        )
        assert preview_after == preview_before, (
            f"append önizlemeyi oynattı: {preview_before!r} -> {preview_after!r}"
        )
        assert ts_after == ts_before, (
            f"append son aktiviteyi oynattı: {ts_before} -> {ts_after}"
        )

        # 7) Dış webhook ikinci kez (ve hiç) gönderilmedi
        assert _WebhookSpy.calls == [], (
            f"append dış webhook üretti: {_WebhookSpy.calls}"
        )

        # 8) Oturum/transaction kullanılabilir: kurtarma SELECT'i çalıştı
        #    (çalışmasaydı `InFailedSQLTransactionError` olurdu) ve geride
        #    kilitli/aborted transaction kalmadı.
        await asyncio.sleep(0)
        assert await _count_idle_in_transaction() == 0, (
            "yarış sonrası aborted/idle-in-transaction oturum kaldı"
        )
        assert conv_id == after[0]

        print(
            "\n[KANIT] yarış kuruldu: kazanan satır id=%s, A sonucu id=%s, B sonucu id=%s"
            % (winner_id,
               (res_a.get("message") or {}).get("id"),
               (res_b.get("message") or {}).get("id"))
        )
        print(
            "[KANIT] IntegrityError dalı=%d kez · broadcast=%d · "
            "ACK(A)=%s ACK(B)=%s · NACK=%d"
            % (len(race_logs), broadcast.await_count,
               _acks(sock_a), _acks(sock_b),
               len(_nacks(sock_a)) + len(_nacks(sock_b)))
        )
        print(
            "[KANIT] rozet %s->%s · önizleme korundu=%s · ts korundu=%s · webhook=%d"
            % (unread_before, unread_after,
               preview_after == preview_before, ts_after == ts_before,
               len(_WebhookSpy.calls))
        )

        # 9) Temizlik: bu testin satırları silindi (finally yalnızca güvenlik ağı)
        await _purge(jid, gw_id)
        await _purge_processed_events([ev_a["event_id"], ev_b["event_id"]])
        assert await _message_count(wa_id) == 0, "temizlik sonrası mesaj satırı kaldı"
        assert await _conversation_row(jid) is None, "temizlik sonrası konuşma kaldı"
        print("[KANIT] temizlik: mesaj=0, konuşma=yok, processed_events=0")
    finally:
        await _purge(jid, gw_id)


# ---------------------------------------------------------------------------
# 3. Aynı yarış, NOTIFY tarafında: kontrol grubu
# ---------------------------------------------------------------------------
async def test_notify_race_still_broadcasts_the_winner(monkeypatch, caplog):
    """Aynı yarış `notify` ile kurulduğunda canlı davranış korunur.

    Neden gerekli: `_no_broadcast` yalnızca append'e bağlıysa, notify yarışında
    kazanan satır hâlâ yayınlanmalı ve rozet artmalıdır. Bu test, yarış
    mekanizmasının kendisinin notify davranışını bozmadığını gösterir.
    """
    phone = _new_identity()
    jid = _jid_for(phone)
    gw_id = await _make_session()
    caplog.set_level(logging.INFO, logger=_EVENTS_LOGGER)

    try:
        await _bootstrap_live_conversation(gw_id, jid)
        before = await _conversation_row(jid)
        _, unread_before, _, _ = before

        wa_id = f"a523-notify-{_uuid.uuid4()}"
        ev_a = _event(gw_id, jid, wa_id, event_id=str(_uuid.uuid4()),
                      upsert_type="notify", body="canli mesaj")
        ev_b = _event(gw_id, jid, wa_id, event_id=str(_uuid.uuid4()),
                      upsert_type="notify", body="canli mesaj")

        original_preview = events_module._preview_for_text_message
        inserted = asyncio.Event()
        release = asyncio.Event()
        held = {"once": False}

        async def held_preview(db, body, user_id=None, conversation_id=None):
            if not held["once"]:
                held["once"] = True
                inserted.set()
                await release.wait()
            return await original_preview(
                db, body, user_id=user_id, conversation_id=conversation_id
            )

        monkeypatch.setattr(events_module, "_preview_for_text_message", held_preview)

        broadcast = AsyncMock()
        monkeypatch.setattr(ws_manager, "broadcast", broadcast)

        _WebhookSpy.reset()
        monkeypatch.setattr(events_module, "WebhookDispatcher", _WebhookSpy)

        real_ingest = whatsapp_service.ingest_gateway_event
        results: dict[str, dict] = {}

        async def spy_ingest(ev):
            res = await real_ingest(ev)
            results[str(ev.get("event_id"))] = res
            return res

        monkeypatch.setattr(whatsapp_service, "ingest_gateway_event", spy_ingest)

        sock_a = _FakeGatewaySocket(ev_a)
        sock_b = _FakeGatewaySocket(ev_b)

        task_a = asyncio.create_task(
            gateway_websocket_endpoint(sock_a, token=TEST_GATEWAY_SECRET)
        )
        await asyncio.wait_for(inserted.wait(), timeout=15)
        task_b = asyncio.create_task(
            gateway_websocket_endpoint(sock_b, token=TEST_GATEWAY_SECRET)
        )
        await _wait_until_insert_blocked()
        release.set()
        await asyncio.wait_for(asyncio.gather(task_a, task_b), timeout=30)

        # Tek satır + IntegrityError bir kez
        assert await _message_count(wa_id) == 1
        race_logs = [
            r for r in caplog.records
            if r.name == _EVENTS_LOGGER and _RACE_LOG_FRAGMENT in r.getMessage()
            and wa_id in r.getMessage()
        ]
        assert len(race_logs) == 1, (
            f"notify yarışında IntegrityError dalı çalışmadı (adet={len(race_logs)})"
        )

        # Kazanan yayınlanır; kaybeden de yayınlanır (append değil!)
        assert broadcast.await_count >= 1, "notify kazananı yayınlanmadı"
        for label, res in (("A", results.get(ev_a["event_id"])),
                           ("B", results.get(ev_b["event_id"]))):
            assert isinstance(res, dict)
            assert res.get("_no_broadcast") is None, (
                f"{label} notify için yayın bastırma işareti taşıyor"
            )

        # Rozet artar (canlı davranış korunur)
        after = await _conversation_row(jid)
        assert after[1] > unread_before, (
            f"notify rozeti artırmadı: {unread_before} -> {after[1]}"
        )

        # Dış webhook notify için ÇALIŞIR — append testinde çalışmaması bu
        # kontrolün anlamlı olduğunu gösterir (aksi halde "hiç çağrılmadı"
        # iddiası, webhook yolunun hiç kurulmadığını da gösteremezdi).
        assert any(
            c["event_type"] == "whatsapp.message_received" for c in _WebhookSpy.calls
        ), f"notify dış webhook üretmedi: {_WebhookSpy.calls}"

        print(
            "\n[KANIT] notify yarışı: IntegrityError=%d · broadcast=%d · "
            "rozet %s->%s · webhook=%d"
            % (len(race_logs), broadcast.await_count,
               unread_before, after[1], len(_WebhookSpy.calls))
        )

        await _purge(jid, gw_id)
        await _purge_processed_events([ev_a["event_id"], ev_b["event_id"]])
        assert await _message_count(wa_id) == 0
        assert await _conversation_row(jid) is None
    finally:
        await _purge(jid, gw_id)
