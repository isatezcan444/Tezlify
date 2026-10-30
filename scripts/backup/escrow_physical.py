#!/usr/bin/env python3
"""Escrow anahtari icin fiziksel/offline kopya yardimcisi.

TASARIM KURALI — bu dosya bir "sirri tasima" araci DEGIL, bir "sirri dogrulama"
aracidir:

  * `verify` ve `anchor` modlari anahtari **asla** basmaz. Yalnizca 8 haneli
    genel bir dogrulama capasi (SHA-256'nin ilk 8 hex'i) yazar.
  * `sheet` modu anahtari basar — ama yalnizca `--i-am-the-operator` bayragiyla.
    Bu mod **operatore** aittir: kagit kaleme gecirmek icin. Bir ajana ya da
    otomatik bir akisa baglanmamalidir.
  * Hicbir mod anahtari dosyaya yazmaz, ortam degiskenine koymaz, aga gondermez.
    `--out` diye bir parametre bilerek YOK.

Neden 8 hane yeterli: anahtar 64 karakter = 256 bit entropi. SHA-256 on-imi
hesaplanamaz; 8 hane (32 bit) yalnizca "elle yazarken hata yaptim mi" sorusunu
yanitlamak icin var, anahtar hakkinda kullanilabilir bilgi vermez.

Kullanim (operatör, kendi terminalinde):

    # 1. Capayi ogren (uretimde, anahtar basilmadan):
    ssh ... 'sed "s/.*=//" /var/backups/tezlify-ram/.key-escrow-v2' \\
        | python3 scripts/backup/escrow_physical.py anchor

    # 2. Yazdirmak icin kart uret (anahtar ekrana gelir — kendi terminaliniz):
    ssh ... 'sed "s/.*=//" /var/backups/tezlify-ram/.key-escrow-v2' \\
        | python3 scripts/backup/escrow_physical.py sheet --i-am-the-operator

    # 3. Kagitdan geri yazarak dogrula (anahtar basilmaz):
    python3 scripts/backup/escrow_physical.py verify --expect c25805a2
    (anahtari yapisitirip Enter; ekranda yankilanmaz)

Cikis kodlari: 0 = eslesti, 1 = eslesmedi, 2 = girdi gecersiz.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import re
import sys
from datetime import datetime, timezone

KEY_RE = re.compile(r"^[0-9a-f]{64}$")
PREFIX_RE = re.compile(r"^[^=]*=")

CARD_WIDTH = 64

# Cikis kodlari sozlesmedir: 0 eslesti, 1 eslesmedi, 2 gecersiz girdi.
EXIT_MISMATCH = 1
EXIT_BAD_INPUT = 2


def fail(msg: str, code: int = EXIT_BAD_INPUT) -> None:
    """stderr'e yazar ve belgelenen kodla cikar (SystemExit(str) 1 dondurur)."""
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def read_key(from_file: str | None, from_env: str | None,
             from_stdin: bool) -> str:
    """Anahtari tek bir kaynaktan okur; hicbir zaman yazdirmaz."""
    raw: str
    if from_file:
        with open(from_file, "r", encoding="utf-8") as fh:
            raw = fh.read()
    elif from_env:
        if from_env not in os.environ:
            fail(f"[HATA] ortam degiskeni yok: {from_env}")
        raw = os.environ[from_env]
    elif from_stdin:
        if sys.stdin.isatty():
            # Terminale yapistirmak istemeyenler icin yankisiz okuma.
            raw = getpass.getpass("anahtar (girdi gizli): ")
        else:
            raw = sys.stdin.read()
    else:
        fail("[HATA] kaynak belirtilmedi (--from-file / --from-env / --stdin)")

    return normalize(raw)


def normalize(raw: str) -> str:
    """`PREFIX=<key>` ya da ciplak anahtar kabul eder; kucuk-hex'e indirger."""
    line = raw.strip()
    if not line:
        fail("[HATA] bos girdi")
    # Tek satirsa ve '=' iceriyorsa onek kismini at.
    if "\n" not in line and "=" in line:
        line = PREFIX_RE.sub("", line, count=1)
    line = line.strip().lower()
    if not KEY_RE.match(line):
        fail(f"[HATA] gecersiz anahtar: {len(line)} karakter, "
             "64 karakter kucuk-hex bekleniyordu (icerik basilmadi)")
    return line


def anchor8(key: str) -> str:
    return hashlib.sha256(key.encode("ascii")).hexdigest()[:8]


def group4(key: str) -> list[str]:
    return [key[i:i + 4] for i in range(0, len(key), 4)]


def cmd_anchor(args) -> int:
    key = read_key(args.from_file, args.from_env, args.stdin)
    print(f"uzunluk = {len(key)}")
    print(f"anchor8 = {anchor8(key)}")
    return 0


def cmd_verify(args) -> int:
    key = read_key(args.from_file, args.from_env, args.stdin)
    got = anchor8(key)
    expect = args.expect.strip().lower()
    if not re.match(r"^[0-9a-f]{8}$", expect):
        print(f"[HATA] --expect 8 haneli hex olmali, alinan: {expect!r}",
              file=sys.stderr)
        return EXIT_BAD_INPUT
    ok = got == expect
    print(f"beklenen = {expect}")
    print(f"olculen  = {got}")
    print("SONUC    = " + ("MATCH" if ok else "MISMATCH"))
    if not ok:
        # Hata ayiklama icin hangi gruplarin kaydigini soyle — anahtar basilmaz.
        print("         kagittaki kopyayi kontrol edin; tek karakter hatasi "
              "capayi tamamen degistirir.")
    return 0 if ok else EXIT_MISMATCH


def cmd_sheet(args) -> int:
    if not args.i_am_the_operator:
        print("[REDDEDILDI] 'sheet' anahtari ekrana basar. Bu mod yalnizca "
              "operatore aittir.\n"
              "            Bilincli kullanim icin: --i-am-the-operator")
        return EXIT_BAD_INPUT
    key = read_key(args.from_file, args.from_env, args.stdin)
    groups = group4(key)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    print()
    print("=" * CARD_WIDTH)
    print("  TEZLIFY — WhatsApp RAM SNAPSHOT ANAHTARI (V2)".center(CARD_WIDTH))
    print("  FIZIKSEL / OFFLINE KOPYA".center(CARD_WIDTH))
    print("=" * CARD_WIDTH)
    print()
    print(f"  uretildi : {stamp}")
    print("  amac     : AES-256-GCM snapshot sifreleme anahtari")
    print(f"  uzunluk  : {len(key)} karakter (kucuk hex)")
    print(f"  ANCHOR8  : {anchor8(key)}   <-- dogrulama capasi")
    print()
    print("-" * CARD_WIDTH)
    print("  ANAHTAR — 16 grup x 4 karakter (sirayla, soldan saga)")
    print("-" * CARD_WIDTH)
    for row in range(4):
        cells = groups[row * 4:(row + 1) * 4]
        print("   " + "  ".join(f"{row * 4 + i + 1:>2}:{c}"
                                for i, c in enumerate(cells)))
    print("-" * CARD_WIDTH)
    print()
    print("  DOGRULAMA")
    print("  1) Anahtari yukaridan asagi, satir satir, bosluksuz yazin.")
    print("  2) Geri okuyup su komutla test edin:")
    print(f"     python3 scripts/backup/escrow_physical.py verify --expect {anchor8(key)}")
    print("  3) SONUC = MATCH olana kadar 1-2'yi tekrarlayin.")
    print()
    print("  SAKLAMA")
    print("  * En az IKI kopya, IKI ayri fiziksel konumda.")
    print("  * Snapshot'larin tutuldugu yerden AYRI yerde.")
    print("  * Fotograf/telefon/bulut notu YOK — kagit veya metal.")
    print("  * Bu kagit tek basina veriyi acmaz; OCI'deki .rsnap dosyalari gerekir.")
    print()
    print("=" * CARD_WIDTH)
    print()
    print("[NOT] Bu cikti anahtari ICERIR. Terminal gecmisini temizleyin, "
          "ekran goruntusu almayin,\n      hicbir sohbete/ajana yapistirmayin.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Escrow anahtari icin fiziksel kopya yardimcisi")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--from-file", default=None)
        p.add_argument("--from-env", default=None)
        p.add_argument("--stdin", action="store_true", default=False)

    a = sub.add_parser("anchor", help="yalnizca dogrulama capasini yaz")
    common(a)
    a.set_defaults(func=cmd_anchor)

    v = sub.add_parser("verify", help="kagittan yazilan anahtari capayla karsilastir")
    common(v)
    v.add_argument("--expect", required=True, help="8 haneli anchor (or. c25805a2)")
    v.set_defaults(func=cmd_verify)

    s = sub.add_parser("sheet", help="yazdirilabilir anahtar karti uret")
    common(s)
    s.add_argument("--i-am-the-operator", action="store_true",
                   help="zorunlu: bu mod anahtari ekrana basar")
    s.set_defaults(func=cmd_sheet)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
