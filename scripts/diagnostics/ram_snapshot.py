"""Gateway RAM'indeki mesajlari SALT OKUNUR bicimde disa aktarir.

## Neden bu betik var

Gateway `messagesByChat` deposu RAM'de tutulur ve restart'ta geri yuklenmez
(A6). Sohbet basina 2.000 sinirina ulasan sohbetlerde yeni mesaj geldikce en
eskiler sessizce atilir; yani beklemek veri kaybettirir. Bu betik, kaybetmeden
ONCE mevcut kayitlari geri yuklenebilir bir dosyaya cikarir.

## Neden offset aritmetigi KULLANILMAZ

`listAllMessages` her istekte listeyi yeniden siralar. Arada yeni bir mesaj
gelirse `offset` kayar: bir sayfa bir kaydi ATLAR, digeri AYNISINI iki kez
dondurur. Bu, Asama 3.6b'deki "sinirli tur + cursor yok" hatasinin ayni
sinifidir. Bu yuzden sayfalama KIMLIK KUMESI uzerinden yapilir: hedef sohbet
icin `total` sayisina ulasilana (veya kimlik kumesi iki turda degismez hale
gelene) kadar tur atilir; tekrarlar kimlige gore ayiklanir.

## Tutarlilik

Canli trafik export sirasinda devam eder. Sozlesme:

* `started_at` ile `ended_at` arasinda alinan her sey snapshot'a girer.
* `created_at` degeri `started_at`'ten YENI olan kayitlar `late_arrival`
  sayilir; snapshot gecerlidir ama "su ana kadar" degil "bu aralikta" der.
* Her sohbet icin `stable` bayragi: son turda yeni kimlik gelmediyse true.
  `stable=false` olan sohbet icin "tam" denmez.

## Gizlilik

Snapshot mesaj govdesi ve telefon icerir. Bu yuzden:

* Varsayilan cikti `-` (stdout); dosyaya yazmak icin `--out` + acik izin.
* Git deposu icindeki bir yola duz metin yazmak REDDEDILIR.
* Sifreleme `--encrypt-key-env` ile ZORUNLU kilinabilir. Anahtar argv'den
  okunmaz (ps gormez), dosyaya yazilmaz; yalnizca ortam degiskeninden okunur.
  Sema repo'nun mevcut `encrypted-codec.js` semasidir: sha256(key) -> 32 bayt,
  AES-256-GCM, 12 bayt nonce, AAD.
* Manifest mesaj icerigi TASIMAZ; yalnizca sayilar ve hash'ler. Git'e
  konabilir.

## Geri yukleme

`--restore-to` yalnizca GECICI bir SQLite dosyasina yazar ve kimlik kumesinin
birebir korundugunu dogrular. Uretim DB'sine yazmaz: `DATABASE_URL` postgres
ise betik reddeder.

Kullanim (uretim host'unda, backend konteyneri icinde):

    docker exec -i tezlify-backend python - --out - --allow-plaintext \\
        < scripts/diagnostics/ram_snapshot.py

Cikis kodlari:
    0 = basarili
    1 = kullanici hatasi / guvenlik kapisi reddetti
    2 = olcum veya yazma hatasi
    3 = butunluk dogrulamasi basarisiz
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SNAPSHOT_SCHEMA = 1
SNAPSHOT_KIND = "tezlify.ram_snapshot"
AAD = b"tezlify.ram-snapshot:v1"
MAGIC = b"RSNAP1"

# Sayfalama sinirlari. `MAX_ROUNDS` bir sohbet icin kac kez "eksik kalanlari
# tamamla" turu atilacagini sinirlar; sonsuz donguye karsi emniyet.
PAGE_SIZE = 2000
MAX_ROUNDS = 40


# --------------------------------------------------------------------------
# Kimlik
# --------------------------------------------------------------------------
def identity_of(record: Mapping[str, Any]) -> Optional[Tuple[str, str]]:
    """(conversation_id, wa_message_id) ya da kimlik kurulamazsa None.

    `wa_message_id` olmadan bir kayit geri yuklenemez: DB'de tekillik
    `(conversation_id, wa_message_id)` uzerindedir ve kimliksiz satir her
    turda yeniden eklenir. Bu yuzden kimliksiz kayit SESSIZCE dusurulmez,
    ayri sayilir.
    """
    conv = record.get("conversation_id")
    wa = record.get("wa_message_id")
    if conv is None or conv == "":
        return None
    if wa is None or str(wa).strip() == "":
        return None
    return (str(conv), str(wa))


def identity_token(identity: Tuple[str, str]) -> str:
    """Kimligin kisa, geri donusturulemez etiketi (rapor/log icin)."""
    return hashlib.sha256(f"{identity[0]}\0{identity[1]}".encode("utf-8")).hexdigest()[:32]


def _canonical(record: Mapping[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# --------------------------------------------------------------------------
# Dogrulama / ayiklama
# --------------------------------------------------------------------------
def is_complete(record: Mapping[str, Any]) -> bool:
    """Kayit geri yuklenebilir mi?

    `body` anahtarinin HIC olmamasi bozuk kayittir; `body: ""` ise mesru
    olabilir (medya, kupur yok). Ikisini ayirmak sart, yoksa medya
    mesajlarinin tamami "eksik" sayilirdi.
    """
    if not isinstance(record, Mapping):
        return False
    if identity_of(record) is None:
        return False
    if "body" not in record:
        return False
    created = record.get("created_at")
    if not isinstance(created, str) or not created:
        return False
    try:
        time.strptime(created.replace("Z", "").split("+")[0].split(".")[0], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return False
    return True


def dedupe(records: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
    """Kimlige gore tekillestirir; ne atildigini SAYAR, sessizce dusurmez."""
    unique: Dict[Tuple[str, str], Dict[str, Any]] = {}
    duplicates = 0
    rejected_missing_identity = 0
    rejected_incomplete = 0
    for rec in records:
        ident = identity_of(rec) if isinstance(rec, Mapping) else None
        if ident is None:
            rejected_missing_identity += 1
            continue
        if not is_complete(rec):
            rejected_incomplete += 1
            continue
        if ident in unique:
            duplicates += 1
            # Ilk geleni koru: sayfalama sirasinda ilk okunan kayit, o an
            # gateway'in gosterdigi haldir; sonraki kopya ayni kimliktir.
            continue
        unique[ident] = dict(rec)
    return {
        "records": list(unique.values()),
        "duplicates": duplicates,
        "rejected_missing_identity": rejected_missing_identity,
        "rejected_incomplete": rejected_incomplete,
    }


# --------------------------------------------------------------------------
# Sayfalama (kimlik kumesi uzerinden)
# --------------------------------------------------------------------------
async def collect_chat(
    fetch: Callable[..., Any],
    jid: str,
    *,
    page_size: int = PAGE_SIZE,
    max_rounds: int = MAX_ROUNDS,
) -> Dict[str, Any]:
    """Tek sohbet icin TUM kimlikleri toplar.

    `fetch(jid=..., limit=..., offset=...)` -> {"messages": [...], "total": n}
    bekler. Dongu `total`a ULASMAYA calisir; ulasamazsa `stable=False` ve
    `shortfall` ile durur — "topladim" demez.
    """
    collected: Dict[Tuple[str, str], Dict[str, Any]] = {}
    reported_total = None
    rounds = 0
    stable = False
    for round_no in range(max_rounds):
        rounds = round_no + 1
        offset = 0
        before = len(collected)
        while True:
            page = await fetch(jid=jid, limit=page_size, offset=offset)
            msgs = (page or {}).get("messages") or []
            reported_total = int((page or {}).get("total") or 0)
            for m in msgs:
                ident = identity_of(m) if isinstance(m, Mapping) else None
                if ident is not None and ident not in collected:
                    collected[ident] = dict(m)
            if not msgs or offset + page_size >= reported_total:
                break
            offset += page_size
        # Iki tur ust uste ayni sayiyi verdiyse kimlik kumesi oturdu.
        if len(collected) >= reported_total or len(collected) == before:
            stable = len(collected) >= reported_total
            break
    return {
        "jid": jid,
        "records": list(collected.values()),
        "reported_total": reported_total,
        "collected": len(collected),
        "rounds": rounds,
        "stable": stable,
        "shortfall": None if reported_total is None else max(0, reported_total - len(collected)),
    }


# --------------------------------------------------------------------------
# Manifest (icerik tasimaz)
# --------------------------------------------------------------------------
def build_manifest(
    *,
    session_id: int,
    gateway_id: str,
    source_container_id: Optional[str],
    started_at: str,
    ended_at: str,
    per_chat: Sequence[Mapping[str, Any]],
    records: Sequence[Mapping[str, Any]],
    duplicates: int,
    rejected_missing_identity: int,
    rejected_incomplete: int,
    unmapped_conversations: Sequence[str] = (),
    late_arrival: int = 0,
) -> Dict[str, Any]:
    """Ozet + butunluk. Govde/telefon YOK; yalnizca sayi ve hash."""
    identities = sorted(identity_token(identity_of(r)) for r in records)  # type: ignore[arg-type]
    identity_root = hashlib.sha256("\n".join(identities).encode("utf-8")).hexdigest()
    body = "\n".join(_canonical(r) for r in records)
    chats = sorted(per_chat, key=lambda c: str(c.get("jid")))
    return {
        "schema": SNAPSHOT_SCHEMA,
        "kind": SNAPSHOT_KIND,
        "started_at": started_at,
        "ended_at": ended_at,
        "session_id": session_id,
        "gateway_id_prefix": str(gateway_id)[:8],
        "source_container_id": source_container_id,
        "chat_count": len(chats),
        "record_count": len(records),
        "records_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "identity_root_sha256": identity_root,
        "duplicates_removed": duplicates,
        "rejected_missing_identity": rejected_missing_identity,
        "rejected_incomplete": rejected_incomplete,
        "unmapped_conversation_count": len(unmapped_conversations),
        "late_arrival_count": late_arrival,
        "unstable_chats": [str(c.get("jid")) for c in chats if not c.get("stable")],
        "chats": [
            {
                "jid_hash": hashlib.sha256(str(c.get("jid")).encode("utf-8")).hexdigest()[:16],
                "collected": c.get("collected"),
                "reported_total": c.get("reported_total"),
                "stable": bool(c.get("stable")),
                "shortfall": c.get("shortfall"),
                "rounds": c.get("rounds"),
            }
            for c in chats
        ],
    }


def verify_snapshot(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Bozuk/eksik snapshot'i REDDEDER; 'kismen iyi' diye kabul etmez."""
    problems: List[str] = []
    if not isinstance(payload, Mapping):
        return {"ok": False, "problems": ["snapshot bir nesne degil"]}
    if payload.get("kind") != SNAPSHOT_KIND:
        problems.append("kind uyusmuyor")
    if payload.get("schema") != SNAPSHOT_SCHEMA:
        problems.append("schema uyusmuyor")
    records = payload.get("records")
    manifest = payload.get("manifest")
    if not isinstance(records, list):
        problems.append("records listesi yok")
        records = []
    if not isinstance(manifest, Mapping):
        problems.append("manifest yok")
        manifest = {}
    for i, rec in enumerate(records):
        if not is_complete(rec):
            problems.append(f"kayit {i} eksik/bozuk")
            if len(problems) > 20:
                problems.append("... (kirpildi)")
                break
    # Yinelenen kimlik: disa aktarici zaten tekillestirir, dolayisiyla bir
    # snapshot'ta yinelenen kimlik varsa ya dosya elle degistirilmistir ya da
    # iki farkli sohbet ayni anahtara dusmustur. Ikisi de geri yuklemede
    # satir kaybina yol acar, bu yuzden REDDEDILIR.
    idents_all = [identity_of(r) for r in records if identity_of(r) is not None]
    if len(set(idents_all)) != len(idents_all):
        problems.append("yinelenen kimlik var (snapshot bozuk)")

    if manifest:
        if int(manifest.get("record_count", -1)) != len(records):
            problems.append("record_count uyusmuyor")
        body = "\n".join(_canonical(r) for r in records)
        if hashlib.sha256(body.encode("utf-8")).hexdigest() != manifest.get("records_sha256"):
            problems.append("records_sha256 uyusmuyor (icerik degismis/bozulmus)")
        idents = sorted(
            identity_token(identity_of(r)) for r in records if identity_of(r) is not None  # type: ignore[arg-type]
        )
        if hashlib.sha256("\n".join(idents).encode("utf-8")).hexdigest() != manifest.get(
            "identity_root_sha256"
        ):
            problems.append("identity_root_sha256 uyusmuyor")
    return {"ok": not problems, "problems": problems}


# --------------------------------------------------------------------------
# Sifreleme (repo'nun mevcut semasi)
# --------------------------------------------------------------------------
def derive_key(secret: str) -> bytes:
    """`encrypted-codec.js` ile ayni turetme: sha256(secret) -> 32 bayt."""
    if not secret or len(secret) < 32:
        raise ValueError("anahtar en az 32 karakter olmali")
    return hashlib.sha256(secret.encode("utf-8")).digest()


def encrypt_bytes(plaintext: bytes, secret: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = derive_key(secret)
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext, AAD)
    return MAGIC + nonce + ct


def decrypt_bytes(blob: bytes, secret: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not blob.startswith(MAGIC):
        raise ValueError("bilinmeyen dosya bicimi (magic yok)")
    body = blob[len(MAGIC):]
    if len(body) < 12 + 16:
        raise ValueError("sifreli govde cok kisa")
    key = derive_key(secret)
    return AESGCM(key).decrypt(body[:12], body[12:], AAD)


# --------------------------------------------------------------------------
# Geri yukleme (yalnizca gecici SQLite)
# --------------------------------------------------------------------------
try:  # `exec()` ile yuklendiginde __file__ tanimli olmayabilir
    _THIS_FILE = os.path.abspath(__file__)
except NameError:  # pragma: no cover
    _THIS_FILE = os.path.join(os.getcwd(), "scripts", "diagnostics", "ram_snapshot.py")
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_THIS_FILE)))


def _is_inside_repo(path: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(path), _REPO_ROOT]) == _REPO_ROOT
    except ValueError:
        return False


def assert_restore_target_is_safe(path: str) -> None:
    """Uretim DB'sine veya depo icine geri yuklemeyi REDDEDER."""
    if os.environ.get("DATABASE_URL", "").startswith("postgresql"):
        raise PermissionError("DATABASE_URL postgres: uretim DB'sine geri yukleme reddedildi")
    if _is_inside_repo(path):
        raise PermissionError("geri yukleme hedefi depo icinde olamaz")


def restore_to_sqlite(path: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Snapshot'i gecici SQLite'a yazip kimlik kumesini dogrular."""
    assert_restore_target_is_safe(path)
    check = verify_snapshot(payload)
    if not check["ok"]:
        raise ValueError("bozuk snapshot: " + "; ".join(check["problems"][:5]))
    records = payload["records"]
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS snapshot_messages ("
            " conversation_id TEXT NOT NULL,"
            " wa_message_id TEXT NOT NULL,"
            " direction TEXT, message_type TEXT, status TEXT,"
            " body TEXT, created_at TEXT,"
            " media_id TEXT, sender_phone TEXT, recipient_phone TEXT,"
            " PRIMARY KEY (conversation_id, wa_message_id))"
        )
        inserted = 0
        skipped = 0
        for rec in records:
            conv, wa = identity_of(rec)  # type: ignore[misc]
            cur = conn.execute(
                "INSERT OR IGNORE INTO snapshot_messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    conv,
                    wa,
                    rec.get("direction"),
                    rec.get("message_type"),
                    rec.get("status"),
                    rec.get("body"),
                    rec.get("created_at"),
                    rec.get("media_id"),
                    rec.get("sender_phone"),
                    rec.get("recipient_phone"),
                ),
            )
            inserted += cur.rowcount
            skipped += 0 if cur.rowcount else 1
        conn.commit()
        restored = conn.execute("SELECT count(*) FROM snapshot_messages").fetchone()[0]
    finally:
        conn.close()
    expected = len(records)
    return {
        "inserted": inserted,
        "skipped_duplicate": skipped,
        "restored_rows": int(restored),
        "expected_rows": expected,
        "identity_conserved": int(restored) == expected,
    }


# --------------------------------------------------------------------------
# Toplama (DB + gateway)
# --------------------------------------------------------------------------
_SQL_WRITE = re.compile(r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b", re.IGNORECASE)


async def collect_all(
    *,
    page_size: int = PAGE_SIZE,
    jids: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Gateway RAM'ini salt okunur okur. DB'ye YAZMAZ."""
    from sqlalchemy import text

    from backend.app.core.database import AsyncSessionLocal
    from backend.app.services import whatsapp_gateway as gw

    async with AsyncSessionLocal() as db:
        sess = (
            await db.execute(
                text(
                    "SELECT id, user_id, gateway_id FROM whatsapp_sessions "
                    "WHERE status='CONNECTED' ORDER BY id DESC LIMIT 1"
                )
            )
        ).fetchone()
        if sess is None:
            return {"error": "CONNECTED oturum yok"}
        session_id, gateway_id = int(sess[0]), str(sess[2])
        convs = (
            await db.execute(
                text(
                    "SELECT c.id, ct.phone_e164 FROM conversations c "
                    "LEFT JOIN contacts ct ON ct.id = c.contact_id "
                    "WHERE c.channel='WHATSAPP'"
                )
            )
        ).fetchall()

    conv_ids = {int(c[0]) for c in convs}

    async def fetch(*, jid: str, limit: int, offset: int) -> Mapping[str, Any]:
        return await gw.list_all_messages(
            gateway_id, limit=limit, offset=offset, per_chat_limit=None, jids=[jid]
        )

    # Sohbet listesi gateway'den: hangi jid'ler var, kac kayit var.
    listing = await gw.list_all_messages(gateway_id, limit=1, offset=0, per_chat_limit=None)
    all_total = int((listing or {}).get("total") or 0)

    # JID'leri gateway'in kendi sohbet listesinden al (DB'de jid kolonu yok).
    jid_list = await _gateway_jids(gateway_id, gw)
    targets = [j for j in jid_list if (not jids or j in set(jids))]

    per_chat: List[Dict[str, Any]] = []
    records: List[Dict[str, Any]] = []
    for jid in targets:
        got = await collect_chat(fetch, jid, page_size=page_size)
        per_chat.append({k: got[k] for k in ("jid", "reported_total", "collected", "rounds", "stable", "shortfall")})
        records.extend(got["records"])

    deduped = dedupe(records)
    return {
        "session_id": session_id,
        "gateway_id": gateway_id,
        "ram_total_reported": all_total,
        "per_chat": per_chat,
        "records": deduped["records"],
        "duplicates": deduped["duplicates"],
        "rejected_missing_identity": deduped["rejected_missing_identity"],
        "rejected_incomplete": deduped["rejected_incomplete"],
        "unmapped_conversations": [],
        "conv_ids": sorted(conv_ids),
    }


async def _gateway_jids(gateway_id: str, gw: Any) -> List[str]:
    """Gateway'in bildigi sohbet anahtarlarini dondurur (salt okunur)."""
    out: List[str] = []
    offset = 0
    while True:
        page = await gw.list_all_messages(
            gateway_id, limit=PAGE_SIZE, offset=offset, per_chat_limit=1
        )
        msgs = (page or {}).get("messages") or []
        for m in msgs:
            if isinstance(m, Mapping) and m.get("conversation_id"):
                out.append(str(m["conversation_id"]))
        total = int((page or {}).get("total") or 0)
        if not msgs or offset + PAGE_SIZE >= total:
            break
        offset += PAGE_SIZE
    # Sirayi koru, tekrari at
    seen, uniq = set(), []
    for j in out:
        if j not in seen:
            seen.add(j)
            uniq.append(j)
    return uniq


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _refuse(msg: str) -> int:
    print(f"REDDEDILDI: {msg}", file=sys.stderr)
    return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Gateway RAM mesaj snapshot'i (SALT OKUNUR)")
    ap.add_argument("--out", default="-", help="'-' = stdout (varsayilan)")
    ap.add_argument("--manifest", help="icerik tasimayan manifest dosyasi")
    ap.add_argument("--allow-plaintext", action="store_true", help="duz metin yazimina izin ver")
    ap.add_argument("--encrypt-key-env", help="anahtari bu ortam degiskeninden oku")
    ap.add_argument("--restore-to", help="gecici SQLite hedefi (dogrulama)")
    ap.add_argument("--verify", help="mevcut snapshot dosyasini dogrula")
    ap.add_argument("--page-size", type=int, default=PAGE_SIZE)
    ap.add_argument("--jid", action="append", help="yalnizca bu jid (tekrarlanabilir)")
    ap.add_argument("--dry-run", action="store_true", help="topla, yazma")
    args = ap.parse_args(argv)

    if args.verify:
        try:
            with open(args.verify, "rb") as fh:
                blob = fh.read()
            if blob.startswith(MAGIC):
                key_env = args.encrypt_key_env or "RAM_SNAPSHOT_KEY"
                secret = os.environ.get(key_env)
                if not secret:
                    return _refuse(f"sifreli dosya; {key_env} tanimli degil")
                blob = decrypt_bytes(blob, secret)
            payload = json.loads(blob.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"HATA: dogrulanamadi: {exc}", file=sys.stderr)
            return 3
        res = verify_snapshot(payload)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res["ok"] else 3

    if args.restore_to:
        return _restore_cmd(args)

    # --- toplama ---
    import asyncio

    result = asyncio.run(collect_all(page_size=args.page_size, jids=args.jid))
    if result.get("error"):
        print(f"HATA: {result['error']}", file=sys.stderr)
        return 2

    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest = build_manifest(
        session_id=result["session_id"],
        gateway_id=result["gateway_id"],
        source_container_id=os.environ.get("HOSTNAME"),
        started_at=started_at,
        ended_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        per_chat=result["per_chat"],
        records=result["records"],
        duplicates=result["duplicates"],
        rejected_missing_identity=result["rejected_missing_identity"],
        rejected_incomplete=result["rejected_incomplete"],
        unmapped_conversations=result["unmapped_conversations"],
    )
    payload = {
        "kind": SNAPSHOT_KIND,
        "schema": SNAPSHOT_SCHEMA,
        "header": {
            "session_id": result["session_id"],
            "gateway_id_prefix": result["gateway_id"][:8],
            "source_container_id": os.environ.get("HOSTNAME"),
            "started_at": manifest["started_at"],
            "ended_at": manifest["ended_at"],
            "ram_total_reported": result["ram_total_reported"],
            "scope": "YALNIZCA gateway RAM'inde hala bulunan mesajlar; medya baytlari DAHIL DEGIL",
        },
        "records": result["records"],
        "manifest": manifest,
    }

    # Manifest icerik tasimaz: sifreleme gerekmez.
    if args.manifest:
        with open(args.manifest, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)

    if args.dry_run:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if args.encrypt_key_env:
        secret = os.environ.get(args.encrypt_key_env)
        if not secret:
            return _refuse(f"anahtar yok: {args.encrypt_key_env}")
        blob = encrypt_bytes(blob, secret)
    elif not args.allow_plaintext:
        return _refuse(
            "duz metin yazimi icin --allow-plaintext, sifreleme icin --encrypt-key-env gerekir"
        )

    if args.out == "-":
        sys.stdout.buffer.write(blob)
        sys.stdout.buffer.flush()
        print("\n" + json.dumps(manifest, ensure_ascii=False), file=sys.stderr)
        return 0

    if _is_inside_repo(args.out):
        return _refuse("hedef depo icinde; PII Git'e girmemeli")
    if not args.encrypt_key_env:
        return _refuse("dosyaya duz metin yazimi reddedildi; sifreleme kullan")
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(blob)
    print(json.dumps(manifest, ensure_ascii=False), file=sys.stderr)
    return 0


def _restore_cmd(args: argparse.Namespace) -> int:
    src = args.out if args.out != "-" else None
    if not src:
        return _refuse("--restore-to icin --out <dosya> gerekir")
    try:
        with open(src, "rb") as fh:
            blob = fh.read()
        if blob.startswith(MAGIC):
            key_env = args.encrypt_key_env or "RAM_SNAPSHOT_KEY"
            secret = os.environ.get(key_env)
            if not secret:
                return _refuse(f"sifreli dosya; {key_env} tanimli degil")
            blob = decrypt_bytes(blob, secret)
        payload = json.loads(blob.decode("utf-8"))
        res = restore_to_sqlite(args.restore_to, payload)
    except PermissionError as exc:
        return _refuse(str(exc))
    except Exception as exc:  # noqa: BLE001
        print(f"HATA: geri yukleme basarisiz: {exc}", file=sys.stderr)
        return 3
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res["identity_conserved"] else 3


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
