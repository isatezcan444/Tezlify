"""Felaket kurtarma anahtari (escrow) panel servisi.

## Ne yapar

Sunucudaki `.key-escrow-v2` dosyasini **salt okunur** inceler, durumunu ve
8 haneli dogrulama capasini (`anchor8`) dondurur; yetkilendirilmis bir Super
Admin isterse anahtarin TAMAMINI tek seferlik, kisa omurlu bir grant ile verir.

## Ihlal edilemez kurallar

1. **Anahtar hicbir log satirina, denetim kaydina, hata metnine veya dosyaya
   yazilmaz.** Anahtar yalnizca `reveal()`'in dondurdugu sozlukte, cagiranin
   kendi HTTP yanitina gider.
2. **Dosya asla yazilmaz.** Bu modul `ESCROW_KEY_PATH`'e yalnizca `read_bytes()`
   ve `stat()` uygular; `open(..., "w")`, `unlink`, `rename` YOKTUR. Escrow
   dosyasini degistirmek/yeniden uretmek/silmek bu servisin yetkisi disindadir.
3. **Fail-closed.** Okunamayan dosya "yok" sayilmaz: `UNREACHABLE` doner. Bu
   ayrim onemlidir, cunku `docker-compose.prod.yml` escrow dizinini konteynere
   baglamadigi surece dosya GORUNMEZ ama VARDIR; "Eksik" demek yalan olurdu.
4. **Tek kullanim.** Goruntuleme grant'i tuketilir; ayni grant ile ikinci kez
   anahtar alinamaz. Sure doldugunda da gecersizdir.
5. **Hiz siniri kaynak basina.** Sayac `(kapsam, kullanici)` ciftine baglidir;
   surec genelinde tek bir sayac olsaydi bir kullanicinin denemeleri
   digerlerini kilitlerdi.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from backend.app.core.config import settings

logger = logging.getLogger(__name__)

KEY_RE = re.compile(r"^[0-9a-f]{64}$")

STATE_PRESENT = "PRESENT"
STATE_MISSING = "MISSING"
STATE_INVALID = "INVALID"
STATE_UNREACHABLE = "UNREACHABLE"


class EscrowDenied(Exception):
    """Yetki/akış reddi. `reason` makine okunur, anahtar ICERMEZ."""

    def __init__(self, reason: str, status_code: int = 403):
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


@dataclass(frozen=True)
class EscrowInspection:
    """Anahtarin KENDISINI tasimayan inceleme sonucu."""

    state: str
    path: str
    key_len: Optional[int] = None
    anchor8: Optional[str] = None
    mode: Optional[str] = None
    mtime: Optional[str] = None
    file_sha256_12: Optional[str] = None
    reason: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "path": self.path,
            "key_len": self.key_len,
            "anchor8": self.anchor8,
            "mode": self.mode,
            "mtime": self.mtime,
            "file_sha256_12": self.file_sha256_12,
            "reason": self.reason,
        }


# --------------------------------------------------------------------------- #
# Durum deposu (yalnizca bellek)
# --------------------------------------------------------------------------- #
#
# Uvicorn tek surec/tek worker ile kosuyor (`start.py` `workers=` vermiyor), bu
# yuzden surec ici durum tutarlidir. Cok worker'a gecilirse bu depo PAYLASILMAZ
# ve grant'lar worker'a bagli kalir — o noktada Redis/DB'ye tasinmalidir.
_STATE: Dict[str, Dict[str, Any]] = {
    "stepups": {},   # state_token -> kayit
    "grants": {},    # grant_token -> kayit
    "buckets": {},   # (kapsam, ozne) -> [timestamp, ...]
    "last_reveal": None,
}

# Denetim sink'i enjekte edilebilir: testler `/opt/tezlify/deploy` altina
# yazmadan dogrulama yapabilsin. Varsayilan, Operations Center'in mevcut
# (redakte eden, sinirli, restart'a dayanikli) denetim kaydidir.
_audit_sink: Optional[Callable[..., None]] = None


def _audit(action: str, actor: str, result: str, detail: Optional[Dict[str, Any]] = None) -> None:
    """Denetim kaydi yaz. Basarisizlik gorusunur, akisi bozmaz.

    `detail` icine ASLA anahtar konmaz; cagiranlar yalnizca `anchor8`, IP
    ozeti ve serbest gerekce gecirir.
    """
    try:
        sink = _audit_sink
        if sink is None:
            from backend.app.services.admin import ops_service as ops

            sink = ops.record_audit
        sink(action, actor, result, None, detail or {})
    except Exception as exc:  # noqa: BLE001 - denetim yazimi akisi durdurmamali
        logger.warning("Escrow denetim kaydi yazilamadi: %s", type(exc).__name__)


def set_audit_sink(sink: Optional[Callable[..., None]]) -> None:
    """Testler icin denetim sink'ini degistirir; `None` varsayilana doner."""
    global _audit_sink
    _audit_sink = sink


def reset_state() -> None:
    """Bellekteki tum gecici durumu temizler (testler ve cikis icin)."""
    _STATE["stepups"].clear()
    _STATE["grants"].clear()
    _STATE["buckets"].clear()
    _STATE["last_reveal"] = None


def _now() -> float:
    return time.monotonic()


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _purge() -> None:
    """Suresi dolmus kayitlari at. Sinirsiz buyumeyi engeller."""
    now = _now()
    for bucket in ("stepups", "grants"):
        store = _STATE[bucket]
        for token in [t for t, rec in store.items() if rec["expires_at"] <= now]:
            store.pop(token, None)


# --------------------------------------------------------------------------- #
# Hiz siniri
# --------------------------------------------------------------------------- #
def _allow(scope: str, subject: str, limit: int) -> bool:
    """Kayan pencere (son 1 saat). Anahtar `(kapsam, ozne)` ciftidir."""
    if limit <= 0:
        return False
    now = time.time()
    window_start = now - 3600.0
    key = (scope, subject)
    hits = [t for t in _STATE["buckets"].get(key, []) if t >= window_start]
    if len(hits) >= limit:
        _STATE["buckets"][key] = hits
        return False
    hits.append(now)
    _STATE["buckets"][key] = hits
    return True


def rate_limit_remaining(scope: str, subject: str, limit: int) -> int:
    window_start = time.time() - 3600.0
    hits = [t for t in _STATE["buckets"].get((scope, subject), []) if t >= window_start]
    return max(0, limit - len(hits))


# --------------------------------------------------------------------------- #
# Dosya incelemesi
# --------------------------------------------------------------------------- #
def _escrow_path() -> Path:
    return Path(settings.ESCROW_KEY_PATH)


def _parse_key(raw: str) -> Optional[str]:
    """`GATEWAY_ENCRYPTION_KEY=<64 hex>` bicimini cozer; gecersizse `None`."""
    text = (raw or "").strip()
    if not text:
        return None
    line = text.splitlines()[0].strip()
    value = line.split("=", 1)[1] if "=" in line else line
    value = value.strip().strip('"').strip("'").strip()
    return value if KEY_RE.match(value) else None


def anchor8_of(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]


def inspect() -> EscrowInspection:
    """Dosyayi SALT OKUNUR inceler. Anahtar donmez, yalnizca ozet doner."""
    path = _escrow_path()
    path_str = str(path)

    parent = path.parent
    if not parent.exists():
        # Mount edilmemis olabilir: dosya VAR ama konteyner GOREMIYOR.
        return EscrowInspection(
            state=STATE_UNREACHABLE, path=path_str, reason="parent_dir_not_visible"
        )

    try:
        st = path.stat()
    except FileNotFoundError:
        return EscrowInspection(state=STATE_MISSING, path=path_str, reason="file_not_found")
    except PermissionError:
        return EscrowInspection(
            state=STATE_UNREACHABLE, path=path_str, reason="permission_denied"
        )
    except OSError as exc:
        return EscrowInspection(
            state=STATE_UNREACHABLE, path=path_str, reason=type(exc).__name__
        )

    try:
        raw_bytes = path.read_bytes()
    except PermissionError:
        return EscrowInspection(
            state=STATE_UNREACHABLE, path=path_str, reason="permission_denied"
        )
    except OSError as exc:
        return EscrowInspection(
            state=STATE_UNREACHABLE, path=path_str, reason=type(exc).__name__
        )

    file_digest = hashlib.sha256(raw_bytes).hexdigest()[:12]
    key = _parse_key(raw_bytes.decode("utf-8", "replace"))
    mode = oct(st.st_mode & 0o777)
    mtime = (
        datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    if key is None:
        # Anahtar cozulemedi: icerigi loglamiyoruz, yalnizca uzunluk/gecerlilik.
        return EscrowInspection(
            state=STATE_INVALID,
            path=path_str,
            mode=mode,
            mtime=mtime,
            file_sha256_12=file_digest,
            reason="not_64_hex",
        )

    result = EscrowInspection(
        state=STATE_PRESENT,
        path=path_str,
        key_len=len(key),
        anchor8=anchor8_of(key),
        mode=mode,
        mtime=mtime,
        file_sha256_12=file_digest,
    )
    del key  # yerel referansi da dusur
    return result


def read_key() -> str:
    """Anahtari okur. YALNIZCA `reveal()` cagirir; cagiran yanitla sinirlidir."""
    path = _escrow_path()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise EscrowDenied(f"escrow_unreadable:{type(exc).__name__}", 409) from None
    key = _parse_key(raw.decode("utf-8", "replace"))
    if key is None:
        raise EscrowDenied("escrow_invalid_format", 409)
    return key


# --------------------------------------------------------------------------- #
# Fiziksel kopya beyanlari (makine dogrulamasi DEGIL)
# --------------------------------------------------------------------------- #
def _attestation_path() -> Path:
    return Path(settings.ESCROW_ATTESTATION_PATH)


def read_attestation() -> Dict[str, Any]:
    path = _attestation_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return {"copies": {}}
        copies = payload.get("copies")
        return {"copies": copies if isinstance(copies, dict) else {}}
    except FileNotFoundError:
        return {"copies": {}}
    except Exception as exc:  # noqa: BLE001 - bozuk dosya paneli dusurmemeli
        logger.warning("Escrow beyan dosyasi okunamadi: %s", type(exc).__name__)
        return {"copies": {}}


def record_attestation(copy_name: str, anchor8: str, actor: str, note: str = "") -> Dict[str, Any]:
    """Operatorun "kopyayi yazdim ve dogruladim" beyanini kaydeder.

    Bu bir MAKINE dogrulamasi degildir ve panelde oyle etiketlenir: sistem
    kagidi goremez. Kayit, denetim izi icin tarih + aktor + capa tutar.
    """
    if copy_name not in ("A", "B"):
        raise EscrowDenied("invalid_copy", 400)
    if not re.fullmatch(r"[0-9a-f]{8}", anchor8 or ""):
        raise EscrowDenied("invalid_anchor8", 400)

    current = read_attestation()
    copies = dict(current.get("copies") or {})
    copies[copy_name] = {
        "anchor8": anchor8,
        "attested_at": _iso_now(),
        "attested_by": actor,
        "note": (note or "")[:200],
    }
    payload = {"copies": copies, "updated_at": _iso_now()}

    path = _attestation_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".escrow-attest-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.chmod(tmp_name, 0o600)
            os.replace(tmp_name, path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except OSError as exc:
        raise EscrowDenied(f"attestation_write_failed:{type(exc).__name__}", 409) from None

    _audit(
        "escrow.attest",
        actor,
        "ok",
        {"copy": copy_name, "anchor8": anchor8},
    )
    return payload


# --------------------------------------------------------------------------- #
# Step-up (yeniden kimlik dogrulama) ve grant
# --------------------------------------------------------------------------- #
def start_step_up(user_id: str, session_hash: str) -> Dict[str, Any]:
    _purge()
    if not _allow("stepup", str(user_id), int(settings.ESCROW_STEPUP_MAX_PER_HOUR)):
        raise EscrowDenied("stepup_rate_limited", 429)

    state = secrets.token_urlsafe(32)
    ttl = int(settings.ESCROW_STEPUP_TTL_SECONDS)
    _STATE["stepups"][state] = {
        "user_id": str(user_id),
        "session_hash": session_hash,
        "expires_at": _now() + ttl,
    }
    return {"state": state, "expires_in": ttl}


def complete_step_up(
    state: str,
    user_id: str,
    session_hash: str,
    session_email: str,
    google_email: str,
) -> Dict[str, Any]:
    """Google donusunu dogrular ve tek kullanimlik goruntuleme grant'i uretir."""
    _purge()
    record = _STATE["stepups"].pop(state, None)
    if record is None:
        raise EscrowDenied("stepup_state_unknown")
    if record["expires_at"] <= _now():
        raise EscrowDenied("stepup_expired")
    if record["user_id"] != str(user_id) or record["session_hash"] != session_hash:
        # State baska bir oturuma baglanamaz: calinmis bir state ile
        # kurbanin oturumunda grant uretilememeli.
        raise EscrowDenied("stepup_binding_mismatch")

    if (google_email or "").strip().lower() != (session_email or "").strip().lower():
        raise EscrowDenied("stepup_identity_mismatch")

    grant = secrets.token_urlsafe(32)
    ttl = int(settings.ESCROW_REVEAL_TTL_SECONDS)
    _STATE["grants"][grant] = {
        "user_id": str(user_id),
        "session_hash": session_hash,
        "expires_at": _now() + ttl,
    }
    _audit("escrow.stepup", session_email or str(user_id), "ok", {"anchor8": None})
    return {"grant": grant, "expires_in": ttl}


def consume_grant(grant: str, user_id: str, session_hash: str) -> bool:
    _purge()
    record = _STATE["grants"].pop(grant, None)
    if record is None:
        return False
    if record["expires_at"] <= _now():
        return False
    return record["user_id"] == str(user_id) and record["session_hash"] == session_hash


# --------------------------------------------------------------------------- #
# Goruntuleme
# --------------------------------------------------------------------------- #
def reveal(user_id: str, session_hash: str, grant: str, actor: str) -> Dict[str, Any]:
    """Anahtari TEK SEFERLIK dondurur.

    Sira onemli: hiz siniri once sayilir (basarisiz denemeler de sayilir),
    sonra grant tuketilir, en son dosya okunur.
    """
    if not _allow("reveal", str(user_id), int(settings.ESCROW_REVEAL_MAX_PER_HOUR)):
        _audit("escrow.reveal", actor, "rate_limited", {"anchor8": None})
        raise EscrowDenied("reveal_rate_limited", 429)

    if not consume_grant(grant, user_id, session_hash):
        _audit("escrow.reveal", actor, "denied", {"reason": "grant_invalid"})
        raise EscrowDenied("grant_invalid")

    inspection = inspect()
    if inspection.state != STATE_PRESENT:
        _audit(
            "escrow.reveal",
            actor,
            "denied",
            {"reason": inspection.state, "anchor8": None},
        )
        raise EscrowDenied(f"escrow_{inspection.state.lower()}", 409)

    key = read_key()
    try:
        _STATE["last_reveal"] = {"at": _iso_now(), "by": actor}
        _audit(
            "escrow.reveal",
            actor,
            "ok",
            {"anchor8": anchor8_of(key), "key_len": len(key)},
        )
        return {
            "key": key,
            "anchor8": anchor8_of(key),
            "key_len": len(key),
            "expires_in": int(settings.ESCROW_REVEAL_TTL_SECONDS),
        }
    finally:
        del key


def status_payload() -> Dict[str, Any]:
    """Panelin ihtiyac duydugu her sey — anahtarin KENDISI haric."""
    inspection = inspect()
    attestation = read_attestation()
    copies = attestation.get("copies") or {}
    return {
        **inspection.as_dict(),
        "panel_enabled": bool(settings.ESCROW_PANEL_ENABLED),
        "copies": {
            "A": copies.get("A"),
            "B": copies.get("B"),
        },
        "last_reveal": _STATE["last_reveal"],
        "reveal_ttl_seconds": int(settings.ESCROW_REVEAL_TTL_SECONDS),
        "stepup_ttl_seconds": int(settings.ESCROW_STEPUP_TTL_SECONDS),
    }
