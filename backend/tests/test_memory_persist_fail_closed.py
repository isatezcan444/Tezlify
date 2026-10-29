"""Faz 3.8.1 — kalicilastirma kill-switch'i FAIL-CLOSED olmali.

NEDEN BU DOSYA VAR
------------------
Asama 3.8'de olculen hata bir "yanlis deger" hatasi degildi: flag hicbir yerde
YOKTU. Kodun varsayilani `True` oldugu icin yokluk "acik" anlamina geliyordu ve
backend acilistan ~90 sn sonra kendiliginden yazmaya basliyordu. Aday container
bunu daha da kotulestiriyordu: env'i CANLI container'dan kopyaladigi icin
`.env.production`da yapilan bir duzeltme adaciga HIC ulasmiyordu.

Sozlesme artik su:
  * flag YOK        -> KAPALI
  * flag cozulemez  -> KAPALI (servis ayakta kalir, yazma baslamaz)
  * flag `false`    -> KAPALI
  * flag `true`     -> ACIK (tek yol)

Bu dosya o sozlesmeyi ve `/health` uzerinden ETKIN degerin gorunur oldugunu
pinler.
"""

from __future__ import annotations

import pytest

from backend.app.core.config import Settings
from backend.app.services.whatsapp import memory_persistence as mp

FLAG = "WHATSAPP_MEMORY_PERSIST_ENABLED"


def _settings(**kwargs) -> Settings:
    """`.env` dosyasini devre disi birakarak Settings kurar.

    Gercek `.env` bu makinede farkli olabilir; test ondan etkilenmemeli.
    """
    return Settings(_env_file=None, **kwargs)


# ---------------------------------------------------------------------------
# Varsayilan ve cozumleme
# ---------------------------------------------------------------------------
def test_default_is_off(monkeypatch):
    """Flag hic verilmezse KAPALI olmali — 'yokluk' bir guvenlik karari degil."""
    monkeypatch.delenv(FLAG, raising=False)
    assert _settings().WHATSAPP_MEMORY_PERSIST_ENABLED is False


@pytest.mark.parametrize("raw", ["true", "TRUE", "1", "yes", "on", " true "])
def test_explicit_true_enables(monkeypatch, raw):
    monkeypatch.delenv(FLAG, raising=False)
    assert _settings(**{FLAG: raw}).WHATSAPP_MEMORY_PERSIST_ENABLED is True


@pytest.mark.parametrize("raw", ["false", "FALSE", "0", "no", "off", ""])
def test_explicit_false_or_empty_disables(monkeypatch, raw):
    monkeypatch.delenv(FLAG, raising=False)
    assert _settings(**{FLAG: raw}).WHATSAPP_MEMORY_PERSIST_ENABLED is False


@pytest.mark.parametrize("raw", ["truely", "evet", "2", "enable", "acik"])
def test_unparseable_falls_back_to_off(monkeypatch, raw):
    """Cozulemeyen deger uygulamayi DUSURMEZ; yalnizca supurmeyi kapatir.

    Pydantic'in kendi bool cozumlemesi burada `ValidationError` firlatirdi ve
    backend'in tamami acilmazdi. Istenen bu degil: servis ayakta kalmali,
    otomatik YAZMA baslamamali.
    """
    monkeypatch.delenv(FLAG, raising=False)
    assert _settings(**{FLAG: raw}).WHATSAPP_MEMORY_PERSIST_ENABLED is False


# ---------------------------------------------------------------------------
# Calisma zamani: flag kapaliyken tur yazmaz
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_run_once_is_a_noop_when_flag_is_off(monkeypatch):
    """Kill-switch yalnizca lifespan'de degil, turun ICINDE de okunmali."""
    monkeypatch.setattr(mp.settings, FLAG, False, raising=False)
    mp.reset_memory_persistence_state()

    called = {"n": 0}

    async def _boom(*a, **k):  # pragma: no cover - cagrilirsa test patlar
        called["n"] += 1
        raise AssertionError("flag kapaliyken gateway'e gidilmemeli")

    monkeypatch.setattr(mp.gw, "list_all_messages", _boom)

    assert await mp.run_memory_persistence_once(dry_run=False) == []
    assert called["n"] == 0


# ---------------------------------------------------------------------------
# /health: ETKIN deger gorunur olmali
# ---------------------------------------------------------------------------
def test_status_exposes_effective_config_value(monkeypatch):
    """Deploy dogrulamasi `_STATE["enabled"]`e guvenemez: o alan tur kosmadan
    dolmaz ve `None` 'hic kosmadi' ile 'kapali' arasinda ayrim yapmaz."""
    monkeypatch.setattr(mp.settings, FLAG, False, raising=False)
    mp.reset_memory_persistence_state()
    status = mp.memory_persistence_status()
    assert status["config_enabled"] is False
    assert status["task_running"] is False


def test_status_reports_true_when_enabled(monkeypatch):
    monkeypatch.setattr(mp.settings, FLAG, True, raising=False)
    mp.reset_memory_persistence_state()
    assert mp.memory_persistence_status()["config_enabled"] is True


def test_health_payload_carries_the_flag_without_leaking(monkeypatch):
    """/health PII sizdirmamali; yalnizca bool tasimali."""
    monkeypatch.setattr(mp.settings, FLAG, False, raising=False)
    mp.reset_memory_persistence_state()
    from backend.app.main import _memory_persistence_status

    payload = _memory_persistence_status()
    assert payload["config_enabled"] is False
    assert "cursors" not in payload
