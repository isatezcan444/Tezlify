"""Encryption Key Escrow paneli — HTTP yuzeyi.

## Tasarim ozeti

| Uc nokta | Ne yapar | Anahtar doner mi |
|---|---|---|
| `GET  /status` | durum + `anchor8` + kopya beyanlari | **hayir** |
| `POST /step-up/start` | Google `prompt=login` URL'i uretir | hayir |
| `GET  /step-up/callback` | Google kimligini dogrular, tek kullanimlik grant uretir | hayir |
| `POST /reveal` | grant'i tuketir, anahtari BIR KEZ dondurur | **evet, tek kez** |
| `POST /copies/attest` | operatorun fiziksel kopya beyanini kaydeder | hayir |

## Neden grant bir CEREZDE tasiniyor

Grant'i URL'e (`?grant=...`) koymak tarayici gecmisine ve `Referer` basligina
sizardi; `localStorage`/`sessionStorage` ise XSS'te okunur. Bu yuzden grant
`HttpOnly` + `SameSite=Strict` + dar `Path` ile bir cerezde tasinir: JavaScript
onu HIC gormez, yalnizca tarayici `/api/v1/admin/escrow/reveal`'a ekler.

## Anahtar sizintisini engelleyen kurallar

- Yanitlar `Cache-Control: no-store` tasir (paylasilan proxy'de kalmasin).
- Anahtar hicbir `logger.*` cagrisina, denetim kaydina veya hata metnine
  konmaz; `detail` yalnizca makine okunur bir `reason` dondurur.
- `reveal` basarisiz oldugunda donen govde anahtar icermez.
"""

from __future__ import annotations

import hashlib
import logging
import os
import urllib.parse
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse

from backend.app.auth.api.dependencies import (
    extract_session_token,
    require_super_admin,
)
from backend.app.auth.infrastructure.google_provider import GoogleOAuthProvider
from backend.app.core.auth import AuthUser
from backend.app.schemas.escrow import (
    EscrowAttestRequest,
    EscrowAttestResponse,
    EscrowRevealRequest,
    EscrowRevealResponse,
    EscrowStatusResponse,
    EscrowStepUpStartResponse,
)
from backend.app.services.admin import escrow_service as escrow

logger = logging.getLogger(__name__)

router = APIRouter()

GRANT_COOKIE = "escrow_grant"
GRANT_COOKIE_PATH = "/api/v1/admin/escrow"


# --------------------------------------------------------------------------- #
# Yardimcilar
# --------------------------------------------------------------------------- #
def _no_store(response: Response) -> None:
    """Anahtar tasiyabilecek yanitlar hicbir yerde saklanmamali."""
    response.headers["Cache-Control"] = "no-store, max-age=0, private"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"


def _session_hash(request: Request) -> str:
    """Oturum token'inin ozeti. Token'in kendisi tutulmaz, karsilastirma yeter."""
    token = extract_session_token(request) or ""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _deny(exc: escrow.EscrowDenied) -> HTTPException:
    headers = {"Cache-Control": "no-store"}
    if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        headers["Retry-After"] = "3600"
    return HTTPException(status_code=exc.status_code, detail=exc.reason, headers=headers)


DEFAULT_AUTH_REDIRECT_URI = (
    "https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback"
)


def _redirect_uri() -> str:
    """Step-up icin AYRI callback yolu uretir; host mevcut OAuth istemcisinden gelir.

    Neden ayri yol: step-up yeni bir oturum URETMEMELI, yalnizca "ayni kisi mi"
    sorusunu cevaplamali. Mevcut `/auth/google/callback` akisina dokunmak,
    calisan girisi riske atardi.

    Neden `urlsplit`, neden `split("/api/v1/")` DEGIL: eski yaklasim, yol
    `/api/v1/` icermedigi anda (ornegin `GOOGLE_REDIRECT_URI=https://host/oauth2/cb`)
    sessizce `https://host/oauth2/cb/api/v1/admin/...` gibi BOZUK bir URI
    uretiyordu. Google bunu `redirect_uri_mismatch` ile reddeder ve nedeni
    anlasilmaz. Burada yalnizca origin (scheme + host) alinir, yol her zaman
    sabittir.

    Fail-closed: origin cozulemezse veya https disi bir host verilirse 500
    doner. Google zaten https ister; hatayi Google'in mesajinda degil, bizde
    gormek daha hizli teshis edilir. `localhost`/`127.0.0.1` istisnasi yalnizca
    yerel gelistirme icindir.
    """
    raw = (os.getenv("GOOGLE_REDIRECT_URI") or DEFAULT_AUTH_REDIRECT_URI).strip()
    parsed = urllib.parse.urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="oauth_redirect_uri_misconfigured",
        )
    local = parsed.hostname in {"localhost", "127.0.0.1"}
    if parsed.scheme != "https" and not local:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="oauth_redirect_uri_must_be_https",
        )
    return f"{parsed.scheme}://{parsed.netloc}/api/v1/admin/escrow/step-up/callback"


def _provider() -> GoogleOAuthProvider:
    return GoogleOAuthProvider(
        client_id=os.getenv("GOOGLE_CLIENT_ID", ""),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""),
        redirect_uri=_redirect_uri(),
    )


async def google_identity(code: str) -> Dict[str, Any]:
    """Google kod degisimi + kimlik cikarimi.

    Testler bu fonksiyonu degistirir; ag cagrisi yapilmaz.
    """
    provider = _provider()
    token_data = await provider.exchange_code(code)
    id_token = token_data.get("id_token")
    if not id_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Google yanitinda id_token yok",
        )
    return provider.verify_and_extract_identity(id_token)


# --------------------------------------------------------------------------- #
# Durum
# --------------------------------------------------------------------------- #
@router.get("/status", response_model=EscrowStatusResponse)
async def get_escrow_status(
    response: Response,
    current_super_admin: AuthUser = Depends(require_super_admin),
) -> EscrowStatusResponse:
    """Anahtarin varligini, capasini ve kopya beyanlarini dondurur.

    Anahtar DONMEZ. `state=UNREACHABLE` ise dosya vardir ama konteyner
    goremiyor demektir (ornegin compose mount'u eksik) — "Eksik" demek
    yanlis olurdu.
    """
    _no_store(response)
    return EscrowStatusResponse(**escrow.status_payload())


# --------------------------------------------------------------------------- #
# Step-up: yeniden kimlik dogrulama
# --------------------------------------------------------------------------- #
@router.post("/step-up/start", response_model=EscrowStepUpStartResponse)
async def start_step_up(
    request: Request,
    response: Response,
    current_super_admin: AuthUser = Depends(require_super_admin),
) -> EscrowStepUpStartResponse:
    """Google'a `prompt=login` ile giden URL'i uretir.

    `prompt=login` sart: `consent` ile Google, mevcut oturumu yeterli sayip
    sifre sormadan donebilir; o zaman "yeniden kimlik dogrulama" yapilmamis olur.
    """
    _no_store(response)
    try:
        data = escrow.start_step_up(current_super_admin.id, _session_hash(request))
    except escrow.EscrowDenied as exc:
        raise _deny(exc) from None

    auth_url = _provider().get_authorization_url(data["state"], prompt="login")
    return EscrowStepUpStartResponse(
        authorization_url=auth_url,
        state=data["state"],
        expires_in=data["expires_in"],
    )


@router.get("/step-up/callback")
async def step_up_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    current_super_admin: AuthUser = Depends(require_super_admin),
) -> RedirectResponse:
    """Google donusunu isler ve tek kullanimlik grant'i CEREZE yazar.

    Basarida tarayici panele geri gonderilir; grant URL'de TASINMAZ.
    """
    frontend = os.getenv("FRONTEND_ORIGIN", "https://api.130.162.247.20.sslip.io")
    back = f"{frontend.rstrip('/')}/?tab=admin-escrow"

    if error or not code or not state:
        return RedirectResponse(url=f"{back}&stepup=denied", status_code=status.HTTP_302_FOUND)

    try:
        identity = await google_identity(code)
        result = escrow.complete_step_up(
            state=state,
            user_id=current_super_admin.id,
            session_hash=_session_hash(request),
            session_email=current_super_admin.email or "",
            google_email=str(identity.get("email") or ""),
        )
    except escrow.EscrowDenied as exc:
        logger.warning("Escrow step-up reddedildi: %s", exc.reason)
        return RedirectResponse(
            url=f"{back}&stepup=denied&reason={exc.reason}",
            status_code=status.HTTP_302_FOUND,
        )
    except HTTPException:
        return RedirectResponse(url=f"{back}&stepup=denied", status_code=status.HTTP_302_FOUND)

    redirect = RedirectResponse(url=f"{back}&stepup=ok", status_code=status.HTTP_302_FOUND)
    redirect.set_cookie(
        key=GRANT_COOKIE,
        value=result["grant"],
        max_age=int(result["expires_in"]),
        path=GRANT_COOKIE_PATH,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
    )
    redirect.headers["Cache-Control"] = "no-store"
    return redirect


# --------------------------------------------------------------------------- #
# Goruntuleme
# --------------------------------------------------------------------------- #
@router.post("/reveal", response_model=EscrowRevealResponse)
async def reveal_key(
    request: Request,
    response: Response,
    payload: EscrowRevealRequest,
    current_super_admin: AuthUser = Depends(require_super_admin),
) -> EscrowRevealResponse:
    """Anahtari TEK KEZ dondurur.

    Gereken uc sey ayni anda: (1) gecerli step-up grant'i (cerezde), (2) acik
    `confirm=true`, (3) hiz siniri icinde kalmak. Grant bu cagrida tuketilir.
    """
    _no_store(response)

    if not payload.confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="confirm_true_required",
            headers={"Cache-Control": "no-store"},
        )

    grant = request.cookies.get(GRANT_COOKIE) or ""
    try:
        data = escrow.reveal(
            user_id=current_super_admin.id,
            session_hash=_session_hash(request),
            grant=grant,
            actor=current_super_admin.email or current_super_admin.id,
        )
    except escrow.EscrowDenied as exc:
        raise _deny(exc) from None

    response.delete_cookie(GRANT_COOKIE, path=GRANT_COOKIE_PATH)
    return EscrowRevealResponse(**data)


# --------------------------------------------------------------------------- #
# Fiziksel kopya beyani
# --------------------------------------------------------------------------- #
@router.post("/copies/attest", response_model=EscrowAttestResponse)
async def attest_copy(
    response: Response,
    payload: EscrowAttestRequest,
    current_super_admin: AuthUser = Depends(require_super_admin),
) -> EscrowAttestResponse:
    """Operatorun "kopyayi yazdim, anchor8 dogrulandi" beyanini kaydeder.

    Bu bir MAKINE dogrulamasi degildir; sistem kagidi goremez. Panel bunu
    "beyan" olarak etiketler ve tarih/aktor ile denetime yazar.
    """
    _no_store(response)
    try:
        data = escrow.record_attestation(
            copy_name=payload.copy_name,
            anchor8=payload.anchor8,
            actor=current_super_admin.email or current_super_admin.id,
            note=payload.note,
        )
    except escrow.EscrowDenied as exc:
        raise _deny(exc) from None
    return EscrowAttestResponse(**data)
