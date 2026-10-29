"""Gateway bellegi ile DB arasindaki mesaj farkini KIMLIK uzerinden olcer.

## Neden sayac degil kimlik

`last_inserted` bir sayactir; "kac mesaj yazildi" der ama "hangi mesajlar
gercekten orada" demez. Asama 3.6'da tam olarak bu yuzden yanlis bir sayi
(7080) raporlandi: gateway'e `perChatLimit=50` ile sorulmustu, yani sayac
"DB'de yok" degil "bu pencerede gorunmuyor" diyordu. Bu betik saymaz:
RAM'deki her `wa_message_id`'yi DB'de AYNI sohbet altinda arar.

## Neden SNAPSHOT (Asama 3.8.1)

Tek bir olcum "su an ne var" sorusunu cevaplar; "az once ne vardi" sorusunu
cevaplamaz. Bu ayrim kritik: gateway sohbet basina 2000 mesaji astiginda en
eskileri SESSIZCE atar, dolayisiyla RAM-only fark KENDILIGINDEN kuculur.
Sayi kuculdu diye bunu basari saymak, veri kaybini odul olarak yorumlamak
demektir. Bu yuzden:

    --snapshot PATH   kimlik kumesini (hash'lenmis) diske yazar
    --snapshot -      ayni kumeyi STDOUT'a yazar (uretimde dosya yazmamak icin)
    --compare PATH    onceki snapshot ile KIMLIK kumesini karsilastirir

`POSSIBLE_EVICTION` yalnizca iki snapshot varsa hesaplanabilir: onceki
snapshot'ta RAM'de olup simdi ne RAM'de ne DB'de bulunan kimlikler. Boyle bir
kimlik varsa sonuc BASARILI SAYILMAZ.

Snapshot kimlikleri `sha256(wa_message_id)` olarak saklanir: iki olcumu
karsilastirmaya yeter, mesaj govdesi/telefon/JID tasimaz.

## Salt-okunur

Yalnizca `SELECT` ve gateway `GET` kullanir. Mesaj icerigi, telefon numarasi
ve govde YAZDIRILMAZ; cikti toplu sayilar, sohbet ID'leri ve (istenirse)
anonim JID etiketleridir. Hicbir sey yazmaz, silmez, degistirmez.

## Kullanim (uretim host'unda, backend konteyneri icinde)

    docker exec -i tezlify-backend python - --snapshot /tmp/s1.json \
        < scripts/diagnostics/audit_memory_gap.py

    ... | python scripts/diagnostics/audit_memory_gap.py --compare /tmp/s1.json

Cikis kodu:
    0 = temiz (karsilastirma yapildi, kayip/ihlal yok)
    2 = dosya okunamadi / olcum alinamadi
    3 = IHLAL (kayip, tenant sizmasi, yinelenen kimlik, sohbet uyusmazligi)
    4 = INCONCLUSIVE (kimlik karsilastirmasi yapilamadi)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from collections import Counter
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

GATEWAY_PAGE = 2000
MAX_PAGES = 200
SNAPSHOT_SCHEMA = 2

# Kimlik kumesinde eslenemeyen satirlar icin ayri kovalar. Bunlari sessizce
# dusurmek "kayip yok" sonucunu uretirdi.
_UNMAPPED = "__unmapped__"
_NO_ID = "__noid__"


def norm_phone_jid(phone: Optional[str]) -> str:
    """`+905xx...` / `jid:...` -> `<digits>@s.whatsapp.net`."""
    p = (phone or "").strip()
    if not p:
        return ""
    if p.startswith("jid:"):
        return p[4:]
    digits = "".join(ch for ch in p if ch.isdigit())
    return f"{digits}@s.whatsapp.net" if digits else ""


def has_id(msg: Mapping[str, Any]) -> bool:
    return bool(str(msg.get("wa_message_id") or "").strip())


def has_ts(msg: Mapping[str, Any]) -> bool:
    return bool(msg.get("created_at") or msg.get("timestamp_s") or msg.get("timestamp"))


def has_sender(msg: Mapping[str, Any]) -> bool:
    return bool(
        msg.get("sender_phone") or msg.get("participant_name") or msg.get("sender_name")
    )


def identity_token(wa_message_id: str) -> str:
    """Kimligi karsilastirilabilir ama okunamaz bir token'a cevirir.

    Tuz (salt) KULLANILMAZ: ayni kimlik iki snapshot'ta ayni token'i uretmeli.
    Mesaj kimligi kisisel veri degil, ama diske yazilan dosyada ham kimlik
    tutmamak, dosyanin yanlislikla paylasilmasini zararsiz kilar.
    """
    return hashlib.sha256(str(wa_message_id).strip().encode("utf-8")).hexdigest()[:32]


def classify(
    *,
    ram: Sequence[Mapping[str, Any]],
    db_ids_by_conv: Mapping[int, Set[str]],
    db_ids_any_conv: Mapping[str, Set[int]],
    jid_to_conv: Mapping[str, int],
    conv_ids: Iterable[int],
) -> Dict[str, Any]:
    """RAM'i siniflara boler. SAF fonksiyon: DB/ag yok, test edilebilir.

    Eski siniflar (geriye donuk uyumlu):
      - `CLASS_present_correct_conv` : DB'de, DOGRU sohbet altinda var
      - `CLASS_present_other_conv`   : DB'de var ama baska sohbette
      - `CLASS_present_other_tenant` : DB'de var ama bu tenant'in hicbir sohbetinde degil
      - `CLASS_unmapped_jid`         : sohbet eslenemedi (LID/PN kapsami disinda)
      - `CLASS_genuinely_missing`    : DB'de hic yok

    Faz 3.8.1'de eklenen adlandirilmis siniflar (`RAM_ONLY` vb.) ayni
    sayilarin okunur takma adlaridir; ikisi de yayinlanir ki eski okuyucular
    kirilmasin.
    """
    conv_ids = set(int(c) for c in conv_ids)
    present_correct = present_other = missing = unmapped = 0
    missing_no_ts = missing_no_sender = 0
    other_tenant = 0
    rows_without_id = 0
    missing_by_conv: Counter = Counter()
    unmapped_by_kind: Counter = Counter()

    for m in ram:
        if not isinstance(m, Mapping):
            continue
        jid = str(m.get("conversation_id") or "")
        cid = jid_to_conv.get(jid)
        if cid is None:
            unmapped += 1
            unmapped_by_kind[
                "GROUP" if jid.endswith("@g.us") else "LID" if jid.endswith("@lid") else "PN"
            ] += 1
            continue
        if not has_id(m):
            # Kimliksiz satir "eslesti" de sayilmaz, "eksik" de sayilmaz:
            # hicbir zaman yazilamayacagi icin ayri raporlanir.
            rows_without_id += 1
            continue
        wa = str(m["wa_message_id"]).strip()
        if wa in db_ids_by_conv.get(cid, set()):
            present_correct += 1
        elif wa in db_ids_any_conv:
            present_other += 1
            if not (db_ids_any_conv[wa] & conv_ids):
                other_tenant += 1
        else:
            missing += 1
            missing_by_conv[cid] += 1
            if not has_ts(m):
                missing_no_ts += 1
            if not has_sender(m):
                missing_no_sender += 1

    ids = [str(m["wa_message_id"]).strip() for m in ram if isinstance(m, Mapping) and has_id(m)]
    id_counts = Counter(ids)
    duplicate_rows = sum(c - 1 for c in id_counts.values() if c > 1)

    return {
        "ram_total": len(ram),
        "ram_with_valid_id": len(ids),
        "ram_distinct_ids": len(id_counts),
        "ram_duplicate_id_rows": duplicate_rows,
        "ram_rows_without_id": sum(
            1 for m in ram if isinstance(m, Mapping) and not has_id(m)
        ),
        "CLASS_present_correct_conv": present_correct,
        "CLASS_present_other_conv": present_other,
        "CLASS_present_other_tenant": other_tenant,
        "CLASS_unmapped_jid": unmapped,
        "CLASS_unmapped_by_kind": dict(unmapped_by_kind),
        "CLASS_genuinely_missing": missing,
        "missing_without_timestamp": missing_no_ts,
        "missing_without_sender_meta": missing_no_sender,
        "missing_affected_conversations": len(missing_by_conv),
        "missing_top_conversations": [
            {"conv": cid, "count": n} for cid, n in missing_by_conv.most_common(10)
        ],
        # --- Faz 3.8.1: adlandirilmis siniflar (ayni sayilar) -------------
        "IDENTITY_MATCH": present_correct,
        "RAM_ONLY": missing,
        "CHAT_MISMATCH": present_other,
        "TENANT_MISMATCH": other_tenant,
        "DUPLICATE_IDENTITY": duplicate_rows,
        "UNRESOLVED_IDENTITY": unmapped + rows_without_id,
        "UNRESOLVED_UNMAPPED_JID": unmapped,
        "UNRESOLVED_ROWS_WITHOUT_ID": rows_without_id,
    }


def _identity_only(by_conv: Mapping[str, Iterable[str]]) -> Set[str]:
    """Yalnizca GERCEK kimlikler: kimliksiz satirlar (`_NO_ID`) haric.

    Kimliksiz satirin token'i bos string'dir; onu kumeye katmak, iki kimliksiz
    satiri "ayni kimlik" gibi gosterir ve kaybolduklarinda sahte bir
    `POSSIBLE_EVICTION` uretirdi. Kimliksiz satirlar zaten hic yazilamaz
    (bkz. `classify`), dolayisiyla karsilastirmada da yerleri yoktur.
    """
    out: Set[str] = set()
    for key, ids in by_conv.items():
        if key == _NO_ID:
            continue
        for token in ids:
            if token:
                out.add(token)
    return out


def compare_snapshots(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    allow_aggregate: bool = False,
) -> Dict[str, Any]:
    """Once/sonra karsilastirmasi; zengin bir karar sozlugu dondurur.

    `verdict`:
      - `OK`           : kimlik karsilastirmasi yapildi, ihlal yok
      - `VIOLATION`    : kayip / tenant / yinelenen / sohbet uyusmazligi
      - `INCONCLUSIVE` : snapshot'ta kimlik kumesi yok (yalnizca sayilar var)

    NEDEN `INCONCLUSIVE` VAR: eski sozlesme "eksik sayisi azaldiysa iyidir"
    diyordu. Gateway sohbet basina 2000 mesaji astiginda en eskileri sessizce
    attigi icin bu sayi KAYIP NEDENIYLE de azalabilir. Iki durumu ayirt
    edemeyen bir olcum "basarili" ilan edilemez.
    """
    problems: List[str] = []

    # 1) Sayi artisi: her zaman ilk kontrol (eski davranis korunur).
    b = int(before.get("CLASS_genuinely_missing") or 0)
    a = int(after.get("CLASS_genuinely_missing") or 0)
    if a > b:
        problems.append(f"genuinely_missing ARTTI: {b} -> {a} (veri kaybi sinyali)")

    # 2) Tenant / yinelenen / sohbet uyusmazligi.
    if int(after.get("CLASS_present_other_tenant") or 0) > 0:
        problems.append("baska tenant'in sohbetinde mesaj goruldu")
    if int(after.get("ram_duplicate_id_rows") or 0) > 0:
        problems.append("RAM'de ayni wa_message_id birden fazla kez var")
    if int(after.get("db_duplicate_identity_groups") or 0) > 0:
        problems.append("DB'de ayni (sohbet, wa_message_id) birden fazla kez var")

    has_identity = isinstance(before.get("ram"), Mapping) and isinstance(
        after.get("ram"), Mapping
    )

    if not has_identity:
        if not allow_aggregate:
            return {
                "verdict": "INCONCLUSIVE",
                "problems": problems,
                "possible_eviction": {},
                "reason": "snapshot_kimlik_kumesi_yok",
                "note": (
                    "Onceki snapshot yalnizca sayi tasiyor; kimlik kaybi "
                    "AYIRT EDILEMEZ. 'Eksik azaldi' basari sayilmaz. "
                    "Yeni olcumleri --snapshot ile alin."
                ),
            }
        return {
            "verdict": "VIOLATION" if problems else "OK",
            "problems": problems,
            "possible_eviction": {},
            "reason": "aggregate_only_explicitly_allowed",
        }

    prev_ram = _identity_only(before["ram"])
    prev_db = _identity_only(before.get("db") or {})
    curr_ram = _identity_only(after["ram"])
    curr_db = _identity_only(after.get("db") or {})

    # 3) RAM'den cikip DB'ye girmemis kimlikler = olasi eviction (kayip).
    evicted = prev_ram - curr_ram - curr_db
    possible_eviction: Dict[str, Any] = {}
    if evicted:
        by_conv: Counter = Counter()
        for conv_key, ids in (before.get("ram") or {}).items():
            hit = len(set(ids) & evicted)
            if hit:
                by_conv[conv_key] = hit
        possible_eviction = {
            "count": len(evicted),
            "by_conversation": [
                {"conv": k, "count": v} for k, v in by_conv.most_common(20)
            ],
        }
        problems.append(
            f"POSSIBLE_EVICTION: {len(evicted)} kimlik onceki RAM'de vardi, "
            "simdi ne RAM'de ne DB'de"
        )

    # 4) DB'den kaybolan kimlikler: dogrudan veri kaybi.
    db_lost = len(prev_db - curr_db)
    if db_lost:
        problems.append(f"DB'den {db_lost} mesaj kimligi kayboldu")

    return {
        "verdict": "VIOLATION" if problems else "OK",
        "problems": problems,
        "possible_eviction": possible_eviction,
        "db_identities_lost": db_lost,
        "ram_only_delta": a - b,
    }


def compare(before: Mapping[str, Any], after: Mapping[str, Any]) -> List[str]:
    """Geriye donuk uyumlu sozlesme: yalnizca ihlal listesi.

    Eski cagiranlar (`problems = compare(before, after)`) kirilmasin diye
    korunur. Kimlik kumesi YOKSA eski davranisa duser; kimlik kumesi VARSA
    eviction/kayip kontrolleri de bu listede gorunur.
    """
    return compare_snapshots(before, after, allow_aggregate=True)["problems"]


async def collect() -> Dict[str, Any]:
    """Uretimden salt-okunur veri toplar. Yalnizca SELECT + gateway GET.

    Donen sozlukte `_identity` anahtari kimlik kumesini tasir; `main` bunu
    konsola basmaz, yalnizca `--snapshot` verildiginde (hash'lenmis) diske
    yazar.
    """
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

        db_rows = (
            await db.execute(
                text(
                    "SELECT conversation_id, wa_message_id FROM messages "
                    "WHERE wa_message_id IS NOT NULL"
                )
            )
        ).fetchall()

        lids = (
            await db.execute(
                text(
                    "SELECT lid_jid, phone_jid FROM whatsapp_private.lid_mappings "
                    "WHERE session_id = :sid"
                ),
                {"sid": gateway_id},
            )
        ).fetchall()

        total_db = int(
            (await db.execute(text("SELECT count(*) FROM messages"))).scalar() or 0
        )
        db_no_id = int(
            (
                await db.execute(
                    text("SELECT count(*) FROM messages WHERE wa_message_id IS NULL")
                )
            ).scalar()
            or 0
        )

    jid_to_conv: Dict[str, int] = {}
    conv_ids: Set[int] = set()
    for cid, phone in convs:
        cid = int(cid)
        conv_ids.add(cid)
        j = norm_phone_jid(phone)
        if j and "@" in j:
            jid_to_conv[j] = cid
    for lid_jid, phone_jid in lids:
        target = jid_to_conv.get(str(phone_jid))
        if target is not None and str(lid_jid) not in jid_to_conv:
            jid_to_conv[str(lid_jid)] = target

    db_by_conv: Dict[int, Set[str]] = {}
    db_by_wa: Dict[str, Set[int]] = {}
    db_dup_groups = 0
    for cid, wa in db_rows:
        cid, wa = int(cid), str(wa)
        bucket = db_by_conv.setdefault(cid, set())
        if wa in bucket:
            db_dup_groups += 1
        bucket.add(wa)
        db_by_wa.setdefault(wa, set()).add(cid)

    ram: List[Dict[str, Any]] = []
    reported = None
    offset = 0
    for _ in range(MAX_PAGES):
        page = await gw.list_all_messages(
            gateway_id, limit=GATEWAY_PAGE, offset=offset, per_chat_limit=GATEWAY_PAGE
        )
        msgs = (page or {}).get("messages") or []
        reported = int((page or {}).get("total") or 0)
        ram.extend(m for m in msgs if isinstance(m, dict))
        if not msgs or offset + GATEWAY_PAGE >= reported:
            break
        offset += GATEWAY_PAGE

    out = classify(
        ram=ram,
        db_ids_by_conv=db_by_conv,
        db_ids_any_conv=db_by_wa,
        jid_to_conv=jid_to_conv,
        conv_ids=conv_ids,
    )
    out.update(
        {
            "session_id": session_id,
            "gateway_id_prefix": gateway_id[:8],
            "db_total_messages": total_db,
            "db_messages_without_wa_id": db_no_id,
            "db_conversations": len(conv_ids),
            "jid_keys_available": len(jid_to_conv),
            "ram_total_reported_by_gateway": reported,
            "db_duplicate_identity_groups": db_dup_groups,
        }
    )

    # DB_ONLY: DB'de olup RAM'de olmayanlar. Eski gecmis icin NORMALDIR;
    # bu yuzden ihlal degil, bilgi olarak raporlanir.
    ram_ids = {
        str(m["wa_message_id"]).strip() for m in ram if isinstance(m, dict) and has_id(m)
    }
    out["DB_ONLY"] = len({wa for wa in db_by_wa if wa not in ram_ids})

    # Kimlik kumeleri: kova = sohbet ID'si; eslenemeyen/kimliksiz ayri kovada.
    ram_by_conv: Dict[str, List[str]] = {}
    for m in ram:
        if not isinstance(m, dict):
            continue
        if not has_id(m):
            ram_by_conv.setdefault(_NO_ID, []).append("")
            continue
        cid = jid_to_conv.get(str(m.get("conversation_id") or ""))
        key = str(cid) if cid is not None else _UNMAPPED
        ram_by_conv.setdefault(key, []).append(identity_token(m["wa_message_id"]))
    db_by_conv_hashed: Dict[str, List[str]] = {}
    for cid, ids in db_by_conv.items():
        db_by_conv_hashed[str(cid)] = sorted(identity_token(i) for i in ids)

    out["_identity"] = {"ram": ram_by_conv, "db": db_by_conv_hashed}
    return out


def build_snapshot(result: Mapping[str, Any], identity: Mapping[str, Any]) -> Dict[str, Any]:
    """Snapshot yuklerini kurar. Ham kimlik YOK, yalnizca sha256 onekleri."""
    return {
        "schema": SNAPSHOT_SCHEMA,
        "captured_at": result.get("captured_at"),
        "session_id": result.get("session_id"),
        "gateway_id_prefix": result.get("gateway_id_prefix"),
        "ram": identity.get("ram") or {},
        "db": identity.get("db") or {},
        "counts": {
            k: v
            for k, v in result.items()
            if not k.startswith("_") and isinstance(v, (int, float, str))
        },
        "classes": {
            k: v
            for k, v in result.items()
            if k.startswith("CLASS_")
            or k
            in {
                "RAM_ONLY",
                "DB_ONLY",
                "IDENTITY_MATCH",
                "CHAT_MISMATCH",
                "TENANT_MISMATCH",
                "DUPLICATE_IDENTITY",
                "UNRESOLVED_IDENTITY",
            }
        },
    }


def write_snapshot(path: str, result: Mapping[str, Any], identity: Mapping[str, Any]) -> None:
    """Kimlik kumesini diske yazar.

    Uretimde dosya YAZMAMAK icin `--snapshot -` ile stdout'a da yazilabilir;
    boylece container'in dosya sistemine hic dokunulmaz.
    """
    payload = build_snapshot(result, identity)
    if path == "-":
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)


def exit_code_for(verdict: Mapping[str, Any]) -> int:
    """Karar -> surec cikis kodu. Tek yerde tutulur ki test edilebilsin.

    4 (INCONCLUSIVE) bilerek 0'dan AYRIDIR: "karsilastirma yapilamadi"
    ile "karsilastirma temiz" ayni kefeye konursa, kimlik tasimayan eski bir
    snapshot sessizce basari gibi okunur.
    """
    state = verdict.get("verdict")
    if state == "VIOLATION":
        return 3
    if state == "INCONCLUSIVE":
        return 4
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="RAM/DB mesaj farki (SALT OKUNUR)")
    ap.add_argument("--compare", help="once alinmis snapshot JSON dosyasi")
    ap.add_argument(
        "--snapshot",
        help="bu olcumun kimlik kumesini yaz (sonraki --compare icin)",
    )
    ap.add_argument("--json", action="store_true", help="yalnizca JSON yaz")
    ap.add_argument(
        "--allow-aggregate",
        action="store_true",
        help=(
            "onceki snapshot kimlik tasimiyorsa ESKI davranisa dus "
            "(yalnizca sayi artisina bak). Varsayilan: INCONCLUSIVE."
        ),
    )
    args = ap.parse_args(argv)

    result = asyncio.run(collect())
    if result.get("error"):
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        return 2

    result["captured_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    identity = result.pop("_identity", None) or {}
    printable = {k: v for k, v in result.items() if not k.startswith("_")}

    # `--snapshot -` stdout'u SNAPSHOT'a ayirir; ozet stderr'e gider ki
    # `> s1.json` ile yonlendirilen dosya gecerli JSON kalsin.
    to_stdout = args.snapshot == "-"
    summary_stream = sys.stderr if to_stdout else sys.stdout

    if args.json:
        print(json.dumps(printable, ensure_ascii=False), file=summary_stream)
    else:
        print(json.dumps(printable, ensure_ascii=False, indent=2), file=summary_stream)

    if args.snapshot:
        try:
            write_snapshot(args.snapshot, result, identity)
        except OSError as exc:
            print(f"HATA: --snapshot yazilamadi: {exc}", file=sys.stderr)
            return 2
        if not to_stdout:
            print(f"SNAPSHOT: {args.snapshot}", file=sys.stderr)

    if not args.compare:
        return 0

    try:
        with open(args.compare, "r", encoding="utf-8") as fh:
            before = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"HATA: --compare okunamadi: {exc}", file=sys.stderr)
        return 2

    # Karsilastirma icin mevcut olcumun kimlik kumesini geri koy.
    current = dict(printable)
    current["ram"] = identity.get("ram") or {}
    current["db"] = identity.get("db") or {}

    verdict = compare_snapshots(before, current, allow_aggregate=args.allow_aggregate)
    print(json.dumps(verdict, ensure_ascii=False, indent=2))

    for p in verdict["problems"]:
        print(f"IHLAL: {p}", file=sys.stderr)

    code = exit_code_for(verdict)
    if code == 3:
        return 3
    if code == 4:
        print("KARSILASTIRMA: INCONCLUSIVE — basari sayilmaz.", file=sys.stderr)
        return 4
    print("KARSILASTIRMA: gerileme yok.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
