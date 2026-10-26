"""Eşleşme (pairing) token'ı tüketildikten SONRA gelen poll 404 almamalı.

Canlı arıza (2026-10-27, prod): tarayıcı 2,5 sn'lik yedek poll'u ile
`GET /api/v1/whatsapp/pairing/{token}/qr` adresini sormaya devam ediyor. Token
başarılı promosyonda tüketildiği için bir sonraki poll `LookupError` → 404
alıyordu; modal bunu üst üste sayıp HAT GERÇEKTEN BAĞLANMIŞKEN "bağlantı
kurulamadı" hatasına kadar gidebiliyordu. Ölçüm: 6 saatte 2 kez 404.

Çözüm: tüketilen token'ın terminal sonucu bir "mezar" (tombstone) olarak
saklanır; poll 404 yerine CONNECTED alır. Mezar kiracı kapsamlıdır ve
bellek-içidir (restart → davranış bugünkü 404'e düşer, yani en kötü durum
statükodur).
"""
import pytest

from backend.app.services.whatsapp.orchestration import sessions as sessions_mod


@pytest.fixture(autouse=True)
def _isolate_pairing_registries():
    """Modül düzeyindeki sözlükleri her testten sonra eski haline döndür.

    `pytest-randomly` kurulu: sızan bir mezar başka bir testi sessizce
    yeşillendirebilir/bozabilir.
    """
    ephemeral = dict(sessions_mod._ephemeral_pairings)
    consumed = dict(sessions_mod._consumed_pairings)
    yield
    sessions_mod._ephemeral_pairings.clear()
    sessions_mod._ephemeral_pairings.update(ephemeral)
    sessions_mod._consumed_pairings.clear()
    sessions_mod._consumed_pairings.update(consumed)


@pytest.mark.asyncio
async def test_consumed_token_returns_connected_instead_of_404():
    token = "tok-consumed"
    sessions_mod._remember_consumed_pairing(
        token, user_id="u-1", session_id=42, phone="+905550000042"
    )

    # db=None: tüketilmiş token dalı DB'ye ve gateway'e HİÇ dokunmadan döner.
    data = await sessions_mod.get_pairing_qr(None, "u-1", token)  # type: ignore[arg-type]

    assert data["status"] == "CONNECTED"
    assert data["session_id"] == 42
    assert data["phone"] == "+905550000042"
    assert data["qr_code"] is None


@pytest.mark.asyncio
async def test_consumed_token_is_tenant_scoped():
    token = "tok-other-tenant"
    sessions_mod._remember_consumed_pairing(
        token, user_id="u-1", session_id=7, phone="+905550000007"
    )

    with pytest.raises(LookupError):
        await sessions_mod.get_pairing_qr(None, "u-2", token)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_unknown_token_still_raises_lookup_error():
    with pytest.raises(LookupError):
        await sessions_mod.get_pairing_qr(None, "u-1", "never-existed")  # type: ignore[arg-type]


def test_remove_ephemeral_pairing_records_tombstone():
    """Olay yolu (connection.open) token'ı tükettiğinde de mezar yazılmalı.

    Promosyonu genellikle poll'den ÖNCE olay yolu kazanıyor; mezar yalnızca
    `get_pairing_qr` içinde yazılsaydı hiç devreye girmez ve 404 devam ederdi.
    """
    token = "tok-event-path"
    sessions_mod._ephemeral_pairings[token] = {
        "gateway_id": "gw-event-1",
        "user_id": "u-1",
        "session_name": "S",
    }

    sessions_mod.remove_ephemeral_pairing_by_gateway_id(
        "gw-event-1", session_id=99, phone="+905550000099"
    )

    assert token not in sessions_mod._ephemeral_pairings
    consumed = sessions_mod._consumed_pairings[token]
    assert consumed["session_id"] == 99
    assert consumed["phone"] == "+905550000099"
    assert consumed["user_id"] == "u-1"


def test_cancel_path_records_no_tombstone():
    """İptal edilen eşleşme CONNECTED gibi görünmemeli."""
    token = "tok-cancelled"
    sessions_mod._ephemeral_pairings[token] = {
        "gateway_id": "gw-cancel-1",
        "user_id": "u-1",
        "session_name": "S",
    }

    sessions_mod.remove_ephemeral_pairing_by_gateway_id("gw-cancel-1")

    assert token not in sessions_mod._ephemeral_pairings
    assert token not in sessions_mod._consumed_pairings


def test_tombstone_store_is_bounded():
    sessions_mod._consumed_pairings.clear()
    for i in range(sessions_mod._CONSUMED_PAIRINGS_MAX + 10):
        sessions_mod._remember_consumed_pairing(
            f"tok-{i}", user_id="u-1", session_id=i, phone=None
        )
    assert len(sessions_mod._consumed_pairings) <= sessions_mod._CONSUMED_PAIRINGS_MAX
    # En yeni kayıt her zaman durur.
    assert f"tok-{sessions_mod._CONSUMED_PAIRINGS_MAX + 9}" in sessions_mod._consumed_pairings
