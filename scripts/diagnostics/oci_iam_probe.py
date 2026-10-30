#!/usr/bin/env python3
"""OCI IAM + Object Storage hata ayrimi (SALT OKUNUR).

Amac: `404 NamespaceNotFound` sonucunu koru korune "yetki yok" saymamak.
Her olasilik ayri bir istekle sinanir:
  - namespace gercekten var mi?            (GET /n/)
  - compartment parametresi isleniyor mu?  (gecersiz OCID -> 400 beklenir)
  - bucket adi bilinmeden ne donuyor?      (HEAD /b/<ad>)
  - IAM okunabiliyor mu?                   (dynamicGroups / policies / compartments)
IAM okunamazsa "NOT VERIFIED" — tahmin uretilmez.

Hicbir kaynak olusturulmaz/degistirilmez. Token/secret basilmaz.
"""
from __future__ import annotations

import base64
import hashlib
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import format_datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

IMDS = "http://169.254.169.254/opc/v2"
IMDS_HDR = {"Authorization": "Bearer Oracle"}
INVALID_COMPARTMENT = (
    "ocid1.compartment.oc1.." + "a" * 64
)


def imds(path: str) -> bytes:
    req = urllib.request.Request(IMDS + path, headers=IMDS_HDR)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read()


def sign(method, url, body, key, key_id, content_type=None):
    parts = urllib.parse.urlsplit(url)
    target = parts.path + (("?" + parts.query) if parts.query else "")
    h = {
        "date": format_datetime(datetime.now(timezone.utc), usegmt=True),
        "(request-target)": f"{method.lower()} {target}",
        "host": parts.netloc,
    }
    if method in ("PUT", "POST"):
        h["content-length"] = str(len(body or b""))
        h["content-type"] = content_type or "application/json"
        h["x-content-sha256"] = base64.b64encode(
            hashlib.sha256(body or b"").digest()).decode()
    order = list(h)
    ss = "\n".join(f"{k}: {h[k]}" for k in order)
    sig = key.sign(ss.encode(), padding.PKCS1v15(), hashes.SHA256())
    out = {
        "date": h["date"],
        "authorization": (
            'Signature version="1",'
            f'keyId="{key_id}",algorithm="rsa-sha256",'
            f'headers="{" ".join(order)}",'
            f'signature="{base64.b64encode(sig).decode()}"'
        ),
    }
    for k in ("content-length", "content-type", "x-content-sha256"):
        if k in h:
            out[k] = h[k]
    return out


def call(method, url, key, key_id, body=None, ctype=None):
    hdrs = sign(method, url, body, key, key_id, ctype)
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def brief(raw: bytes) -> str:
    try:
        d = json.loads(raw)
        if isinstance(d, dict):
            code = d.get("code", "")
            msg = str(d.get("message", ""))[:110]
            return f"code={code} msg={msg}"
        return f"json list len={len(d)}"
    except Exception:
        return raw[:110].decode("utf-8", "replace").replace("\n", " ")


def main() -> int:
    region = imds("/instance/region").decode().strip().lower()
    inst = json.loads(imds("/instance/"))
    tenancy = inst["tenantId"]
    compartment = inst.get("compartmentId")
    instance_id = inst["id"]
    cert_pem = imds("/identity/cert.pem")
    leaf_pem = imds("/identity/key.pem")
    inter_pem = imds("/identity/intermediate.pem")

    cert = x509.load_pem_x509_certificate(cert_pem)
    fp = ":".join(f"{b:02X}" for b in cert.fingerprint(hashes.SHA1()))
    leaf = serialization.load_pem_private_key(leaf_pem, password=None)
    sk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = sk.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    body = json.dumps({
        "certificate": cert_pem.decode(),
        "publicKey": pub,
        "intermediateCertificates": [inter_pem.decode()],
    }).encode()
    auth_url = f"https://auth.{region}.oraclecloud.com/v1/x509"
    st, resp = call("POST", auth_url, leaf, f"{tenancy}/fed-x509/{fp}",
                    body, "application/json")
    if st != 200:
        print(f"TOKEN FAIL HTTP {st} {brief(resp)}")
        return 2
    token = json.loads(resp)["token"]
    kid = "ST$" + token

    os_base = f"https://objectstorage.{region}.oraclecloud.com"
    iam_base = f"https://identity.{region}.oraclecloud.com/20160918"

    print("== KIMLIK ==")
    print(f"region        = {region}")
    print(f"instance      = {inst.get('displayName')}")
    print(f"shape         = {inst.get('shape')}")
    print(f"instance_id   = {instance_id}")
    print(f"tenancy       = {tenancy}")
    print(f"compartment   = {compartment}")
    print(f"tenancy==comp = {tenancy == compartment}")

    st, resp = call("GET", os_base + "/n/", sk, kid)
    namespace = resp.decode().strip().strip('"') if st == 200 else None
    print(f"\n== OBJECT STORAGE ==")
    print(f"[1] GET /n/                          -> {st}  namespace={namespace}")

    if namespace:
        cases = [
            ("[2] list buckets (tenancy compartment)",
             f"/n/{namespace}/b?compartmentId={tenancy}"),
            ("[3] list buckets (limit=1)",
             f"/n/{namespace}/b?compartmentId={tenancy}&limit=1"),
            ("[4] list buckets (INVALID compartment)",
             f"/n/{namespace}/b?compartmentId={INVALID_COMPARTMENT}"),
            ("[5] list buckets (no compartment)",
             f"/n/{namespace}/b"),
            ("[6] namespace metadata", f"/n/{namespace}/"),
        ]
        for label, path in cases:
            st, resp = call("GET", os_base + path, sk, kid)
            print(f"{label:<44} -> {st}  {brief(resp)}")

        st, resp = call(
            "HEAD", os_base + f"/n/{namespace}/b/tezlify-ram-snapshots", sk, kid)
        print(f"[7] HEAD bucket tezlify-ram-snapshots      -> {st}")

    print(f"\n== IAM (read-only) ==")
    iam_cases = [
        ("[8]  dynamicGroups", f"/dynamicGroups?compartmentId={tenancy}"),
        ("[9]  policies", f"/policies?compartmentId={tenancy}"),
        ("[10] compartments", f"/compartments?compartmentId={tenancy}"),
        ("[11] tenancy", f"/tenancies/{tenancy}"),
    ]
    iam_ok = 0
    for label, path in iam_cases:
        st, resp = call("GET", iam_base + path, sk, kid)
        if st == 200:
            iam_ok += 1
        print(f"{label:<44} -> {st}  {brief(resp)}")

    print(f"\n== OZET ==")
    print(f"namespace_ok = {namespace is not None}")
    print(f"iam_readable = {iam_ok}/{len(iam_cases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
