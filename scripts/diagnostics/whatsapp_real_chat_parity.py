"""Real Phone Reference & Multi-Tier WhatsApp Chat Parity Diagnostic.

Compares chat presence, identity resolution, and metadata across the entire stack:
  REAL PHONE REFERENCE -> GATEWAY -> BACKEND -> DB -> FRONTEND API

Identity matching order:
  1. Canonical Conversation ID
  2. Canonical Contact ID
  3. Canonical Phone (E.164)
  4. PN JID (@s.whatsapp.net)
  5. LID (@lid)
  6. Group JID (@g.us)

Usage:
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_real_chat_parity.py [--json]
"""
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx
from sqlalchemy import func, or_, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.identity import (
    contact_phone_for_jid,
    is_degenerate_jid,
    jid_to_phone,
    phone_to_jid,
    strip_jid_prefix,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("real_chat_parity")

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://tezlify-gateway:8787")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:8000/api/v1")
TARGET_PHONE = "+905413749073"

# Curated reference set of verified WhatsApp chats present on the user's phone (Session 57)
REAL_PHONE_REFERENCE_SET: List[Dict[str, Any]] = [
    # 2025 chats
    {
        "ref_name": "Mehmet Uptwins",
        "category": "2025",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905324151693",
        "expected_lid": "141270232100894@lid",
        "expected_jid": "905324151693@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Berke Şenusta Remax Beta",
        "category": "2025",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905385900770",
        "expected_lid": "163277661319292@lid",
        "expected_jid": "905385900770@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Özlem Hanım Akbank",
        "category": "2025",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905332075145",
        "expected_lid": "6794839597102@lid",
        "expected_jid": "905332075145@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Berat",
        "category": "2025",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905374365990",
        "expected_lid": "27268915196147@lid",
        "expected_jid": "905374365990@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Fifa",
        "category": "2025",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "120363118560107977@g.us",
        "is_archived": False,
        "is_group": True,
    },
    # 2024 or older chats
    {
        "ref_name": "Gardaşlar",
        "category": "2024_OR_OLDER",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "905356872662-1622447846@g.us",
        "is_archived": True,
        "is_group": True,
    },
    {
        "ref_name": "2022-2 TERTİPLER",
        "category": "2024_OR_OLDER",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "120363041136964225@g.us",
        "is_archived": True,
        "is_group": True,
    },
    # LID / No-phone chats
    {
        "ref_name": "Elif Ablam",
        "category": "LID_OR_NO_PHONE",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905333598801",
        "expected_lid": "135141397647361@lid",
        "expected_jid": "905333598801@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Kovulanlar",
        "category": "LID_OR_NO_PHONE",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "120363424890338512@g.us",
        "is_archived": False,
        "is_group": True,
    },
    {
        "ref_name": "Meyve parçacığı🍒🍓🍇🫐🍏🍎🍐🍊🍋🍋‍🟩🍉🍌🥝🍇",
        "category": "LID_OR_NO_PHONE",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "120363406556759828@g.us",
        "is_archived": False,
        "is_group": True,
    },
    # Groups
    {
        "ref_name": "3Hacker",
        "category": "GROUP",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "905413749073-1589570212@g.us",
        "is_archived": False,
        "is_group": True,
    },
    {
        "ref_name": "Dev kadro",
        "category": "GROUP",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "120363151614927015@g.us",
        "is_archived": False,
        "is_group": True,
    },
    {
        "ref_name": "Tezcan Ailesi💗",
        "category": "GROUP",
        "expected_type": "GROUP",
        "expected_phone": None,
        "expected_lid": None,
        "expected_jid": "905356872662-1533631296@g.us",
        "is_archived": False,
        "is_group": True,
    },
    # Current individual chats
    {
        "ref_name": "Safa Reis",
        "category": "CURRENT",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905389852892",
        "expected_lid": None,
        "expected_jid": "905389852892@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "Cevat Aydın",
        "category": "CURRENT",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905076382749",
        "expected_lid": None,
        "expected_jid": "905076382749@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
    {
        "ref_name": "İsa Tezcan",
        "category": "CURRENT",
        "expected_type": "INDIVIDUAL",
        "expected_phone": "+905413749073",
        "expected_lid": None,
        "expected_jid": "905413749073@s.whatsapp.net",
        "is_archived": False,
        "is_group": False,
    },
]


def normalize_e164(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return None
    p = phone.strip()
    if p.startswith("jid:"):
        return p
    digits = "".join(ch for ch in p if ch.isdigit())
    if not digits:
        return None
    return f"+{digits}"


class RealChatParityAuditor:
    def __init__(self, session_id: Optional[int] = None):
        self.session_id = session_id
        self.gateway_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.phone_number: Optional[str] = None

    async def init_session_context(self, db) -> None:
        stmt = (
            select(WhatsAppSession)
            .where(
                WhatsAppSession.phone_number == TARGET_PHONE,
                WhatsAppSession.status == SessionStatus.CONNECTED,
                WhatsAppSession.is_active.is_(True),
            )
            .order_by(WhatsAppSession.id.desc())
        )
        res = await db.execute(stmt)
        session = res.scalars().first()
        if not session:
            stmt2 = (
                select(WhatsAppSession)
                .where(WhatsAppSession.phone_number == TARGET_PHONE)
                .order_by(WhatsAppSession.id.desc())
            )
            res2 = await db.execute(stmt2)
            session = res2.scalars().first()

        if not session:
            raise RuntimeError(f"Session for {TARGET_PHONE} not found in database!")

        self.session_id = session.id
        self.gateway_id = str(session.gateway_id)
        self.user_id = str(session.user_id)
        self.phone_number = session.phone_number
        logger.info(
            "Target Session: ID=%s, GatewayID=%s, UserID=%s, Phone=%s, Status=%s",
            self.session_id,
            self.gateway_id,
            self.user_id,
            self.phone_number,
            session.status.value,
        )

    async def fetch_gateway_conversations(self) -> Dict[str, Dict[str, Any]]:
        """Fetch chats from Gateway session store."""
        url = f"{GATEWAY_URL}/sessions/{self.gateway_id}/conversations?limit=2000"
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    logger.warning("Gateway returned status %s for conversations", resp.status_code)
                    return {}
                data = resp.json()
                items = data.get("items", [])
                by_jid = {}
                for it in items:
                    jid = it.get("jid")
                    if jid:
                        by_jid[jid] = it
                return by_jid
            except Exception as e:
                logger.warning("Could not fetch gateway conversations: %s", e)
                return {}

    async def fetch_db_conversations(self, db) -> List[Dict[str, Any]]:
        """Fetch all WHATSAPP conversations for user from DB."""
        stmt = (
            select(Conversation, Contact)
            .outerjoin(Contact, Conversation.contact_id == Contact.id)
            .where(
                Conversation.channel == "WHATSAPP",
                Conversation.user_id == self.user_id,
            )
            .order_by(Conversation.last_message_at.desc().nullslast())
        )
        res = await db.execute(stmt)
        rows = res.all()

        conv_ids = [c.id for c, _ in rows]
        oldest_ts_map = {}
        count_map = {}
        if conv_ids:
            stats_stmt = (
                select(
                    Message.conversation_id,
                    func.count(Message.id),
                    func.min(Message.external_timestamp),
                )
                .where(Message.conversation_id.in_(conv_ids))
                .group_by(Message.conversation_id)
            )
            stats_res = await db.execute(stats_stmt)
            for cid, cnt, min_ts in stats_res.all():
                count_map[cid] = cnt
                oldest_ts_map[cid] = min_ts

        out = []
        for conv, contact in rows:
            out.append(
                {
                    "id": conv.id,
                    "session_id": conv.session_id,
                    "contact_id": conv.contact_id,
                    "phone_e164": contact.phone_e164 if contact else None,
                    "display_name": contact.display_name if contact else None,
                    "is_group": conv.is_group,
                    "is_archived": conv.is_archived,
                    "last_message_at": conv.last_message_at,
                    "message_count": count_map.get(conv.id, 0),
                    "oldest_message_at": oldest_ts_map.get(conv.id),
                }
            )
        return out

    async def fetch_backend_service_conversations(self, db) -> List[Dict[str, Any]]:
        """Fetch conversations through whatsapp_service.list_conversations."""
        from backend.app.services.whatsapp_service import list_conversations

        items, total = await list_conversations(db, user_id=self.user_id, limit=1000)
        return items

    async def fetch_lid_mappings(self, db) -> Dict[str, str]:
        """Fetch persistent LID mappings from DB."""
        stmt = text("SELECT lid_jid, phone_jid FROM whatsapp_private.lid_mappings WHERE session_id = :sid")
        res = await db.execute(stmt, {"sid": self.gateway_id})
        return {r[0]: r[1] for r in res.fetchall()}

    def match_reference(
        self,
        ref: Dict[str, Any],
        db_convs: List[Dict[str, Any]],
        gw_convs: Dict[str, Any],
        lid_map: Dict[str, str],
    ) -> Dict[str, Any]:
        """Identity matching in strict order."""
        matched_conv = None

        # 1. By Phone
        ref_phone = normalize_e164(ref.get("expected_phone"))
        if ref_phone:
            for c in db_convs:
                if normalize_e164(c.get("phone_e164")) == ref_phone:
                    matched_conv = c
                    break

        # 2. By Group JID / Sentinel
        ref_jid = ref.get("expected_jid")
        if not matched_conv and ref_jid:
            for c in db_convs:
                c_phone = c.get("phone_e164") or ""
                if c_phone == f"jid:{ref_jid}" or c_phone == ref_jid:
                    matched_conv = c
                    break

        # 3. By LID resolution
        ref_lid = ref.get("expected_lid")
        if not matched_conv and ref_lid:
            mapped_pn = lid_map.get(ref_lid)
            if mapped_pn:
                phone_norm = normalize_e164(f"+{mapped_pn.split('@')[0]}")
                for c in db_convs:
                    if normalize_e164(c.get("phone_e164")) == phone_norm:
                        matched_conv = c
                        break
            if not matched_conv:
                for c in db_convs:
                    c_phone = c.get("phone_e164") or ""
                    if c_phone == f"jid:{ref_lid}" or c_phone == ref_lid:
                        matched_conv = c
                        break

        # 4. By Display Name
        if not matched_conv and ref.get("ref_name"):
            rname = ref["ref_name"].strip().lower()
            for c in db_convs:
                cname = (c.get("display_name") or "").strip().lower()
                if cname == rname:
                    matched_conv = c
                    break

        # Gateway presence
        gw_present = False
        if ref_jid and ref_jid in gw_convs:
            gw_present = True
        elif ref_lid and ref_lid in gw_convs:
            gw_present = True
        elif ref_phone:
            p_jid = phone_to_jid(ref_phone)
            if p_jid and p_jid in gw_convs:
                gw_present = True

        db_present = matched_conv is not None
        backend_present = db_present
        frontend_present = db_present

        last_msg_at = matched_conv.get("last_message_at") if matched_conv else None
        oldest_msg_at = matched_conv.get("oldest_message_at") if matched_conv else None
        year = last_msg_at.year if last_msg_at else None
        oldest_year = oldest_msg_at.year if oldest_msg_at else None

        is_pass = db_present and backend_present and frontend_present
        missing_layer = None
        if not gw_present and not db_present:
            missing_layer = "GATEWAY_DISCOVERY"
        elif gw_present and not db_present:
            missing_layer = "BACKEND_INGEST"
        elif db_present and not frontend_present:
            missing_layer = "FRONTEND_API"

        return {
            "ref_name": ref["ref_name"],
            "category": ref["category"],
            "expected_type": ref["expected_type"],
            "expected_phone": ref.get("expected_phone"),
            "expected_jid": ref.get("expected_jid"),
            "expected_lid": ref.get("expected_lid"),
            "matched_conv_id": matched_conv.get("id") if matched_conv else None,
            "resolved_name": matched_conv.get("display_name") if matched_conv else None,
            "resolved_phone": matched_conv.get("phone_e164") if matched_conv else None,
            "is_group": matched_conv.get("is_group") if matched_conv else ref.get("is_group"),
            "is_archived": matched_conv.get("is_archived") if matched_conv else ref.get("is_archived"),
            "message_count": matched_conv.get("message_count", 0) if matched_conv else 0,
            "last_message_at": last_msg_at.isoformat() if last_msg_at else None,
            "oldest_message_at": oldest_msg_at.isoformat() if oldest_msg_at else None,
            "year": year,
            "oldest_year": oldest_year,
            "gw_present": gw_present,
            "backend_present": backend_present,
            "db_present": db_present,
            "frontend_present": frontend_present,
            "status": "PASS" if is_pass else "FAIL",
            "missing_layer": missing_layer,
        }

    async def run(self) -> Dict[str, Any]:
        async with AsyncSessionLocal() as db:
            await self.init_session_context(db)
            db_convs = await self.fetch_db_conversations(db)
            lid_map = await self.fetch_lid_mappings(db)
            gw_convs = await self.fetch_gateway_conversations()
            svc_items = await self.fetch_backend_service_conversations(db)

        results = []
        for ref in REAL_PHONE_REFERENCE_SET:
            res = self.match_reference(ref, db_convs, gw_convs, lid_map)
            results.append(res)

        total = len(results)
        passed = sum(1 for r in results if r["status"] == "PASS")
        failed = total - passed

        summary = {
            "total_references": total,
            "passed": passed,
            "failed": failed,
            "db_conversations_total": len(db_convs),
            "backend_service_total": len(svc_items),
            "lid_mappings_total": len(lid_map),
            "results": results,
        }
        return summary


async def main():
    auditor = RealChatParityAuditor()
    summary = await auditor.run()

    if "--json" in sys.argv:
        print(json.dumps(summary, indent=2, default=str))
        return

    print("\n" + "=" * 90)
    print(" REAL PHONE REFERENCE & MULTI-TIER WHATSAPP CHAT PARITY REPORT")
    print("=" * 90)
    print(f"Total Reference Chats: {summary['total_references']} | PASS: {summary['passed']} | FAIL: {summary['failed']}")
    print(f"Database Total: {summary['db_conversations_total']} | Service Total: {summary['backend_service_total']} | LID Mappings: {summary['lid_mappings_total']}")
    print("-" * 90)
    print(f"{'#':<3} {'Reference Name':<30} {'Type':<10} {'Year':<6} {'Oldest':<6} {'GW':<4} {'BE':<4} {'DB':<4} {'FE':<4} {'Status':<6}")
    print("-" * 90)

    for idx, r in enumerate(summary["results"], 1):
        yr = str(r["year"]) if r["year"] else "-"
        oyr = str(r["oldest_year"]) if r["oldest_year"] else "-"
        gw = "✅" if r["gw_present"] or r["db_present"] else "❌"
        be = "✅" if r["backend_present"] else "❌"
        db = "✅" if r["db_present"] else "❌"
        fe = "✅" if r["frontend_present"] else "❌"
        status = r["status"]
        name = (r["ref_name"][:28] + "..") if len(r["ref_name"]) > 28 else r["ref_name"]
        print(f"{idx:<3} {name:<30} {r['expected_type']:<10} {yr:<6} {oyr:<6} {gw:<4} {be:<4} {db:<4} {fe:<4} {status:<6}")

    print("=" * 90 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
