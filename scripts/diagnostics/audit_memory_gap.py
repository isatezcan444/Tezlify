"""Gateway bellegi ile DB arasindaki mesaj farkini KIMLIK uzerinden olcer.

## Neden sayac degil kimlik

`last_inserted` bir sayactir; "kac mesaj yazildi" der ama "hangi mesajlar
gercekten orada" demez. Asama 3.6'da tam olarak bu yuzden yanlis bir sayi
(7080) raporlandi: gateway'e `perChatLimit=50` ile sorulmustu, yani sayac
"DB'de yok" degil "bu pencerede gorunmuyor" diyordu. Bu betik saymaz:
RAM'deki her `wa_message_id`'yi DB'de AYNI sohbet altinda arar.

## Salt-okunur

Yalnizca `SELECT` ve gateway `GET` kullanir. Mesaj icerigi, telefon numarasi
ve govde YAZDIRILMAZ; cikti toplu sayilar, sohbet ID'leri ve (istenirse)
anonim JID etiketleridir. Hicbir sey yazmaz, silmez, degistirmez.

## Kullanim (uretim host'unda, backend konteyneri icinde)

    docker exec -i tezlify-backend python - < scripts/diagnostics/audit_memory_gap.py

veya once/sonra karsilastirmasi icin JSON'u dosyaya alip `--compare` ile
ikinci kez calistirin:

    ... | python scripts/diagnostics/audit_memory_gap.py --compare before.json

Cikis kodu: 0 = beklenen durum (fark raporlandi), 3 = karsilastirmada gerileme
(mesaj sayisi azaldi — veri kaybi sinyali).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

GATEWAY_PAGE = 2000
MAX_PAGES = 200


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


def classify(
    *,
    ram: Sequence[Mapping[str, Any]],
    db_ids_by_conv: Mapping[int, Set[str]],
    db_ids_any_conv: Mapping[str, Set[int]],
    jid_to_conv: Mapping[str, int],
    conv_ids: Iterable[int],
) -> Dict[str, Any]:
    """RAM'i alti ayrima boler. SAF fonksiyon: DB/ag yok, test edilebilir.

    Siniflar:
      - `present_correct_conv`  : DB'de, DOGRU sohbet altinda var (DB ⊆ RAM kaniti)
      - `present_other_conv`    : DB'de var ama baska sohbette (eslestirme hatasi)
      - `present_other_tenant`  : DB'de var ama bu tenant'in hicbir sohbetinde degil
      - `unmapped_jid`          : sohbet eslenemedi (LID/PN kapsami disinda)
      - `genuinely_missing`     : DB'de hic yok
      - `would_conflict`        : "gercekten yok" tanimi geregi yapisal olarak 0
    """
    conv_ids = set(int(c) for c in conv_ids)
    present_correct = present_other = missing = unmapped = 0
    missing_no_ts = missing_no_sender = 0
    other_tenant = 0
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

    return {
        "ram_total": len(ram),
        "ram_with_valid_id": len(ids),
        "ram_distinct_ids": len(id_counts),
        "ram_duplicate_id_rows": sum(c - 1 for c in id_counts.values() if c > 1),
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
    }


def compare(before: Mapping[str, Any], after: Mapping[str, Any]) -> List[str]:
    """Once/sonra karsilastirmasi; gerileme varsa ihlal listesi dondurur.

    Tek mesru yon: `CLASS_genuinely_missing` AZALIR. Artan bir deger, DB'den
    satir kayboldugu (veya RAM'in degistigi) anlamina gelir.
    """
    problems: List[str] = []
    b = int(before.get("CLASS_genuinely_missing") or 0)
    a = int(after.get("CLASS_genuinely_missing") or 0)
    if a > b:
        problems.append(f"genuinely_missing ARTTI: {b} -> {a} (veri kaybi sinyali)")
    if int(after.get("CLASS_present_other_tenant") or 0) > 0:
        problems.append("baska tenant'in sohbetinde mesaj goruldu")
    if int(after.get("ram_duplicate_id_rows") or 0) > 0:
        problems.append("RAM'de ayni wa_message_id birden fazla kez var")
    return problems


async def collect() -> Dict[str, Any]:
    """Uretimden salt-okunur veri toplar. Yalnizca SELECT + gateway GET."""
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
    for cid, wa in db_rows:
        cid, wa = int(cid), str(wa)
        db_by_conv.setdefault(cid, set()).add(wa)
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
        }
    )
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="RAM/DB mesaj farki (SALT OKUNUR)")
    ap.add_argument("--compare", help="once alinmis JSON dosyasi (gerileme kontrolu)")
    ap.add_argument("--json", action="store_true", help="yalnizca JSON yaz")
    args = ap.parse_args(argv)

    result = asyncio.run(collect())
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))

    if not args.compare:
        return 0

    try:
        with open(args.compare, "r", encoding="utf-8") as fh:
            before = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"HATA: --compare okunamadi: {exc}", file=sys.stderr)
        return 2

    problems = compare(before, result)
    if problems:
        for p in problems:
            print(f"IHLAL: {p}", file=sys.stderr)
        return 3
    print("KARSILASTIRMA: gerileme yok.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
