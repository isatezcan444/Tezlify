"""Telefon gerektiren iki senkron ölçümünün ARACI: önce/sonra kanıtı toplar.

Neden bir araç
--------------
"Rozet düştü" ve "sohbet telefondan gitti" elle ölçüldüğünde kanıt parmakla
gösterilir hale gelir: hangi sohbet, hangi değerden hangi değere, hangi saniyede?
Bu üç sorunun cevabı kayda geçmezse ölçüm tartışmaya açık kalır ve "bence oldu"
ile "ölçtüm, oldu" ayırt edilemez.

Araç ölçümü üç adıma böler ve hiçbir şeyi DEĞİŞTİRMEZ:

  --list-candidates                        ölçüme uygun sohbetleri listeler
  --snapshot --conversation N --out b.json ölçüm öncesi durumu JSON'a yazar
  --diff b.json a.json                     beklenen geçişleri satır satır söyler
  --logs                                   kanıt için koşulacak log komutlarını yazdırır

Protokol: `docs/whatsapp-handset-measurement-protocol.md`.

Kullanım (üretim, backend konteyneri içinde — betik salt-okunurdur):
  docker cp scripts/diagnostics/whatsapp_handset_measure.py tezlify-backend:/tmp/handset.py
  docker exec -e PYTHONPATH=/app -w /app tezlify-backend python /tmp/handset.py --list-candidates

`--diff` çıkış kodu: 0 = beklenen geçişlerin hepsi gerçekleşti, 1 = en az biri
gerçekleşmedi, 2 = kanıt eksik/okunamadı. "Kaldı" demek, ölçümün başarısız
olduğunu değil, İDDİANIN doğrulanamadığını söyler.
"""
import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession

logger = logging.getLogger("handset_measure")

UNSAFE_PHONE_PREFIX = "jid:"


def _mask(value: Optional[str], show: bool) -> str:
    """Telefon numarasını varsayılan olarak maskeler: bu betik bir transkripte kopyalanabilir."""
    if not value:
        return "-"
    text = str(value)
    if show or text.startswith(UNSAFE_PHONE_PREFIX) or not text.startswith("+"):
        return text
    return text[:4] + "*" * max(0, len(text) - 7) + text[-4:]


def _is_json_mode(value: Any) -> bool:
    return isinstance(value, dict)


async def list_candidates(*, limit: int, show_phones: bool, user_id: Optional[str]) -> List[Dict[str, Any]]:
    """Rozet ölçümüne UYGUN sohbetler: okunmamışı olan, aktif, kanonik kimlikli.

    Hayalet kimlikli (`jid:...@lid`) sohbetler bilinçli olarak dışlanır: rozet
    ölçümü kanonik sohbette yapılmalıdır, yoksa "rozet düştü mü" sorusu
    birleştirilmemiş bir satır hakkında sorulmuş olur.
    """
    rows: List[Dict[str, Any]] = []
    async with AsyncSessionLocal() as db:
        stmt = (
            select(
                Conversation.id,
                Conversation.unread_count,
                Conversation.last_message_at,
                Conversation.is_archived,
                Contact.phone_e164,
                WhatsAppSession.gateway_id,
                WhatsAppSession.status,
            )
            .join(Contact, Contact.id == Conversation.contact_id, isouter=True)
            .join(WhatsAppSession, WhatsAppSession.id == Conversation.session_id, isouter=True)
            .where(
                Conversation.channel == "WHATSAPP",
                Conversation.is_archived.is_(False),
                Conversation.unread_count > 0,
            )
            .order_by(Conversation.unread_count.desc(), Conversation.last_message_at.desc())
            .limit(limit)
        )
        if user_id:
            stmt = stmt.where(Conversation.user_id == user_id)
        for conv_id, unread, last_at, archived, phone, gw_id, gw_status in (
            await db.execute(stmt)
        ).all():
            rows.append(
                {
                    "conversation_id": conv_id,
                    "unread_count": unread,
                    "last_message_at": last_at.isoformat() if last_at else None,
                    "phone": _mask(phone, show_phones),
                    "gateway_id": gw_id,
                    "session_status": getattr(gw_status, "value", gw_status),
                    "measurable": bool(
                        phone
                        and not str(phone).startswith(UNSAFE_PHONE_PREFIX)
                        and gw_id
                        and getattr(gw_status, "value", gw_status) == "CONNECTED"
                    ),
                }
            )
    return rows


async def snapshot(*, conversation_id: int, gateway_cache: bool) -> Dict[str, Any]:
    """Bir sohbetin ölçüm öncesi/sonrası durumu (salt okuma)."""
    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == conversation_id))
        ).scalar_one_or_none()
        if conv is None:
            return {
                "mode": "snapshot",
                "conversation_id": conversation_id,
                "exists": False,
                "captured_at": datetime.utcnow().isoformat(),
            }
        contact = (
            await db.execute(select(Contact).where(Contact.id == conv.contact_id))
        ).scalar_one_or_none()
        session = (
            await db.execute(select(WhatsAppSession).where(WhatsAppSession.id == conv.session_id))
        ).scalar_one_or_none()
        messages = (
            await db.execute(
                select(Message.id, Message.wa_message_id, Message.direction, Message.created_at)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.id.desc())
                .limit(5)
            )
        ).all()
        message_count = len(
            (await db.execute(select(Message.id).where(Message.conversation_id == conversation_id))).all()
        )

    data: Dict[str, Any] = {
        "mode": "snapshot",
        "conversation_id": conversation_id,
        "exists": True,
        "captured_at": datetime.utcnow().isoformat(),
        "user_id": str(conv.user_id),
        "unread_count": conv.unread_count,
        "last_message_at": conv.last_message_at.isoformat() if conv.last_message_at else None,
        "last_message_preview": conv.last_message_preview,
        "is_archived": bool(conv.is_archived),
        "status": getattr(conv.status, "value", conv.status),
        "contact_phone": contact.phone_e164 if contact else None,
        "contact_is_ghost_lid": bool(contact and str(contact.phone_e164).startswith(UNSAFE_PHONE_PREFIX)),
        "session_id": conv.session_id,
        "gateway_id": session.gateway_id if session else None,
        "session_status": getattr(session.status, "value", session.status) if session else None,
        "message_count": message_count,
        "newest_messages": [
            {
                "id": mid,
                "wa_message_id": wa_id,
                "direction": getattr(direction, "value", direction),
                "created_at": created.isoformat() if created else None,
            }
            for mid, wa_id, direction, created in messages
        ],
    }

    if gateway_cache and data["gateway_id"]:
        # Gateway'in KENDİ sayacı ile DB'yi yan yana koymak, "kim haklı"
        # sorusunu log okumadan cevaplar (Faz 6'da tam bu fark yakalanmıştı).
        try:
            from backend.app.services import whatsapp_gateway as gw

            payload = await gw.list_conversations(data["gateway_id"])
            items = payload if isinstance(payload, list) else (payload or {}).get("conversations", [])
            match = None
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                jid = item.get("jid") or item.get("id")
                phone = data["contact_phone"]
                if jid and phone and (jid == phone or jid.split("@")[0] in str(phone)):
                    match = {
                        "jid": jid,
                        "unread_count": item.get("unread_count"),
                        "last_message_at": item.get("last_message_at"),
                    }
                    break
            data["gateway_cache"] = match or {"error": "sohbet gateway onbelleginde yok"}
        except Exception as exc:  # noqa: BLE001 - kanıt toplarken hata ölçümü durdurmaz
            data["gateway_cache"] = {"error": str(exc)[:200]}
    return data


def diff_snapshots(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    """Beklenen geçişleri tek tek söyler; sessiz kalan bir geçiş yoktur."""
    checks: List[Dict[str, Any]] = []

    def _check(name: str, passed: Optional[bool], detail: str) -> None:
        checks.append({"check": name, "passed": passed, "detail": detail})

    if not before.get("exists"):
        return {"verdict": "KANIT-EKSIK", "checks": [], "reason": "before snapshot yok"}

    if not after.get("exists"):
        # Silme ölçümünün beklenen sonucu: sohbet ARTIK YOK.
        _check("conversation_removed", True, "sohbet yerel olarak silinmiş")
        _check("db_unread_zero", True, "satır yok, okunmamış da yok")
        verdict = "GECTI" if all(c["passed"] for c in checks) else "KALDI"
        return {"verdict": verdict, "checks": checks}

    before_unread = before.get("unread_count")
    after_unread = after.get("unread_count")
    if before_unread is None or after_unread is None:
        _check("db_unread_dropped", None, "okunmamış değeri okunamadı")
    elif after_unread < before_unread:
        _check(
            "db_unread_dropped",
            True,
            f"{before_unread} → {after_unread} (düştü; hedef 0)",
        )
    elif after_unread == before_unread:
        _check(
            "db_unread_dropped",
            False,
            f"{before_unread} → {after_unread} (değişmedi — olay ya gelmedi ya reddedildi)",
        )
    else:
        _check(
            "db_unread_dropped",
            False,
            f"{before_unread} → {after_unread} (ARTTI — bu bir yeniden okuma değil)",
        )
    _check(
        "db_unread_reached_zero",
        bool(after_unread == 0),
        f"son değer {after_unread} (rozet sıfırlanmış olmalı)",
    )
    _check(
        "message_count_unchanged",
        before.get("message_count") == after.get("message_count"),
        f"{before.get('message_count')} → {after.get('message_count')}",
    )
    gw_before = (before.get("gateway_cache") or {}).get("unread_count")
    gw_after = (after.get("gateway_cache") or {}).get("unread_count")
    if gw_before is None or gw_after is None:
        _check("gateway_cache_unread", None, "gateway önbelleği okunamadı (kanıt eksik)")
    else:
        _check(
            "gateway_cache_unread",
            int(gw_after) <= int(gw_before),
            f"gateway sayacı {gw_before} → {gw_after}",
        )

    hard = [c for c in checks if c["passed"] is False]
    missing = [c for c in checks if c["passed"] is None]
    verdict = "GECTI" if not hard and not missing else ("KANIT-EKSIK" if not hard else "KALDI")
    return {"verdict": verdict, "checks": checks}


LOG_COMMANDS = [
    "# Olayın gateway'e GELDİĞİNİN kanıtı (rozet ölçümü):",
    "docker logs tezlify-gateway --since 15m 2>&1 | grep -iE \"conversation_updated|unread|chats.update\" | tail -20",
    "# Uzaktan silmenin SAĞLAYICIYA gittiğinin kanıtı (silme ölçümü):",
    "docker logs tezlify-gateway --since 15m 2>&1 | grep -iE \"Delete conversation|chatModify\" | tail -20",
    "# Backend'in dürüst raporu:",
    "docker logs tezlify-backend --since 15m 2>&1 | grep -iE \"Sohbet silindi|uzaktan silinemedi\" | tail -20",
]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-candidates", action="store_true")
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("--diff", nargs=2, metavar=("BEFORE", "AFTER"))
    parser.add_argument("--logs", action="store_true")
    parser.add_argument("--conversation", type=int, default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--show-phones", action="store_true")
    parser.add_argument("--no-gateway-cache", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    if args.logs:
        for line in LOG_COMMANDS:
            print(line)
        return 0

    if args.list_candidates:
        rows = asyncio.run(
            list_candidates(limit=args.limit, show_phones=args.show_phones, user_id=args.user_id)
        )
        for row in rows:
            print(json.dumps(row, ensure_ascii=False, default=str))
        measurable = sum(1 for r in rows if r["measurable"])
        print(
            f"[handset-measure] {len(rows)} okunmamış sohbet, ölçülebilir={measurable} "
            f"(limit={args.limit})"
        )
        return 0

    if args.snapshot:
        if not args.conversation:
            print("[handset-measure] --snapshot icin --conversation gerekli", file=sys.stderr)
            return 2
        data = asyncio.run(
            snapshot(conversation_id=args.conversation, gateway_cache=not args.no_gateway_cache)
        )
        payload = json.dumps(data, ensure_ascii=False, indent=2, default=str)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(payload)
            print(f"[handset-measure] yazildi: {args.out}")
        else:
            print(payload)
        return 0

    if args.diff:
        try:
            with open(args.diff[0], encoding="utf-8") as fh:
                before = json.load(fh)
            with open(args.diff[1], encoding="utf-8") as fh:
                after = json.load(fh)
        except Exception as exc:  # noqa: BLE001 - kanıt okunamazsa hüküm verilmez
            print(f"[handset-measure] kanit okunamadi: {exc}", file=sys.stderr)
            return 2
        result = diff_snapshots(before, after)
        for check in result["checks"]:
            mark = {True: "GECTI", False: "KALDI", None: "KANIT-EKSIK"}[check["passed"]]
            print(f"[{mark}] {check['check']}: {check['detail']}")
        print(f"[handset-measure] HUKUM: {result['verdict']}")
        if result["verdict"] == "GECTI":
            return 0
        return 1 if result["verdict"] == "KALDI" else 2

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
