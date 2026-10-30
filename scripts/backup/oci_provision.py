#!/usr/bin/env python3
"""OCI kaynak kurulumu — user principal (yerel `~/.oci/config`).

Kapsam (kullanici onayi 3.9.10) YALNIZCA uc kaynak:
  1. dynamic group  : tezlify-offsite-dg
  2. policy         : tezlify-offsite-policy  (2 statement)
  3. bucket         : tezlify-ram-snapshots (NoPublicAccess, versioning Enabled)

Idempotent: ayni isimde kaynak varsa ikinci kez OLUSTURMAZ.
  - DG kurali farkliysa  -> CONFLICT, dokunmaz
  - Policy statement farkli -> CONFLICT, dokunmaz
  - Bucket ayari farkli  -> yalnizca bu bucket'ta duzeltir

Kullanim:
  oci_provision.py inspect
  oci_provision.py apply --execute

Anahtar/parmak izi ASLA basilmez. `--execute` olmadan yazma yok.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

TENANCY = "ocid1.tenancy.oc1..aaaaaaaauvyjjnzy7z74yqu3bkohjoxoaniba7a7o2oxzz4qynmttbxw5pzq"
INSTANCE = ("ocid1.instance.oc1.eu-frankfurt-1."
            "antheljtzhfthiicm3e2y7hslvnc65afnkpknawogwctisk5yyv3b2jbxo2a")
REGION = "eu-frankfurt-1"
DG_NAME = "tezlify-offsite-dg"
POLICY_NAME = "tezlify-offsite-policy"
BUCKET = "tezlify-ram-snapshots"
DG_RULE = f"instance.id = '{INSTANCE}'"
STATEMENTS = [
    (f"Allow dynamic-group {DG_NAME} to read buckets in compartment id {TENANCY}"),
    (f"Allow dynamic-group {DG_NAME} to manage objects in compartment id {TENANCY} "
     f"where target.bucket.name = '{BUCKET}'"),
]
IAM = f"https://identity.{REGION}.oraclecloud.com/20160918"
OS = f"https://objectstorage.{REGION}.oraclecloud.com"


# ------------------------------------------------------------------ kimlik
def load_config(profile: str = "DEFAULT") -> dict:
    path = Path(os.path.expanduser("~/.oci/config"))
    if not path.exists():
        raise SystemExit("~/.oci/config yok — user principal kullanilamaz")
    cfg, cur = {}, None
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("[") and s.endswith("]"):
            cur = s[1:-1].strip()
            continue
        if "=" in s and cur == profile:
            k, v = s.split("=", 1)
            cfg[k.strip()] = v.strip()
    for need in ("user", "fingerprint", "tenancy", "key_file"):
        if need not in cfg:
            raise SystemExit(f"config eksik alan: {need}")
    cfg["key_file"] = os.path.expanduser(cfg["key_file"])
    return cfg


def sign(method, url, body, cfg, key):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    parts = urllib.parse.urlsplit(url)
    target = parts.path + (("?" + parts.query) if parts.query else "")
    h = {
        "date": format_datetime(datetime.now(timezone.utc), usegmt=True),
        "(request-target)": f"{method.lower()} {target}",
        "host": parts.netloc,
    }
    if body is not None:
        h["content-length"] = str(len(body))
        h["content-type"] = "application/json"
        h["x-content-sha256"] = base64.b64encode(
            hashlib.sha256(body).digest()).decode()
    order = list(h)
    ss = "\n".join(f"{k}: {h[k]}" for k in order)
    sig = key.sign(ss.encode(), padding.PKCS1v15(), hashes.SHA256())
    key_id = f"{cfg['tenancy']}/{cfg['user']}/{cfg['fingerprint']}"
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


def call(method, url, cfg, key, body=None):
    raw = json.dumps(body).encode() if body is not None else None
    hdrs = sign(method, url, raw, cfg, key)
    req = urllib.request.Request(url, data=raw, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60,
                                    context=ssl.create_default_context()) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def brief(raw: bytes, limit: int = 200) -> str:
    try:
        d = json.loads(raw)
    except Exception:
        return raw[:limit].decode("utf-8", "replace").replace("\n", " ")
    if isinstance(d, dict):
        return f"code={d.get('code')} msg={str(d.get('message'))[:limit]}"
    return f"list[{len(d)}]"


# ------------------------------------------------------------------ sorgular
def get_namespace(cfg, key):
    st, resp = call("GET", f"{OS}/n/", cfg, key)
    if st != 200:
        raise SystemExit(f"namespace alinamadi: HTTP {st} {brief(resp)}")
    return resp.decode().strip().strip('"')


def find_dg(cfg, key):
    st, resp = call("GET", f"{IAM}/dynamicGroups?compartmentId={TENANCY}", cfg, key)
    if st != 200:
        raise SystemExit(f"dynamicGroups okunamadi: HTTP {st} {brief(resp)}")
    for dg in json.loads(resp):
        if dg.get("name") == DG_NAME and dg.get("lifecycleState") == "ACTIVE":
            # Liste ucu `matchingRule` DONDURMEZ; tek-kaynak GET gerekir.
            st2, resp2 = call("GET", f"{IAM}/dynamicGroups/{dg['id']}", cfg, key)
            if st2 == 200:
                return json.loads(resp2)
            return dg
    return None


def find_policy(cfg, key):
    st, resp = call("GET", f"{IAM}/policies?compartmentId={TENANCY}", cfg, key)
    if st != 200:
        raise SystemExit(f"policies okunamadi: HTTP {st} {brief(resp)}")
    for p in json.loads(resp):
        if p.get("name") == POLICY_NAME and p.get("lifecycleState") == "ACTIVE":
            return p
    return None


def get_bucket(cfg, key, ns):
    st, resp = call("GET", f"{OS}/n/{ns}/b/{BUCKET}", cfg, key)
    if st == 200:
        return json.loads(resp)
    if st == 404:
        return None
    raise SystemExit(f"bucket sorgusu: HTTP {st} {brief(resp)}")


# ------------------------------------------------------------------ komutlar
def cmd_inspect(args) -> int:
    from cryptography.hazmat.primitives import serialization

    cfg = load_config(args.profile)
    key = serialization.load_pem_private_key(
        Path(cfg["key_file"]).read_bytes(), password=None)
    print(f"user_principal region={cfg['region']} (anahtar basilmadi)")
    ns = get_namespace(cfg, key)
    print(f"namespace = {ns}")

    dg = find_dg(cfg, key)
    if dg:
        print(f"\nDG VAR   id={dg['id']}")
        print(f"         rule={dg.get('matchingRule')}")
        print(f"         rule_matches={dg.get('matchingRule') == DG_RULE}")
    else:
        print(f"\nDG YOK   ({DG_NAME})")

    pol = find_policy(cfg, key)
    if pol:
        print(f"\nPOLICY VAR id={pol['id']}")
        for s in pol.get("statements", []):
            print(f"         stmt: {s}")
        print(f"         statements_match={set(pol.get('statements', [])) == set(STATEMENTS)}")
    else:
        print(f"\nPOLICY YOK ({POLICY_NAME})")

    b = get_bucket(cfg, key, ns)
    if b:
        print(f"\nBUCKET VAR id={b.get('id')}")
        print(f"         publicAccessType={b.get('publicAccessType')} "
              f"versioning={b.get('versioning')} tier={b.get('storageTier')}")
        print(f"         compartmentId={b.get('compartmentId')}")
    else:
        print(f"\nBUCKET YOK ({BUCKET})")
    return 0


def cmd_apply(args) -> int:
    from cryptography.hazmat.primitives import serialization

    cfg = load_config(args.profile)
    key = serialization.load_pem_private_key(
        Path(cfg["key_file"]).read_bytes(), password=None)
    if not args.execute:
        print("[DRY-RUN] Yazma yapilmadi. Gercek kurulum icin --execute.")
        return 0

    ns = get_namespace(cfg, key)
    print(f"namespace = {ns}")
    rc = 0

    # 1) Dynamic group
    dg = find_dg(cfg, key)
    if dg:
        if dg.get("matchingRule") == DG_RULE:
            print(f"[DG]      mevcut, kural ayni -> SKIP ({dg['id']})")
        else:
            print(f"[DG]      CONFLICT: mevcut kural farkli -> DOKUNULMADI")
            print(f"          mevcut : {dg.get('matchingRule')}")
            print(f"          beklenen: {DG_RULE}")
            rc = 3
    else:
        st, resp = call("POST", f"{IAM}/dynamicGroups", cfg, key, {
            "compartmentId": TENANCY,
            "name": DG_NAME,
            "description": "Tezlify off-site RAM snapshot erisimi (3.9.10)",
            "matchingRule": DG_RULE,
        })
        if st in (200, 201):
            d = json.loads(resp)
            print(f"[DG]      CREATED id={d['id']}")
        else:
            print(f"[DG]      FAILED HTTP {st} {brief(resp)}")
            rc = 4

    # 2) Policy (tek obje, iki statement)
    pol = find_policy(cfg, key)
    if pol:
        if set(pol.get("statements", [])) == set(STATEMENTS):
            print(f"[POLICY]  mevcut, statement'lar ayni -> SKIP ({pol['id']})")
        else:
            print("[POLICY]  CONFLICT: mevcut statement'lar farkli -> DOKUNULMADI")
            for s in pol.get("statements", []):
                print(f"          mevcut  : {s}")
            for s in STATEMENTS:
                print(f"          beklenen: {s}")
            rc = 3
    else:
        st, resp = call("POST", f"{IAM}/policies", cfg, key, {
            "compartmentId": TENANCY,
            "name": POLICY_NAME,
            "description": "Tezlify off-site snapshot bucket erisimi (3.9.10)",
            "statements": STATEMENTS,
        })
        if st in (200, 201):
            d = json.loads(resp)
            print(f"[POLICY]  CREATED id={d['id']}")
            for s in d.get("statements", []):
                print(f"          stmt: {s}")
        else:
            print(f"[POLICY]  FAILED HTTP {st} {brief(resp)}")
            rc = 4

    # 3) Bucket
    b = get_bucket(cfg, key, ns)
    if b:
        need_fix = (b.get("publicAccessType") != "NoPublicAccess"
                    or b.get("versioning") != "Enabled")
        if need_fix:
            st, resp = call("PUT", f"{OS}/n/{ns}/b/{BUCKET}", cfg, key, {
                "publicAccessType": "NoPublicAccess",
                "versioning": "Enabled",
            })
            if st == 200:
                print(f"[BUCKET]  FIXED id={json.loads(resp).get('id')}")
            else:
                print(f"[BUCKET]  FIX FAILED HTTP {st} {brief(resp)}")
                rc = 4
        else:
            print(f"[BUCKET]  mevcut, ayarlar dogru -> SKIP ({b.get('id')})")
    else:
        st, resp = call("POST", f"{OS}/n/{ns}/b", cfg, key, {
            "name": BUCKET,
            "compartmentId": TENANCY,
            "publicAccessType": "NoPublicAccess",
            "storageTier": "Standard",
            "versioning": "Enabled",
            "objectEventsEnabled": False,
        })
        if st in (200, 201):
            d = json.loads(resp)
            print(f"[BUCKET]  CREATED id={d.get('id')}")
        else:
            print(f"[BUCKET]  FAILED HTTP {st} {brief(resp)}")
            rc = 4

    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="OCI 3.9.10 kaynak kurulumu")
    ap.add_argument("--profile", default="DEFAULT")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("inspect")
    s.set_defaults(func=cmd_inspect)
    a = sub.add_parser("apply")
    a.add_argument("--execute", action="store_true")
    a.set_defaults(func=cmd_apply)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
