"""`WHATSAPP_MEMORY_PERSIST_ENABLED` icin fail-closed karar kapisi.

## Neden ayri bir betik

Faz 3.8'de olculen sey bir yapilandirma hatasiydi, bir kod hatasi degil:
aday (candidate) container'in environment'i CANLI container'dan kopyalaniyor
(`host-release.sh`), `.env.production`dan degil. Flag canlida yoksa ve kodun
varsayilani `True` ise adacik, izole DB uzerinde dahi otomatik kalicilastirmayi
baslatiyordu. Bunu bash icinde `grep` ile cozmek iki sekilde bozulur:

  1. `grep -q KEY=true` — `KEY=truely` / `KEY=TRUE` / `KEY="true"` gibi mesru
     yazimlari kacirir; kacirilan deger "kapali" sayilip deploy edilir.
  2. Ayni mantik iki yerde (adacik + cutover) kopyalanir ve zamanla ayrisir.

Bu yuzden karar TEK bir saf fonksiyonda (`evaluate`) toplanir; bash yalnizca
cagirir ve cikis kodunu okur. Boylece kural test edilebilir hale gelir.

## Fail-closed kurallari

  * Flag YOK       -> IZINLI, cunku kodun varsayilani artik `False`
                      (bkz. `config.py`); "yokluk" = "kapali".
  * Flag `false`   -> IZINLI.
  * Flag `true`    -> RED, `--allow-enabled` verilmedikce.
  * Cozulemeyen    -> RED. `truely`, `evet`, `2`, bos string gibi degerler
                      "belki acik" sayilir; emin olunamayan bir degerle
                      otomatik yazma baslatmak kabul edilmez.

`--require-explicit-false` adacik icin: orada "yokluk" YETMEZ, cunku adacik
canli env'i devralir ve o env'de flag bulunmayabilir. Adacigin kapali oldugu
ACIKCA yazili olmalidir.

## Gizlilik

Yalnizca ilgili anahtarin degeri okunur; diger degiskenlerin degerleri ne
yazdirilir ne de hata mesajina konur. Cikti tek satir, PII yok.
"""

from __future__ import annotations

import argparse
import sys
from typing import Dict, Mapping, Optional, Sequence, Tuple

FLAG = "WHATSAPP_MEMORY_PERSIST_ENABLED"

_TRUE = {"1", "true", "yes", "on", "y", "t"}
_FALSE = {"0", "false", "no", "off", "n", "f"}

EXIT_ALLOWED = 0
EXIT_DENIED = 1
EXIT_USAGE = 2


def parse_flag(raw: object) -> Optional[bool]:
    """Metni bool'a cevir; cozulemiyorsa `None`.

    `None` "bilinmiyor" demektir ve cagiran taraf onu RED olarak yorumlar.
    Bos string de bilinmiyor sayilir: `KEY=` yazan bir operator muhtemelen
    "kapali" demek istemistir ama bunu soylememistir.
    """
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return None
    text = str(raw).strip().strip('"').strip("'").strip().lower()
    if not text:
        return None
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return None


def evaluate(
    env: Mapping[str, str],
    *,
    require_explicit_false: bool = False,
    allow_enabled: bool = False,
) -> Tuple[bool, str]:
    """(izinli_mi, gerekce) dondurur. Gerekce sabit ve PII'sizdir."""

    if FLAG not in env:
        if require_explicit_false:
            return False, "flag_absent_but_explicit_false_required"
        return True, "flag_absent_defaults_off"

    parsed = parse_flag(env.get(FLAG))
    if parsed is None:
        # Cozulemeyen deger: "kapali" diye yorumlamak, yazmayi baslatma
        # riskini tasir. Bu yuzden reddedilir.
        return False, "flag_unparseable"
    if parsed is True:
        if allow_enabled:
            return True, "flag_true_explicitly_allowed"
        return False, "flag_true_not_allowed"
    return True, "flag_explicitly_false"


def read_env_file(path: str) -> Dict[str, str]:
    """`KEY=VALUE` satirlarini okur. Yalnizca anahtar/deger; yorum atlanir.

    Deger tirnak icindeyse soyulur: `.env.production` tirnakli degerler
    icerebiliyor ve compose bunlari cozerken tirnagi atar.
    """
    out: Dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export "):].lstrip()
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            out[key.strip()] = value.strip()
    return out


def read_env_stream(stream) -> Dict[str, str]:
    """`docker inspect ... Config.Env` cikisi gibi `KEY=VALUE` akisi."""
    out: Dict[str, str] = {}
    for line in stream:
        stripped = line.strip()
        if not stripped or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        out[key.strip()] = value.strip()
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "WHATSAPP_MEMORY_PERSIST_ENABLED icin fail-closed karar kapisi. "
            "Deger YAZDIRMAZ; yalnizca izin/red ve sabit bir gerekce."
        )
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--env-file", help="KEY=VALUE dosyasi (.env.production, adacik env)")
    src.add_argument("--stdin", action="store_true", help="KEY=VALUE akisini stdin'den oku")
    ap.add_argument(
        "--require-explicit-false",
        action="store_true",
        help="flag YOKSA reddet (adacik icin: kapali oldugu acikca yazilmali)",
    )
    ap.add_argument(
        "--allow-enabled",
        action="store_true",
        help="flag true ise de izin ver (bilincli, ayri onay gerektiren istisna)",
    )
    args = ap.parse_args(argv)

    try:
        env = read_env_stream(sys.stdin) if args.stdin else read_env_file(args.env_file)
    except OSError as exc:
        print(f"persistence-flag-guard: HATA dosya okunamadi: {exc}", file=sys.stderr)
        return EXIT_USAGE

    allowed, reason = evaluate(
        env,
        require_explicit_false=args.require_explicit_false,
        allow_enabled=args.allow_enabled,
    )
    verdict = "IZINLI" if allowed else "RED"
    print(f"persistence-flag-guard: {verdict} ({reason})")
    return EXIT_ALLOWED if allowed else EXIT_DENIED


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
