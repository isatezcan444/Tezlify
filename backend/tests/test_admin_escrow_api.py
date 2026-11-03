"""Encryption Key Escrow panelinin HTTP sozlesmesi.

Odak "calisiyor mu" degil, **"anahtar disari sizabilir mi"**:

* Yetkisiz (anonim / admin-ama-super-degil) hicbir yol anahtari goremez.
* Anahtar `/status` yanitinda, denetim kaydinda ve hata govdesinde YOKTUR.
* Goruntuleme tek kullanimliktir: ayni grant ile ikinci kez alinamaz.
* Panel kapaliyken uç nokta 404 doner (varligini sizdirmaz).

Testler gercek `require_super_admin` kapisini calistirir; yalnizca oturum
cozumleme stub'lanir (mevcut `test_admin_ops_api.py` ile ayni desen).
"""

from __future__ import annotations

import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from backend.app.api.v1.endpoints import escrow as escrow_api
from backend.app.auth.api import dependencies as deps
from backend.app.core.auth import AuthUser
from backend.app.core.config import settings
from backend.app.main import app
from backend.app.services.admin import escrow_service as escrow

# 64 hex: gercek anahtar DEGIL, testte uretilmis bir deger.
TEST_KEY = "0123456789abcdef" * 4
TEST_ANCHOR = hashlib.sha256(TEST_KEY.encode()).hexdigest()[:8]
SUPER = "super@tezlify.test"
PLAIN_ADMIN = "admin@tezlify.test"

AUDIT: list[tuple] = []


def _sink(action, actor, result, operation_id=None, detail=None):
    AUDIT.append((action, actor, result, detail or {}))


@pytest.fixture(autouse=True)
def _clean_state():
    AUDIT.clear()
    escrow.reset_state()
    escrow.set_audit_sink(_sink)
    yield
    escrow.reset_state()
    escrow.set_audit_sink(None)


def _escrow_file(tmp_path, raw: str | None = None, key: str = TEST_KEY):
    path = tmp_path / "tezlify-ram" / ".key-escrow-v2"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"GATEWAY_ENCRYPTION_KEY={key}\n" if raw is None else raw, encoding="utf-8"
    )
    return path


def _settings(monkeypatch, tmp_path, *, enabled=True, emails=(SUPER,), key_path=None,
              reveal_ttl=60, reveal_max=5):
    monkeypatch.setattr(settings, "ESCROW_PANEL_ENABLED", enabled)
    monkeypatch.setattr(settings, "ESCROW_SUPER_ADMIN_EMAILS", list(emails))
    monkeypatch.setattr(settings, "ESCROW_KEY_PATH", str(key_path or _escrow_file(tmp_path)))
    monkeypatch.setattr(settings, "ESCROW_ATTESTATION_PATH", str(tmp_path / "attest.json"))
    monkeypatch.setattr(settings, "ESCROW_REVEAL_TTL_SECONDS", reveal_ttl)
    monkeypatch.setattr(settings, "ESCROW_REVEAL_MAX_PER_HOUR", reveal_max)
    monkeypatch.setattr(settings, "ESCROW_STEPUP_MAX_PER_HOUR", 20)
    monkeypatch.setattr(settings, "ESCROW_STEPUP_TTL_SECONDS", 300)


def _client(email: str = SUPER) -> TestClient:
    def _ok() -> AuthUser:
        return AuthUser(id="u-1", email=email, is_admin=True)

    app.dependency_overrides[deps.get_current_user_unified] = _ok
    return TestClient(app)


@pytest.fixture
def client(monkeypatch, tmp_path):
    _settings(monkeypatch, tmp_path)
    yield _client()
    app.dependency_overrides.clear()


@pytest.fixture
def fake_google(monkeypatch):
    """Google ag cagrisini kaldirir; kimligi test belirler."""
    state = {"email": SUPER}

    async def _identity(code: str):
        return {"email": state["email"], "provider": "google", "provider_subject": "s1"}

    monkeypatch.setattr(escrow_api, "google_identity", _identity)
    return state


def _grant(client: TestClient) -> None:
    """step-up/start -> callback; grant cerezi istemciye yazilir."""
    start = client.post("/api/v1/admin/escrow/step-up/start")
    assert start.status_code == 200, start.text
    state = start.json()["state"]
    cb = client.get(
        f"/api/v1/admin/escrow/step-up/callback?code=c&state={state}",
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert escrow_api.GRANT_COOKIE in client.cookies


# --------------------------------------------------------------------------- #
# Yetki kapisi
# --------------------------------------------------------------------------- #
def test_anonymous_is_rejected(monkeypatch, tmp_path):
    _settings(monkeypatch, tmp_path)
    anon = TestClient(app)
    assert anon.get("/api/v1/admin/escrow/status").status_code == 401
    assert anon.post("/api/v1/admin/escrow/reveal", json={"confirm": True}).status_code == 401


def test_plain_admin_is_forbidden(monkeypatch, tmp_path):
    """ADMIN_EMAILS'te olmak bu paneli ACMAZ: liste ayridir."""
    _settings(monkeypatch, tmp_path, emails=(SUPER,))
    monkeypatch.setattr(settings, "ADMIN_EMAILS", [PLAIN_ADMIN])
    admin = _client(PLAIN_ADMIN)
    assert admin.get("/api/v1/admin/escrow/status").status_code == 403
    app.dependency_overrides.clear()


def test_empty_super_list_fails_closed(monkeypatch, tmp_path):
    _settings(monkeypatch, tmp_path, emails=())
    c = _client(SUPER)
    assert c.get("/api/v1/admin/escrow/status").status_code == 403
    app.dependency_overrides.clear()


def test_panel_disabled_returns_404(monkeypatch, tmp_path):
    """Kapali ozellik varligini sizdirmaz: 403 degil 404."""
    _settings(monkeypatch, tmp_path, enabled=False)
    c = _client(SUPER)
    assert c.get("/api/v1/admin/escrow/status").status_code == 404
    assert c.post("/api/v1/admin/escrow/step-up/start").status_code == 404
    assert c.post("/api/v1/admin/escrow/reveal", json={"confirm": True}).status_code == 404
    app.dependency_overrides.clear()


def test_super_admin_gets_status(client):
    r = client.get("/api/v1/admin/escrow/status")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "PRESENT"
    assert body["anchor8"] == TEST_ANCHOR
    assert body["key_len"] == 64


# --------------------------------------------------------------------------- #
# Durum ayrimi: yok != gorunmuyor
# --------------------------------------------------------------------------- #
def test_unreachable_when_parent_dir_absent(monkeypatch, tmp_path):
    missing_parent = tmp_path / "not-mounted" / ".key-escrow-v2"
    _settings(monkeypatch, tmp_path, key_path=missing_parent)
    c = _client(SUPER)
    body = c.get("/api/v1/admin/escrow/status").json()
    # Dosya "yok" degil, konteyner GOREMIYOR. Bu ayrim yanlis raporlamayi onler.
    assert body["state"] == "UNREACHABLE"
    assert body["reason"] == "parent_dir_not_visible"
    app.dependency_overrides.clear()


def test_missing_when_dir_exists_but_file_absent(monkeypatch, tmp_path):
    target = tmp_path / "tezlify-ram" / ".key-escrow-v2"
    target.parent.mkdir(parents=True, exist_ok=True)
    _settings(monkeypatch, tmp_path, key_path=target)
    c = _client(SUPER)
    assert c.get("/api/v1/admin/escrow/status").json()["state"] == "MISSING"
    app.dependency_overrides.clear()


def test_invalid_when_content_is_not_64_hex(monkeypatch, tmp_path):
    path = _escrow_file(tmp_path, raw="GATEWAY_ENCRYPTION_KEY=zzzz\n")
    _settings(monkeypatch, tmp_path, key_path=path)
    c = _client(SUPER)
    body = c.get("/api/v1/admin/escrow/status").json()
    assert body["state"] == "INVALID"
    assert body["anchor8"] is None
    app.dependency_overrides.clear()


def test_quoted_v1_style_key_is_normalised(monkeypatch, tmp_path):
    """v1 dosyasi tirnaklidir; tirnaklar atilinca ayni capayi vermeli."""
    path = _escrow_file(tmp_path, raw=f'GATEWAY_ENCRYPTION_KEY="{TEST_KEY}"\n')
    _settings(monkeypatch, tmp_path, key_path=path)
    c = _client(SUPER)
    body = c.get("/api/v1/admin/escrow/status").json()
    assert body["state"] == "PRESENT"
    assert body["anchor8"] == TEST_ANCHOR
    app.dependency_overrides.clear()


# --------------------------------------------------------------------------- #
# Anahtar sizintisi
# --------------------------------------------------------------------------- #
def test_status_never_contains_the_key(client):
    r = client.get("/api/v1/admin/escrow/status")
    assert TEST_KEY not in r.text
    assert "key" not in r.json() or r.json().get("key") is None


def test_reveal_without_step_up_is_denied(client):
    r = client.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    assert r.status_code == 403
    assert r.json()["detail"] == "grant_invalid"
    assert TEST_KEY not in r.text


def test_reveal_requires_explicit_confirm(client, fake_google):
    _grant(client)
    r = client.post("/api/v1/admin/escrow/reveal", json={"confirm": False})
    assert r.status_code == 400
    assert r.json()["detail"] == "confirm_true_required"
    assert TEST_KEY not in r.text


def test_reveal_after_step_up_returns_key_once(client, fake_google):
    _grant(client)
    first = client.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    assert first.status_code == 200
    assert first.json()["key"] == TEST_KEY
    assert first.json()["anchor8"] == TEST_ANCHOR
    # Cache yasagi: anahtar paylasilan proxy'de kalmamali.
    assert "no-store" in first.headers["cache-control"]

    # Ayni grant tekrar kullanilamaz.
    second = client.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    assert second.status_code == 403
    assert TEST_KEY not in second.text


def test_expired_grant_is_rejected(monkeypatch, tmp_path, fake_google):
    """Cerez hala tarayicida olsa bile sunucu tarafi suresi gecmis grant'i reddeder.

    Not: `reveal_ttl=0` ile kurmak YANLIS bir test olurdu — `max_age=0` cerezi
    tarayiciya hic yazdirmaz, yani "suresi dolmus grant" degil "grant yok"
    durumunu olcerdik. Bu yuzden grant normal omurle uretilir, sonra yalnizca
    sunucu tarafindaki kaydin suresi gecmis hale getirilir.
    """
    _settings(monkeypatch, tmp_path)
    c = _client(SUPER)
    _grant(c)
    for record in escrow._STATE["grants"].values():
        record["expires_at"] = 0.0

    r = c.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    assert r.status_code == 403
    assert TEST_KEY not in r.text
    app.dependency_overrides.clear()


def test_step_up_identity_mismatch_issues_no_grant(client, fake_google):
    fake_google["email"] = "someone-else@tezlify.test"
    start = client.post("/api/v1/admin/escrow/step-up/start").json()
    cb = client.get(
        f"/api/v1/admin/escrow/step-up/callback?code=c&state={start['state']}",
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert "stepup=denied" in cb.headers["location"]
    assert escrow_api.GRANT_COOKIE not in client.cookies


def test_step_up_state_is_single_use(client, fake_google):
    start = client.post("/api/v1/admin/escrow/step-up/start").json()
    url = f"/api/v1/admin/escrow/step-up/callback?code=c&state={start['state']}"
    client.get(url, follow_redirects=False)
    second = client.get(url, follow_redirects=False)
    assert "stepup=denied" in second.headers["location"]


def test_step_up_url_forces_google_login(client):
    """`prompt=consent` yeterli degil: Google sifre sormadan donebilir."""
    r = client.post("/api/v1/admin/escrow/step-up/start")
    url = r.json()["authorization_url"]
    assert "prompt=login" in url
    assert url.startswith("https://accounts.google.com/")


# --------------------------------------------------------------------------- #
# Hiz siniri
# --------------------------------------------------------------------------- #
def test_reveal_is_rate_limited_per_user(monkeypatch, tmp_path, fake_google):
    _settings(monkeypatch, tmp_path, reveal_max=1)
    c = _client(SUPER)
    _grant(c)
    assert c.post("/api/v1/admin/escrow/reveal", json={"confirm": True}).status_code == 200

    _grant(c)
    limited = c.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "3600"
    assert TEST_KEY not in limited.text
    app.dependency_overrides.clear()


def test_rate_limit_is_keyed_by_subject(monkeypatch, tmp_path, fake_google):
    """Bir kullanicinin denemeleri digerini kilitlememeli."""
    _settings(monkeypatch, tmp_path, reveal_max=1)
    escrow._allow("reveal", "user-a", 1)
    assert escrow.rate_limit_remaining("reveal", "user-b", 1) == 1


# --------------------------------------------------------------------------- #
# Denetim kaydi
# --------------------------------------------------------------------------- #
def test_reveal_is_audited_without_the_key(client, fake_google):
    _grant(client)
    client.post("/api/v1/admin/escrow/reveal", json={"confirm": True})

    reveals = [a for a in AUDIT if a[0] == "escrow.reveal"]
    assert reveals, "goruntuleme denetime yazilmali"
    action, actor, result, detail = reveals[-1]
    assert result == "ok"
    assert actor == SUPER
    assert detail.get("anchor8") == TEST_ANCHOR

    serialised = json.dumps(AUDIT, default=str)
    assert TEST_KEY not in serialised


def test_denied_reveal_is_audited(client):
    client.post("/api/v1/admin/escrow/reveal", json={"confirm": True})
    denied = [a for a in AUDIT if a[0] == "escrow.reveal" and a[2] == "denied"]
    assert denied
    assert TEST_KEY not in json.dumps(AUDIT, default=str)


# --------------------------------------------------------------------------- #
# Fiziksel kopya beyani
# --------------------------------------------------------------------------- #
def test_attest_records_both_copies(client, tmp_path):
    for copy_name in ("A", "B"):
        r = client.post(
            "/api/v1/admin/escrow/copies/attest",
            json={"copy": copy_name, "anchor8": TEST_ANCHOR, "note": "kasa"},
        )
        assert r.status_code == 200, r.text

    body = client.get("/api/v1/admin/escrow/status").json()
    assert body["copies"]["A"]["anchor8"] == TEST_ANCHOR
    assert body["copies"]["B"]["anchor8"] == TEST_ANCHOR
    assert body["copies"]["A"]["attested_by"] == SUPER
    # Beyan dosyasi yalnizca sahibine okunur olmali.
    mode = oct((tmp_path / "attest.json").stat().st_mode & 0o777)
    assert mode == "0o600"


def test_attest_rejects_bad_input(client):
    assert (
        client.post(
            "/api/v1/admin/escrow/copies/attest",
            json={"copy": "C", "anchor8": TEST_ANCHOR},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/admin/escrow/copies/attest",
            json={"copy": "A", "anchor8": "zz"},
        ).status_code
        == 422
    )


# --------------------------------------------------------------------------- #
# Servis duzeyi: baglama ve tek kullanim
# --------------------------------------------------------------------------- #
def test_grant_is_bound_to_the_session(monkeypatch, tmp_path):
    _settings(monkeypatch, tmp_path)
    started = escrow.start_step_up("u-1", "hash-a")
    result = escrow.complete_step_up(
        started["state"], "u-1", "hash-a", SUPER, SUPER
    )
    # Baska bir oturumun ozeti ile tuketilemez.
    assert escrow.consume_grant(result["grant"], "u-1", "hash-b") is False


def test_step_up_state_cannot_be_replayed(monkeypatch, tmp_path):
    _settings(monkeypatch, tmp_path)
    started = escrow.start_step_up("u-1", "h")
    escrow.complete_step_up(started["state"], "u-1", "h", SUPER, SUPER)
    with pytest.raises(escrow.EscrowDenied) as exc:
        escrow.complete_step_up(started["state"], "u-1", "h", SUPER, SUPER)
    assert exc.value.reason == "stepup_state_unknown"


def test_inspect_does_not_modify_the_file(tmp_path, monkeypatch):
    path = _escrow_file(tmp_path)
    before = path.read_bytes()
    _settings(monkeypatch, tmp_path, key_path=path)
    escrow.inspect()
    escrow.status_payload()
    assert path.read_bytes() == before


# --------------------------------------------------------------------------- #
# Step-up redirect URI turetimi
# --------------------------------------------------------------------------- #
def test_redirect_uri_uses_default_when_env_unset(monkeypatch):
    monkeypatch.delenv("GOOGLE_REDIRECT_URI", raising=False)
    assert escrow_api._redirect_uri() == (
        "https://api.130.162.247.20.sslip.io/api/v1/admin/escrow/step-up/callback"
    )


def test_redirect_uri_keeps_origin_and_replaces_path(monkeypatch):
    monkeypatch.setenv(
        "GOOGLE_REDIRECT_URI",
        "https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback",
    )
    assert escrow_api._redirect_uri() == (
        "https://api.130.162.247.20.sslip.io/api/v1/admin/escrow/step-up/callback"
    )


def test_redirect_uri_does_not_concatenate_when_path_differs(monkeypatch):
    """Eski `split("/api/v1/")` yaklasimi burada bozuk URI uretiyordu."""
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "https://example.com/oauth2/cb")
    assert escrow_api._redirect_uri() == (
        "https://example.com/api/v1/admin/escrow/step-up/callback"
    )


def test_redirect_uri_rejects_unparsable_value(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "not-a-url")
    with pytest.raises(HTTPException) as exc:
        escrow_api._redirect_uri()
    assert exc.value.detail == "oauth_redirect_uri_misconfigured"


def test_redirect_uri_rejects_plain_http_for_remote_hosts(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://api.example.com/cb")
    with pytest.raises(HTTPException) as exc:
        escrow_api._redirect_uri()
    assert exc.value.detail == "oauth_redirect_uri_must_be_https"

    # Yerel gelistirme icin http kabul edilir.
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/cb")
    assert escrow_api._redirect_uri() == (
        "http://localhost:8000/api/v1/admin/escrow/step-up/callback"
    )
