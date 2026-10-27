"""Event idempotency: ayni `event_id` iki kez islenmemeli.

Neden gerekli
-------------
`event_outbox` bir olayi teslim edene kadar yeniden dener (attempts>=10 ->
DEAD_LETTER). Yeniden deneme, ayni olayin backend'e **birden fazla kez**
ulasmasi demektir: ACK kaybolursa gateway ayni satiri tekrar gonderir. Bu
tekrarlar bastirilmazsa her deneme yeni bir mesaj/sohbet yazar.

Idempotency IKI katmanlidir ve bu ayrim onemli:

1. **Surec-ici LRU** (`_RECENT_PROCESSED_EVENT_IDS`, 10 000 kayit) — her
   lehcede calisir, surec yeniden baslayinca kaybolur.
2. **`whatsapp_private.processed_events`** — kalici, ama kodu yalnizca
   `dialect.name == "postgresql"` iken calisir.

Yani SQLite testleri 1. katmani olcer; 2. katman burada KOSMAZ. Bu dosya bunu
gizlemez: kalici katmanin test edilmedigini `test_db_layer_is_postgres_only`
acikca civiler. Uretim PostgreSQL'dir; orada iki katman birlikte calisir.
"""

from __future__ import annotations

import uuid

import pytest

from backend.app.services.whatsapp.orchestration import events as ev
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _clear_recently_processed_events_cache,
    _is_recently_processed_event,
    _mark_recently_processed_event,
)


@pytest.fixture(autouse=True)
def _clean_cache():
    _clear_recently_processed_events_cache()
    yield
    _clear_recently_processed_events_cache()


class TestRecentEventCache:
    def test_marked_event_is_recognised(self):
        eid = str(uuid.uuid4())
        assert _is_recently_processed_event(eid) is False
        _mark_recently_processed_event(eid)
        assert _is_recently_processed_event(eid) is True

    def test_marking_twice_does_not_duplicate(self):
        eid = str(uuid.uuid4())
        _mark_recently_processed_event(eid)
        _mark_recently_processed_event(eid)
        assert len(ev._RECENT_PROCESSED_EVENT_IDS) == 1

    def test_cache_is_bounded_and_evicts_oldest(self):
        # Sinirsiz bir "islenmis olay" kumesi bir sure sonra bellek sizintisidir.
        capacity = ev._RECENT_PROCESSED_EVENT_IDS.maxlen
        assert capacity is not None and capacity > 0
        ids = [str(uuid.uuid4()) for _ in range(capacity + 5)]
        for eid in ids:
            _mark_recently_processed_event(eid)
        assert len(ev._RECENT_PROCESSED_EVENT_IDS) == capacity
        assert len(ev._RECENT_PROCESSED_EVENT_SET) == capacity
        assert _is_recently_processed_event(ids[0]) is False, "en eski kayit dusmeli"
        assert _is_recently_processed_event(ids[-1]) is True

    def test_clear_empties_both_structures(self):
        # Iki yapi ayrisirsa `in` kontrolu ile deque farkli sey soyler.
        _mark_recently_processed_event(str(uuid.uuid4()))
        _clear_recently_processed_events_cache()
        assert len(ev._RECENT_PROCESSED_EVENT_IDS) == 0
        assert len(ev._RECENT_PROCESSED_EVENT_SET) == 0


class TestDuplicateShortCircuitsBeforeAnyDbWork:
    @pytest.mark.asyncio
    async def test_a_duplicate_event_id_never_opens_a_session(self, monkeypatch):
        """Tekrar gelen olay DB'ye HIC inmemeli.

        LRU isabet ederse `AsyncSessionLocal` hic cagrilmaz. Bunu, cagrilirsa
        patlayan bir fabrika ile olcuyoruz: patlamiyorsa gercekten kisa yol
        calismis demektir.
        """
        eid = str(uuid.uuid4())
        _mark_recently_processed_event(eid)

        def _explode(*_a, **_k):
            raise AssertionError("tekrar olay icin DB oturumu acilmamali")

        monkeypatch.setattr(ev, "AsyncSessionLocal", _explode)

        result = await WhatsAppEventOrchestrator().ingest_gateway_event(
            {"event": "message_new", "event_id": eid, "gateway_session_id": "gw-x"}
        )

        assert result == {"_duplicate": True, "event_id": eid}

    @pytest.mark.asyncio
    async def test_an_invalid_event_id_is_rejected_not_processed(self):
        # Bozuk kimlik "yeni olay" sayilmamali: sessizce islenirse idempotency
        # defteri de tutmaz.
        result = await WhatsAppEventOrchestrator().ingest_gateway_event(
            {"event": "message_new", "event_id": "not-a-uuid", "gateway_session_id": "gw-x"}
        )
        assert result is None


class TestPersistenceLayerHonesty:
    def test_db_layer_is_postgres_only(self):
        """Kalici katman yalnizca PostgreSQL'de calisir — bu bir gercek.

        SQLite'ta `processed_events` sorgusu atlanir; yani test paketinin
        yesil olmasi kalici idempotency'yi KANITLAMAZ. Bu kapi, birinin
        "testler geciyor" diyerek o katmani var saymasini engeller.
        """
        import inspect

        src = inspect.getsource(ev.WhatsAppEventOrchestrator.ingest_gateway_event)
        assert 'dialect.name == "postgresql"' in src
        assert "processed_events" in src
