"""LID/telefon kimliğiyle bölünmüş sohbetleri BİRLEŞTİREREK onarır.

Neden gerekli
-------------
Bir kişi LID adresiyle yazdığında ve gateway henüz LID→telefon köprüsünü
öğrenmemişken backend, `phone_e164 = 'jid:<lid>'` olan bir "hayalet" kişi ve ona
bağlı ayrı bir sohbet oluşturur. Köprü sonradan öğrenilse bile **geçmişte**
kalıcılaşmış bölünmeler için canlı yol (`lid_mapped`) bir daha çalışmaz — o olay
yalnızca bir kez gelir.

Bugüne kadar bu satırlar `purge_raw_jid_identity_data` (startup migration) ile
**siliniyordu**: hayalet kişi VE bağlı sohbeti, mesajlarıyla birlikte gider ve
kişinin telefon JID'i altında yeniden oluşması beklenirdi. Bu, köprüsü zaten
bilinen bir bölünme için gereksiz veri kaybıdır — mesajlar geri gelmezse
kullanıcı için "mesajlarım kayboldu" demektir.

Bu iş onun yerine `reconcile_legacy_split_conversation`'ı kullanır: mesajları
`conversation_id` güncelleyerek **taşır** (aynı `wa_message_id` varsa durum
rütbesi yüksek olan kazanır), okunmamışı toplar, eski sohbeti arşivler. Hiçbir
satır silinmez.

Ne yapmaz
---------
Köprüsü bilinmeyen hayaletleri **silmez ve birleştirmez**: çözülemeyen kimliği
tahmin etmek, yanlış kişinin sohbetini başkasına bağlamak olurdu. Onları yalnızca
raporlar.

Kullanım
--------
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_lid_split_repair.py            # plan (yazmaz)
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_lid_split_repair.py --apply    # birleştirir
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_lid_split_repair.py --apply --limit 5
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_lid_split_repair.py --user-id <uuid>

VARSAYILAN YAZMAZ. Birleştirme geri alınamaz biçimde mesaj taşır; önce planı
görüp sonra tek bayrakla uygulamak, "yanlış giderse geri alırım" varsayımına
güvenmekten dürüsttür. `--limit` her koşuda yapılabilecek birleştirme sayısını
sınırlar (varsayılan 50): onarım işi sınırsız olmamalıdır.
"""
import argparse
import asyncio
import json
import logging
import sys
from typing import Any, Dict, List, Optional

from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services.whatsapp.identity import contact_phone_for_jid
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator

logger = logging.getLogger("lid_split_repair")

DEFAULT_LIMIT = 50


def _is_postgres(engine) -> bool:
    try:
        return engine.dialect.name == "postgresql"
    except Exception:  # noqa: BLE001
        return False


def _lid_table(postgres: bool) -> str:
    # Gateway bu tabloyu Postgres'te özel şemada, SQLite'ta düz adla açar.
    return "whatsapp_private.lid_mappings" if postgres else "lid_mappings"


def _sessions_table(postgres: bool) -> str:
    return "public.whatsapp_sessions" if postgres else "whatsapp_sessions"


async def _candidate_pairs(db, *, postgres: bool, user_id: Optional[str], limit: int) -> List[Dict[str, Any]]:
    """Köprüsü BİLİNEN ve hâlâ hayalet LID kişisine bağlı sohbeti olan çiftler.

    Yalnızca her iki ucu da kanıtlanmış çiftler döner: eşleme tablosunda kaydı
    olmayan bir LID aday DEĞİLDİR (kimliği tahmin etmek yerine atlarız).
    """
    where_user = " AND ws.user_id = :user_id" if user_id else ""
    rows = (
        await db.execute(
            text(
                f"""
                SELECT DISTINCT lm.lid_jid, lm.phone_jid, ws.user_id
                FROM {_lid_table(postgres)} lm
                JOIN {_sessions_table(postgres)} ws ON ws.gateway_id = lm.session_id
                WHERE lm.phone_jid IS NOT NULL AND lm.phone_jid <> ''
                  AND lm.lid_jid LIKE '%@lid'
                  {where_user}
                ORDER BY lm.lid_jid
                LIMIT :lim
                """
            ),
            {"lim": limit, "user_id": user_id} if user_id else {"lim": limit},
        )
    ).all()

    pairs: List[Dict[str, Any]] = []
    for lid_jid, phone_jid, owner in rows:
        lid_phone = f"jid:{lid_jid}"
        ghost = (
            await db.execute(
                select(Contact.id, Contact.phone_e164).where(
                    Contact.phone_e164 == lid_phone,
                    Contact.user_id == owner,
                )
            )
        ).first()
        if not ghost:
            continue
        legacy_conv = (
            await db.execute(
                select(Conversation.id).where(
                    Conversation.contact_id == ghost.id,
                    Conversation.user_id == owner,
                )
            )
        ).first()
        if not legacy_conv:
            continue
        pairs.append(
            {
                "user_id": str(owner),
                "lid_jid": str(lid_jid),
                "phone_jid": str(phone_jid),
                "lid_contact_id": ghost.id,
                "lid_conversation_id": legacy_conv.id,
            }
        )
    return pairs


async def repair_lid_splits(
    *,
    apply: bool = False,
    limit: int = DEFAULT_LIMIT,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Bölünmüş LID sohbetlerini bulur; `apply` ise birleştirir.

    Her birleştirme için kanıt döner: hangi sohbet hangisine taşındı, kaç mesaj
    yer değiştirdi, kaç tanesi aynı `wa_message_id` olduğu için tekilleşti ve
    eski sohbet arşivlendi mi. Bir onarımın "oldu" demesi yetmez — ne olduğunu
    göstermesi gerekir.
    """
    if limit <= 0:
        raise ValueError("limit pozitif olmali")

    orchestrator = WhatsAppEventOrchestrator()
    evidence: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    async with AsyncSessionLocal() as db:
        postgres = _is_postgres(db.bind)
        pairs = await _candidate_pairs(
            db, postgres=postgres, user_id=user_id, limit=limit
        )
        scanned = len(pairs)

        for pair in pairs[:limit]:
            owner = pair["user_id"]
            lid_jid = pair["lid_jid"]
            phone_jid = pair["phone_jid"]
            legacy_conv_id = pair["lid_conversation_id"]

            legacy_msgs = (
                await db.execute(
                    select(Message.wa_message_id).where(
                        Message.conversation_id == legacy_conv_id
                    )
                )
            ).all()
            message_ids = [r[0] for r in legacy_msgs]

            if not apply:
                evidence.append(
                    {
                        **pair,
                        "applied": False,
                        "action": "would_merge",
                        "messages_in_lid_conversation": len(message_ids),
                    }
                )
                continue

            canonical_contact_id = await db.scalar(
                select(Contact.id).where(
                    Contact.phone_e164 == contact_phone_for_jid(phone_jid),
                    Contact.user_id == owner,
                )
            )
            # Ölçümü birleştirmeden ÖNCE al: kanıt sonradan geriye bakarak
            # değil, önce/sonra farkından okunur.
            canonical_conv_id = await db.scalar(
                select(Conversation.id).where(
                    Conversation.contact_id == canonical_contact_id,
                    Conversation.user_id == owner,
                )
            )
            canonical_wa_ids = set(
                (
                    await db.execute(
                        select(Message.wa_message_id).where(
                            Message.conversation_id == canonical_conv_id,
                            Message.wa_message_id.isnot(None),
                        )
                    )
                ).scalars().all()
            )

            merged = await orchestrator.reconcile_legacy_split_conversation(
                db, owner, lid_jid, phone_jid, session_id=None
            )
            if merged is None:
                skipped.append({**pair, "reason": "reconcile_returned_none"})
                continue

            # Kanıtı TAŞINAN satırlardan oku, varsayımdan değil: mesajlar
            # gerçekten canonical sohbette mi?
            moved = len(
                (
                    await db.execute(
                        select(Message.id).where(Message.conversation_id == merged.id)
                    )
                ).all()
            )
            leftovers = (
                await db.execute(
                    select(Message.wa_message_id).where(
                        Message.conversation_id == legacy_conv_id
                    )
                )
            ).scalars().all()
            # Ayrım kritik. Paylaşılan birleştirme, `wa_message_id`'si canonical
            # tarafta ZATEN olan kopyayı arşivlenen sohbette bırakır; canonical
            # sohbetin okuma yolları onu görmediği için bu satır ölüdür, kayıp
            # DEĞİLDİR. Kayıp olan, canonical tarafta karşılığı olmayan ve yine
            # de taşınmamış bir satırdır — bu sayı 0 olmak zorundadır.
            dead_duplicates = [w for w in leftovers if w and w in canonical_wa_ids]
            stranded_unique = [w for w in leftovers if not w or w not in canonical_wa_ids]
            legacy_status = await db.scalar(
                select(Conversation.is_archived).where(Conversation.id == legacy_conv_id)
            )

            evidence.append(
                {
                    **pair,
                    "applied": True,
                    "action": "merged",
                    "canonical_contact_id": canonical_contact_id,
                    "canonical_conversation_id": merged.id,
                    "messages_in_lid_conversation": len(message_ids),
                    "messages_now_in_canonical": moved,
                    "duplicates_left_on_archived_lid": len(dead_duplicates),
                    "unique_messages_stranded": len(stranded_unique),
                    "legacy_conversation_archived": bool(legacy_status),
                    "canonical_unread_count": merged.unread_count,
                }
            )
            if stranded_unique:
                # Sessiz kalmak, "onarım başarılı" raporunun altında gerçek bir
                # veri kaybını gizlerdi.
                logger.error(
                    "BIRLESTIRME SONRASI TASINMAMIS BENZERSIZ MESAJ (conv=%s, adet=%s)",
                    legacy_conv_id, len(stranded_unique),
                )

    return {
        "apply": bool(apply),
        "limit": limit,
        "scanned": scanned,
        "merged": sum(1 for e in evidence if e.get("applied")),
        "would_merge": sum(1 for e in evidence if not e.get("applied")),
        "skipped": skipped,
        "evidence": evidence,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="birleştirmeyi UYGULA (varsayılan: yalnızca plan)",
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--user-id", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    result = asyncio.run(
        repair_lid_splits(apply=args.apply, limit=args.limit, user_id=args.user_id)
    )

    for item in result["evidence"]:
        print(json.dumps(item, ensure_ascii=False, default=str))
    for item in result["skipped"]:
        print(json.dumps({"skipped": item}, ensure_ascii=False, default=str))

    mode = "UYGULANDI" if result["apply"] else "PLAN (yazmadi)"
    print(
        f"[lid-split-repair] {mode}: taranan={result['scanned']} "
        f"birlestirilen={result['merged']} birlestirilecek={result['would_merge']} "
        f"atlanan={len(result['skipped'])} limit={result['limit']}"
    )
    if not result["apply"] and result["would_merge"]:
        print("[lid-split-repair] uygulamak icin: --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
