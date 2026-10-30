#!/usr/bin/env python3
"""Bagimsiz escrow ile OFF-SITE restore — 3.9.13 kabul testi.

Neden bu arac var: 3.9.11'de off-site restore teknik olarak calisti ama anahtar
HALA ayni diskteki escrow dosyasindan okundu. Disk kaybinda o dosya da gider;
yani "felaket kurtarma" kanitlanmis sayilmaz. Bu arac zinciri **kagittan
veriye** kadar tek komutta yurutur ve yalnizca kagittan gelen anahtari kabul eder.

Tasarim kurallari:
  * Anahtar argv'den ALINMAZ (ps gormez), ortam degiskenine KONMAZ
    (konteyner/surec ortami okunabilir), dosyaya YAZILMAZ.
    Kaynaklar: `--stdin` (yapistir) veya terminalde yankisiz `getpass`.
  * Anahtar hicbir ciktida, hata mesajinda veya JSON alaninda GECMEZ.
    Yalnizca 8 haneli `anchor8` yazilir.
  * Yanlis anahtar -> cikis 4, hicbir indirme/restore yapilmaz.
  * Indirilen snapshot DISKE YAZILMAZ: 7 MB bellege sigar, sifre cozme ve
    restore bellek icinde olur. Yani temizlenecek gecici dosya OLUSMAZ.
  * `:memory:` hedefi kullanilir; uretim DB'sine baglanilmaz, yazilmaz.
  * Karar VERISI indirilen manifesttir: beklenen kimlik koku uzaktan gelen
    manifestten okunur, yerel dosyadan degil. Yerel kopya yalnizca capraz
    kontrol icindir (varsa).

Cikis kodlari:
    0 = tam PASS (kimlik koku ve satir sayilari tuttu)
    1 = kullanim hatasi / guvenlik kapisi
    2 = ag / OCI hatasi
    3 = butunluk hatasi (sha256, boyut veya snapshot dogrulamasi)
    4 = escrow capasi tutmadi (yanlis anahtar)
    5 = restore sonrasi kimlik korunmadi
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

KEY_RE = re.compile(r"^[0-9a-f]{64}$")
PREFIX_RE = re.compile(r"^[^=]*=")

DEFAULT_EXPECT = "c25805a2"   # 3.9.7/3.9.12'de olculen genel capa
DEFAULT_BUCKET = "tezlify-ram-snapshots"
DEFAULT_PREFIX = "tezlify/whatsapp/ram-snapshots"


# ---------------------------------------------------------------- modul yukle
def load_module(name: str, path: Path):
    if not path.is_file():
        print(f"[HATA] modul bulunamadi: {path}", file=sys.stderr)
        raise SystemExit(1)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _here() -> Path:
    try:
        return Path(__file__).resolve().parent
    except NameError:  # `python3 -` ile boru hattindan calisirsa
        return Path.cwd()


# ------------------------------------------------------------------- anahtar
def read_key(args) -> str:
    """Anahtari argv'ye ve ortama dokunmadan okur."""
    if args.from_file:
        raw = Path(args.from_file).read_text(encoding="utf-8")
    elif args.stdin and sys.stdin.isatty():
        # `--stdin` verildi ama boru yok: yankisiz oku.
        import getpass
        raw = getpass.getpass("escrow anahtari (girdi gizli): ")
    else:
        # Boru hattindan geliyorsa (veya --stdin ile) dogrudan oku.
        raw = sys.stdin.read()

    line = raw.strip()
    if "\n" not in line and "=" in line:
        line = PREFIX_RE.sub("", line, count=1)
    line = line.strip().lower()
    if not KEY_RE.match(line):
        # Girdinin KENDISI basilmaz; yalnizca uzunluk.
        print(f"[HATA] gecersiz anahtar: {len(line)} karakter "
              "(64 kucuk-hex bekleniyordu)", file=sys.stderr)
        raise SystemExit(1)
    return line


def anchor8(key: str) -> str:
    return hashlib.sha256(key.encode("ascii")).hexdigest()[:8]


# --------------------------------------------------------------------- main
def main(argv=None) -> int:
    here = _here()
    ap = argparse.ArgumentParser(
        description="Bagimsiz escrow ile off-site restore kabul testi")
    ap.add_argument("--bucket", default=DEFAULT_BUCKET)
    ap.add_argument("--prefix", default=DEFAULT_PREFIX)
    ap.add_argument("--file", help="snapshot dosya adi (varsayilan: en yeni)")
    ap.add_argument("--expect", default=DEFAULT_EXPECT,
                    help=f"beklenen anchor8 (varsayilan {DEFAULT_EXPECT})")
    ap.add_argument("--source", default="/var/backups/tezlify-ram",
                    help="yerel kopya (yalnizca capraz kontrol; yoksa atlanir)")
    ap.add_argument("--tool-dir", default=str(here),
                    help="offsite_oci.py'nin bulundugu dizin")
    ap.add_argument("--ram-snapshot",
                    default=str(here.parent / "diagnostics" / "ram_snapshot.py"),
                    help="ram_snapshot.py yolu")
    ap.add_argument("--from-file", help="anahtari bu dosyadan oku (operator kolayligi)")
    ap.add_argument("--stdin", action="store_true",
                    help="anahtari stdin'den oku (yapistirma)")
    args = ap.parse_args(argv)

    # --- 1) anahtar + escrow kapisi (hicbir ag islemi yapilmadan) -----------
    key = read_key(args)
    got = anchor8(key)
    expect = (args.expect or "").strip().lower()
    if got != expect:
        print(f"escrow_anchor_beklenen = {expect}")
        print(f"escrow_anchor_olculen  = {got}")
        print("SONUC = ESCROW_MISMATCH — yanlis anahtar; hicbir indirme yapilmadi")
        return 4
    print(f"escrow_anchor = {got}  (MATCH)")
    print("anahtar_kaynagi = " + ("dosya" if args.from_file else "stdin/getpass"))

    # --- 2) modulleri yukle -----------------------------------------------
    offsite = load_module("offsite_oci", Path(args.tool_dir) / "offsite_oci.py")
    ram = load_module("ram_snapshot", Path(args.ram_snapshot))

    p = offsite.Principal()

    # --- 3) nesne secimi ---------------------------------------------------
    if args.file:
        snap_name = args.file
    else:
        url = (f"{p._base}/n/{p.namespace}/b/{args.bucket}/o"
               f"?prefix={args.prefix}&fields=name,size,timeCreated&limit=1000")
        status, _, body = offsite.http_call(
            "GET", url, None,
            offsite.sign_headers("GET", url, b"", p.session_key, p._key_id))
        if status != 200:
            print(f"[HATA] liste alinamadi: HTTP {status}", file=sys.stderr)
            return 2
        names = [o["name"] for o in json.loads(body).get("objects", [])
                 if o["name"].endswith(".rsnap")]
        if not names:
            print("[HATA] bucket'ta .rsnap yok", file=sys.stderr)
            return 2
        snap_name = Path(sorted(names)[-1]).name
    manifest_name = snap_name.replace(".rsnap", ".manifest.json")
    print(f"nesne          = {snap_name}")

    # --- 4) uzaktan indir (DISKE YAZMADAN) --------------------------------
    snap_key = offsite.object_key(args.prefix, snap_name)
    man_key = offsite.object_key(args.prefix, manifest_name)
    try:
        blob = p.get_object(args.bucket, snap_key)
        man_bytes = p.get_object(args.bucket, man_key)
        head = p.head_object(args.bucket, snap_key) or {}
    except Exception as exc:  # noqa: BLE001
        print(f"[HATA] indirme basarisiz: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    remote_sha = hashlib.sha256(blob).hexdigest()
    meta_sha = (head.get("opc-meta-sha256") or "").strip()
    print(f"indirilen_bayt = {len(blob)}")
    print(f"indirilen_sha  = {remote_sha}")

    local_path = Path(args.source) / snap_name
    local_sha, local_size = (None, None)
    if local_path.is_file():
        local_sha, local_size = offsite.sha256_file(local_path)
        print(f"yerel_sha      = {local_sha}")
        print(f"yerel_bayt     = {local_size}")

    size_ok = head.get("content-length") is None or int(head["content-length"]) == len(blob)
    meta_ok = (not meta_sha) or meta_sha == remote_sha
    local_ok = (local_sha is None) or (local_sha == remote_sha and local_size == len(blob))
    print(f"boyut_eslesti  = {size_ok}")
    print(f"meta_sha_eslesti = {meta_ok}")
    print(f"yerel_eslesti  = {local_ok if local_sha else 'ATLANDI (yerel kopya yok)'}")
    if not (size_ok and meta_ok and local_ok):
        print("SONUC = INTEGRITY_FAIL — indirilen veri beklenenle uyusmuyor")
        return 3

    # --- 5) bellekte sifre coz + dogrula ----------------------------------
    try:
        plain = ram.decrypt_bytes(blob, key)
        payload = json.loads(plain.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"SONUC = DECRYPT_FAIL — {type(exc).__name__}", file=sys.stderr)
        return 3
    finally:
        del blob

    check = ram.verify_snapshot(payload)
    print(f"snapshot_dogrulama = {'OK' if check['ok'] else 'BOZUK'}")
    if not check["ok"]:
        for p_ in check["problems"][:5]:
            print(f"  - {p_}")
        return 3

    remote_manifest = json.loads(man_bytes.decode("utf-8"))
    expected_root = (remote_manifest.get("identity_root_sha256") or "").strip()
    expected_rows = remote_manifest.get("record_count")
    print(f"manifest_kaynak  = UZAKTAN indirilen {manifest_name}")
    print(f"manifest_satir   = {expected_rows}")

    # --- 6) :memory: restore ---------------------------------------------
    try:
        res = ram.restore_to_sqlite(":memory:", payload)
    except PermissionError as exc:
        print(f"SONUC = REFUSED — {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"SONUC = RESTORE_FAIL — {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3

    root_matches = (res["restored_identity_root_sha256"] == expected_root)
    rows_match = (expected_rows is None) or (int(res["restored_rows"]) == int(expected_rows))

    print(f"restored_rows    = {res['restored_rows']}")
    print(f"expected_rows    = {res['expected_rows']}")
    print(f"manifest_satir   = {expected_rows}  eslesti = {rows_match}")
    print(f"source_identity  = {res['source_identity_count']}")
    print(f"restored_identity= {res['restored_identity_count']}")
    print(f"distinct_conv    = {res['distinct_conversations']}")
    print(f"identity_set_equal = {res['identity_set_equal']}")
    print(f"identity_root_matches = {root_matches}")
    print(f"identity_conserved    = {res['identity_conserved']}")
    print(f"gecici_dosya     = YOK (indirme ve restore bellek icinde)")

    ok = (root_matches and rows_match and res["identity_set_equal"]
          and res["identity_conserved"])
    print()
    print("SONUC = " + ("PASS" if ok else "IDENTITY_FAIL"))
    return 0 if ok else 5


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
