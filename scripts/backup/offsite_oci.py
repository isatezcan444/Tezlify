#!/usr/bin/env python3
"""Tezlify off-site RAM snapshot aktarimi — OCI Object Storage (instance principal).

Neden rclone degil:
  Instance principal, IMDS + /v1/x509 uzerinden calisir. Disk'te kimlik bilgisi
  tutmaz, paket kurulumu gerektirmez, secret komut satirina yazilmaz.

Guvenlik kurallari (hepsi kodda zorlanir):
  * Escrow (.key-escrow*) ASLA yuklenmez  -> hard block
  * Ayni isim + farkli hash -> CONFLICT, uzerine YAZILMAZ
  * Hata -> kaynak dosyaya dokunulmaz, cikis kodu != 0
  * Token/secret loglanmaz, audit log'a yazilmaz
  * TLS dogrulamasi kapatilamaz (ssl.create_default_context)

Kullanim:
  offsite_oci.py inventory --source DIR
  offsite_oci.py upload   --source DIR --bucket NAME [--prefix P] --execute
  offsite_oci.py verify   --bucket NAME --prefix P --download-check

  --execute olmadan upload SADECE plan basar (ag yazimi yok).
  --execute icin ayrica TEZLIFY_OFFSITE_APPROVED=1 ortam degiskeni gerekir.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

IMDS = "http://169.254.169.254/opc/v2"
IMDS_HDR = {"Authorization": "Bearer Oracle"}
ESCROW_RE = re.compile(r"^\.key-escrow")
SNAP_RE = re.compile(r"^(?P<name>tezlify-ram-(?P<ts>\d{8}T\d{6}Z)\.(?:rsnap|manifest\.json))$")
AUDIT_DIR = Path.home() / ".local" / "state" / "tezlify-offsite"
AUDIT_LOG = AUDIT_DIR / "transfer.jsonl"


# ---------------------------------------------------------------- IMDS / auth
def _imds(path: str) -> bytes:
    req = urllib.request.Request(IMDS + path, headers=IMDS_HDR)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read()


def _rfc1123() -> str:
    return format_datetime(datetime.now(timezone.utc), usegmt=True)


def sign_headers(method: str, url: str, body: bytes, key, key_id: str,
                 content_type: str = "application/octet-stream") -> dict:
    """OCI Signature v1."""
    parts = urllib.parse.urlsplit(url)
    target = parts.path + (("?" + parts.query) if parts.query else "")
    hdrs = {
        "date": _rfc1123(),
        "(request-target)": f"{method.lower()} {target}",
        "host": parts.netloc,
    }
    if method in ("PUT", "POST"):
        hdrs["content-length"] = str(len(body))
        hdrs["content-type"] = content_type
        hdrs["x-content-sha256"] = base64.b64encode(
            hashlib.sha256(body).digest()).decode()

    order = list(hdrs.keys())
    signing_string = "\n".join(f"{h}: {hdrs[h]}" for h in order)
    sig = key.sign(signing_string.encode(), padding.PKCS1v15(), hashes.SHA256())
    out = {
        "date": hdrs["date"],
        "authorization": (
            'Signature version="1",'
            f'keyId="{key_id}",'
            'algorithm="rsa-sha256",'
            f'headers="{" ".join(order)}",'
            f'signature="{base64.b64encode(sig).decode()}"'
        ),
    }
    for h in ("content-length", "content-type", "x-content-sha256"):
        if h in hdrs:
            out[h] = hdrs[h]
    return out


def http_call(method, url, body, headers, timeout=120):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    ctx = ssl.create_default_context()  # TLS dogrulamasi ASLA kapatilmaz
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


class Principal:
    """Instance principal oturumu. Token bellekte tutulur, diske yazilmaz."""

    def __init__(self) -> None:
        self.region = _imds("/instance/region").decode().strip().lower()
        inst = json.loads(_imds("/instance/"))
        cert_pem = _imds("/identity/cert.pem")
        leaf_pem = _imds("/identity/key.pem")
        try:
            inter_pem = _imds("/identity/intermediate.pem")
        except Exception:
            inter_pem = b""

        cert = x509.load_pem_x509_certificate(cert_pem)
        tenancy = inst.get("tenantId")
        if not tenancy:
            raise RuntimeError("tenancy OCID okunamadi")

        fp = ":".join(f"{b:02X}" for b in cert.fingerprint(hashes.SHA1()))
        self.leaf_key = serialization.load_pem_private_key(leaf_pem, password=None)
        self.session_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048)
        self.tenancy = tenancy

        payload = {
            "certificate": cert_pem.decode(),
            "publicKey": self.session_key.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode(),
        }
        if inter_pem:
            payload["intermediateCertificates"] = [inter_pem.decode()]
        body = json.dumps(payload).encode()

        url = f"https://auth.{self.region}.oraclecloud.com/v1/x509"
        hdrs = sign_headers("POST", url, body, self.leaf_key,
                            f"{tenancy}/fed-x509/{fp}",
                            content_type="application/json")
        status, _, resp = http_call("POST", url, body, hdrs)
        if status != 200:
            raise RuntimeError(f"token alinamadi: HTTP {status}")
        token = json.loads(resp).get("token")
        if not token:
            raise RuntimeError("token alani bos")
        self._key_id = "ST$" + token
        self._base = f"https://objectstorage.{self.region}.oraclecloud.com"
        self.namespace = self._get("/n/").decode().strip().strip('"')

    def _get(self, path: str) -> bytes:
        url = self._base + path
        status, _, body = http_call(
            "GET", url, None, sign_headers("GET", url, b"", self.session_key,
                                           self._key_id))
        if status != 200:
            raise RuntimeError(f"GET {path.split('?')[0]} -> HTTP {status}")
        return body

    def head_object(self, bucket: str, name: str) -> dict | None:
        url = (f"{self._base}/n/{self.namespace}/b/{bucket}/o/"
               f"{urllib.parse.quote(name, safe='/')}")
        status, hdrs, _ = http_call(
            "HEAD", url, None,
            sign_headers("HEAD", url, b"", self.session_key, self._key_id))
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"HEAD {name} -> HTTP {status}")
        return {k.lower(): v for k, v in hdrs.items()}

    def put_object(self, bucket: str, name: str, data: bytes,
                   sha256_hex: str) -> int:
        url = (f"{self._base}/n/{self.namespace}/b/{bucket}/o/"
               f"{urllib.parse.quote(name, safe='/')}")
        base = sign_headers("PUT", url, data, self.session_key, self._key_id)
        base["opc-meta-sha256"] = sha256_hex

        # 1) Atomik "uzerine yazma yok" denemesi (if-none-match).
        hdrs = dict(base, **{"if-none-match": "*"})
        status, _, resp = http_call("PUT", url, data, hdrs)
        if status in (409, 412):
            raise RuntimeError("CONFLICT: nesne zaten var (if-none-match)")
        if status == 400 and b"if-none-match" in resp.lower():
            # Servis basligi desteklemiyorsa HEAD on-kontrolune guven.
            status, _, resp = http_call("PUT", url, data, base)
        if status != 200:
            raise RuntimeError(f"PUT {name} -> HTTP {status}: "
                               f"{resp[:160].decode('utf-8', 'replace')}")
        return status

    def get_object(self, bucket: str, name: str) -> bytes:
        url = (f"{self._base}/n/{self.namespace}/b/{bucket}/o/"
               f"{urllib.parse.quote(name, safe='/')}")
        status, _, body = http_call(
            "GET", url, None,
            sign_headers("GET", url, b"", self.session_key, self._key_id))
        if status != 200:
            raise RuntimeError(f"GET {name} -> HTTP {status}")
        return body

    def bucket_list(self, compartment: str) -> tuple[int, bytes]:
        """Salt-okunur bucket listesi denemesi (yetki sondasi)."""
        url = (f"{self._base}/n/{self.namespace}/b"
               f"?compartmentId={compartment}")
        status, _, body = http_call(
            "GET", url, None,
            sign_headers("GET", url, b"", self.session_key, self._key_id))
        return status, body

    def bucket_meta(self, bucket: str) -> tuple[int, dict | None]:
        """Bucket metadata (publicAccessType, versioning, id)."""
        url = f"{self._base}/n/{self.namespace}/b/{bucket}"
        status, _, body = http_call(
            "GET", url, None,
            sign_headers("GET", url, b"", self.session_key, self._key_id))
        if status != 200:
            return status, None
        return status, json.loads(body)

    def head_bucket(self, bucket: str) -> int:
        url = f"{self._base}/n/{self.namespace}/b/{bucket}"
        status, _, _ = http_call(
            "HEAD", url, None,
            sign_headers("HEAD", url, b"", self.session_key, self._key_id))
        return status


# ------------------------------------------------------------------- helpers
def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def object_key(prefix: str, filename: str) -> str:
    m = SNAP_RE.match(filename)
    if not m:
        raise ValueError(f"beklenmeyen dosya adi: {filename}")
    ts = m.group("ts")
    return f"{prefix.rstrip('/')}/{ts[0:4]}/{ts[4:6]}/{ts[6:8]}/{filename}"


def collect(source: Path) -> list[dict]:
    items = []
    for p in sorted(source.iterdir()):
        if not p.is_file():
            continue
        if ESCROW_RE.match(p.name):
            # Escrow ASLA yuklenmez; sessizce atla degil, acikca bildir.
            items.append({"file": p.name, "action": "BLOCKED_ESCROW"})
            continue
        if not SNAP_RE.match(p.name):
            continue
        digest, size = sha256_file(p)
        items.append({"path": str(p), "file": p.name, "sha256": digest,
                      "bytes": size})
    return items


def audit(record: dict) -> None:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    if not AUDIT_LOG.exists():
        AUDIT_LOG.touch(mode=0o600)
    os.chmod(AUDIT_LOG, 0o600)
    with AUDIT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(),
                             **record}, ensure_ascii=False) + "\n")


# ------------------------------------------------------------------ commands
def cmd_inventory(args) -> int:
    items = collect(Path(args.source))
    print(json.dumps({"source": args.source, "items": items}, indent=2))
    return 0


def cmd_upload(args) -> int:
    source = Path(args.source)
    items = [i for i in collect(source) if i.get("action") != "BLOCKED_ESCROW"]
    escrow = [i["file"] for i in collect(source)
              if i.get("action") == "BLOCKED_ESCROW"]

    if args.only:
        wanted = set(args.only)
        unknown = wanted - {i["file"] for i in items}
        if unknown:
            print(f"[ABORT] bilinmeyen --only dosya: {sorted(unknown)}")
            return 2
        items = [i for i in items if i["file"] in wanted]

    plan = []
    for it in items:
        plan.append({"file": it["file"], "bytes": it["bytes"],
                     "sha256": it["sha256"],
                     "object": object_key(args.prefix, it["file"])})

    print(json.dumps({"bucket": args.bucket, "prefix": args.prefix,
                      "escrow_blocked": escrow, "plan": plan}, indent=2))

    if escrow:
        print(f"[GUARD] escrow dosyalari yuklenmeyecek: {escrow}")

    if not args.execute:
        print("\n[DRY-RUN] Ag yazimi yapilmadi. Gercek aktarim icin --execute "
              "+ TEZLIFY_OFFSITE_APPROVED=1 gerekir.")
        return 0

    if os.environ.get("TEZLIFY_OFFSITE_APPROVED") != "1":
        print("[GATE] TEZLIFY_OFFSITE_APPROVED=1 yok -> aktarim REDDEDILDI.")
        return 2

    p = Principal()
    results = []
    for it in items:
        key = object_key(args.prefix, it["file"])
        try:
            remote = p.head_object(args.bucket, key)
            if remote is not None:
                remote_sha = remote.get("opc-meta-sha256", "")
                if remote_sha == it["sha256"]:
                    results.append({"file": it["file"], "status": "ALREADY_PRESENT"})
                    audit({"file": it["file"], "action": "skip",
                           "sha256": it["sha256"]})
                    continue
                results.append({"file": it["file"], "status": "CONFLICT",
                                "remote_sha256": remote_sha,
                                "local_sha256": it["sha256"]})
                audit({"file": it["file"], "action": "conflict",
                       "sha256": it["sha256"]})
                print(f"[CONFLICT] {it['file']} uzakta farkli icerikle var; "
                      "uzerine YAZILMADI. Duruldu.")
                break

            data = Path(it["path"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != it["sha256"]:
                results.append({"file": it["file"], "status": "LOCAL_CHANGED"})
                break
            t0 = time.monotonic()
            p.put_object(args.bucket, key, data, it["sha256"])
            dt = time.monotonic() - t0
            remote = p.head_object(args.bucket, key) or {}
            results.append({"file": it["file"], "status": "UPLOADED",
                            "http": 200,
                            "seconds": round(dt, 2),
                            "local_bytes": it["bytes"],
                            "remote_bytes": int(remote.get("content-length", -1)),
                            "remote_meta_sha256": remote.get("opc-meta-sha256", "")})
            audit({"file": it["file"], "action": "upload",
                   "bytes": it["bytes"], "sha256": it["sha256"],
                   "object": key, "seconds": round(dt, 2)})
        except Exception as exc:  # noqa: BLE001
            results.append({"file": it["file"], "status": "FAILED",
                            "error": f"{type(exc).__name__}: {exc}"})
            audit({"file": it["file"], "action": "failed",
                   "error": f"{type(exc).__name__}: {exc}"})
            break

    print(json.dumps({"results": results}, indent=2))
    bad = [r for r in results if r["status"] in ("FAILED", "CONFLICT",
                                                 "LOCAL_CHANGED")]
    return 1 if bad else 0


def cmd_verify(args) -> int:
    source = Path(args.source)
    items = [i for i in collect(source) if i.get("action") != "BLOCKED_ESCROW"]
    if getattr(args, "only", None):
        wanted = set(args.only)
        items = [i for i in items if i["file"] in wanted]
    p = Principal()
    rows, ok = [], True
    for it in items:
        key = object_key(args.prefix, it["file"])
        try:
            remote = p.head_object(args.bucket, key)
            if remote is None:
                rows.append({"file": it["file"], "status": "MISSING"}); ok = False
                continue
            remote_sha = remote.get("opc-meta-sha256", "")
            if args.download_check:
                body = p.get_object(args.bucket, key)
                actual = hashlib.sha256(body).hexdigest()
                size_ok = len(body) == it["bytes"]
                match = actual == it["sha256"]
                rows.append({"file": it["file"], "status":
                             "VERIFIED" if (match and size_ok) else "HASH_MISMATCH",
                             "remote_sha256": actual,
                             "local_sha256": it["sha256"],
                             "local_bytes": it["bytes"],
                             "downloaded_bytes": len(body),
                             "size_match": size_ok})
                ok = ok and match and size_ok
            else:
                match = remote_sha == it["sha256"]
                remote_bytes = int(remote.get("content-length", -1))
                rows.append({"file": it["file"], "status":
                             "VERIFIED" if match else "META_MISMATCH",
                             "remote_sha256": remote_sha,
                             "local_sha256": it["sha256"],
                             "local_bytes": it["bytes"],
                             "remote_bytes": remote_bytes,
                             "size_match": remote_bytes == it["bytes"]})
                ok = ok and match and remote_bytes == it["bytes"]
        except Exception as exc:  # noqa: BLE001
            rows.append({"file": it["file"], "status": "FAILED",
                         "error": f"{type(exc).__name__}: {exc}"})
            ok = False
    print(json.dumps({"rows": rows, "all_verified": ok}, indent=2))
    return 0 if ok else 1


def cmd_probe(args) -> int:
    """Bölüm A: instance principal yetki sondasi (salt okunur)."""
    p = Principal()
    print(f"region          = {p.region}")
    print(f"namespace       = {p.namespace}")
    status, body = p.bucket_list(args.compartment or p.tenancy)
    print(f"bucket_list     = HTTP {status}")
    if status == 200:
        buckets = json.loads(body)
        print(f"bucket_sayisi   = {len(buckets)}")
        for b in buckets:
            print(f"  - {b.get('name')} public={b.get('publicAccessType')} "
                  f"created={b.get('timeCreated')}")
        if args.bucket:
            st2, meta = p.bucket_meta(args.bucket)
            print(f"\nbucket_meta({args.bucket}) = HTTP {st2}")
            if meta:
                print(f"  id              = {meta.get('id')}")
                print(f"  publicAccessType= {meta.get('publicAccessType')}")
                print(f"  versioning      = {meta.get('versioning')}")
                print(f"  storageTier     = {meta.get('storageTier')}")
                print(f"  compartmentId   = {meta.get('compartmentId')}")
                print(f"  namespace       = {meta.get('namespace')}")
            print(f"bucket_head({args.bucket}) = HTTP {p.head_bucket(args.bucket)}")
        return 0
    print(f"bucket_list_hata= {body[:180].decode('utf-8', 'replace')}")
    return 3


def cmd_list(args) -> int:
    p = Principal()
    url = (f"{p._base}/n/{p.namespace}/b/{args.bucket}/o"
           f"?prefix={urllib.parse.quote(args.prefix, safe='')}"
           f"&fields=name,size,timeCreated&limit=1000")
    status, _, body = http_call(
        "GET", url, None,
        sign_headers("GET", url, b"", p.session_key, p._key_id))
    if status != 200:
        print(f"LIST FAILED HTTP {status}: {body[:200].decode('utf-8','replace')}")
        return 3
    objs = json.loads(body).get("objects", [])
    total = 0
    escrow_hits = []
    for o in objs:
        total += int(o.get("size", 0))
        name = o.get("name", "")
        if "escrow" in name.lower() or "key" in name.lower():
            escrow_hits.append(name)
        print(f"  {name}  {o.get('size')} B  {o.get('timeCreated')}")
    print(f"\nnesne_sayisi = {len(objs)}")
    print(f"toplam_bayt  = {total}")
    print(f"escrow_izi   = {escrow_hits if escrow_hits else 'YOK'}")
    return 0


def cmd_download(args) -> int:
    p = Principal()
    key = object_key(args.prefix, args.file)
    body = p.get_object(args.bucket, key)
    digest = hashlib.sha256(body).hexdigest()
    local, _ = sha256_file(Path(args.source) / args.file)
    print(f"object      = {key}")
    print(f"bytes       = {len(body)}")
    print(f"sha256      = {digest}")
    print(f"local_sha256= {local}")
    print(f"match       = {digest == local}")
    if digest != local:
        return 1
    out = Path(args.out)
    out.write_bytes(body)
    os.chmod(out, 0o600)
    print(f"yazildi     = {out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Tezlify off-site snapshot aktarimi")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("inventory", help="yerel envanter + sha256 (salt okunur)")
    s.add_argument("--source", default="/var/backups/tezlify-ram")
    s.set_defaults(func=cmd_inventory)

    pr = sub.add_parser("probe", help="instance principal yetki sondasi")
    pr.add_argument("--compartment", default=None)
    pr.add_argument("--bucket", default=None,
                    help="bucket metadata'sini da oku")
    pr.set_defaults(func=cmd_probe)

    u = sub.add_parser("upload", help="bucket'a yukle (idempotent, fail-closed)")
    u.add_argument("--source", default="/var/backups/tezlify-ram")
    u.add_argument("--bucket", required=True)
    u.add_argument("--prefix", default="tezlify/whatsapp/ram-snapshots")
    u.add_argument("--execute", action="store_true")
    u.add_argument("--only", action="append", default=None,
                   help="yalnizca bu dosya(lar)i isle (tekrarlanabilir)")
    u.set_defaults(func=cmd_upload)

    v = sub.add_parser("verify", help="uzak kopyalari dogrula")
    v.add_argument("--source", default="/var/backups/tezlify-ram")
    v.add_argument("--bucket", required=True)
    v.add_argument("--prefix", default="tezlify/whatsapp/ram-snapshots")
    v.add_argument("--download-check", action="store_true",
                   help="uzaktan indirip sha256 karsilastir")
    v.add_argument("--only", action="append", default=None,
                   help="yalnizca bu dosya(lar)i dogrula")
    v.set_defaults(func=cmd_verify)

    ls = sub.add_parser("ls", help="bucket icerigini listele (escrow kontrolu)")
    ls.add_argument("--bucket", required=True)
    ls.add_argument("--prefix", default="tezlify/whatsapp/ram-snapshots")
    ls.set_defaults(func=cmd_list)

    dl = sub.add_parser("download", help="uzak nesneyi indir + sha256 dogrula")
    dl.add_argument("--bucket", required=True)
    dl.add_argument("--file", required=True)
    dl.add_argument("--out", required=True)
    dl.add_argument("--source", default="/var/backups/tezlify-ram")
    dl.add_argument("--prefix", default="tezlify/whatsapp/ram-snapshots")
    dl.set_defaults(func=cmd_download)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
