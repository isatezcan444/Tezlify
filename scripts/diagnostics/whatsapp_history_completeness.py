"""WhatsApp History Completeness Diagnostic.

Audits per-conversation history completeness, provider checkpoints, and hydration states:
  - CURRENT_ONLY: Messages only from recent period (2026), unhydrated historical batches.
  - HISTORICAL: Last activity belongs to 2025 or earlier.
  - FULLY_HYDRATED: Provider stream exhausted (has_more = False, completed_at IS NOT NULL).
  - PARTIALLY_HYDRATED: History exists, but has_more = True (further pages available).
  - UNKNOWN: No history_sync_states record exists.
  - NO_HISTORY: 0 messages in database.

Usage:
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_history_completeness.py [--json] [--eligible-only]
"""
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.whatsapp.identity import phone_to_jid

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("history_completeness")

TARGET_PHONE = "+905413749073"


class HistoryCompletenessAuditor:
    def __init__(self):
        self.session_id: Optional[int] = None
        self.gateway_id: Optional[str] = None
        self.user_id: Optional[str] = None

    async def init_session_context(self, db) -> None:
        stmt = (
            select(WhatsAppSession)
            .where(WhatsAppSession.phone_number == TARGET_PHONE)
            .order_by(WhatsAppSession.id.desc())
        )
        res = await db.execute(stmt)
        session = res.scalars().first()
        if not session:
            raise RuntimeError(f"Session for {TARGET_PHONE} not found!")

        self.session_id = session.id
        self.gateway_id = str(session.gateway_id)
        self.user_id = str(session.user_id)

    async def run(self) -> Dict[str, Any]:
        async with AsyncSessionLocal() as db:
            await self.init_session_context(db)

            # 1. Fetch conversations with contacts
            conv_stmt = (
                select(Conversation, Contact)
                .outerjoin(Contact, Conversation.contact_id == Contact.id)
                .where(
                    Conversation.channel == "WHATSAPP",
                    Conversation.user_id == self.user_id,
                )
                .order_by(Conversation.last_message_at.desc().nullslast())
            )
            conv_res = await db.execute(conv_stmt)
            conv_rows = conv_res.all()

            conv_ids = [c.id for c, _ in conv_rows]

            # 2. Fetch message aggregations
            stats_map = {}
            if conv_ids:
                stats_stmt = (
                    select(
                        Message.conversation_id,
                        func.count(Message.id),
                        func.min(Message.external_timestamp),
                        func.max(Message.external_timestamp),
                    )
                    .where(Message.conversation_id.in_(conv_ids))
                    .group_by(Message.conversation_id)
                )
                stats_res = await db.execute(stats_stmt)
                for cid, cnt, min_ts, max_ts in stats_res.all():
                    stats_map[cid] = {"count": cnt, "oldest": min_ts, "latest": max_ts}

            # 3. Fetch history sync states for session
            state_stmt = text(
                "SELECT jid, oldest_msg_id, oldest_timestamp_ms, has_more, completed_at, updated_at "
                "FROM whatsapp_private.history_sync_states WHERE session_id = :sid"
            )
            state_res = await db.execute(state_stmt, {"sid": self.gateway_id})
            state_map = {}
            for r in state_res.fetchall():
                state_map[r[0]] = {
                    "oldest_msg_id": r[1],
                    "oldest_timestamp_ms": r[2],
                    "has_more": r[3],
                    "completed_at": r[4],
                    "updated_at": r[5],
                }

        results = []
        category_counts = {
            "CURRENT_ONLY": 0,
            "HISTORICAL": 0,
            "FULLY_HYDRATED": 0,
            "PARTIALLY_HYDRATED": 0,
            "UNKNOWN": 0,
            "NO_HISTORY": 0,
        }

        for conv, contact in conv_rows:
            phone_val = contact.phone_e164 if contact else ""
            jid = phone_val[4:] if phone_val.startswith("jid:") else phone_to_jid(phone_val)
            stats = stats_map.get(conv.id, {"count": 0, "oldest": None, "latest": None})
            cnt = stats["count"]
            oldest_ts = stats["oldest"]
            latest_ts = stats["latest"] or conv.last_message_at

            sync_state = state_map.get(jid) if jid else None

            # Classification logic
            if cnt == 0:
                category = "NO_HISTORY"
            elif sync_state and not sync_state["has_more"] and sync_state["completed_at"]:
                category = "FULLY_HYDRATED"
            elif sync_state and sync_state["has_more"]:
                category = "PARTIALLY_HYDRATED"
            elif sync_state is None:
                category = "UNKNOWN"
            else:
                if latest_ts and latest_ts.year <= 2025:
                    category = "HISTORICAL"
                else:
                    category = "CURRENT_ONLY"

            category_counts[category] += 1

            results.append(
                {
                    "conversation_id": conv.id,
                    "contact_id": conv.contact_id,
                    "display_name": contact.display_name if contact else None,
                    "phone": phone_val,
                    "jid": jid,
                    "is_group": conv.is_group,
                    "is_archived": conv.is_archived,
                    "message_count": cnt,
                    "latest_message_at": latest_ts.isoformat() if latest_ts else None,
                    "oldest_message_at": oldest_ts.isoformat() if oldest_ts else None,
                    "category": category,
                    "sync_state": {
                        "has_more": sync_state["has_more"] if sync_state else None,
                        "completed": bool(sync_state["completed_at"]) if sync_state else False,
                        "oldest_msg_id": sync_state["oldest_msg_id"] if sync_state else None,
                    }
                    if sync_state
                    else None,
                }
            )

        return {
            "session_id": self.session_id,
            "gateway_id": self.gateway_id,
            "total_conversations": len(results),
            "category_counts": category_counts,
            "eligible_for_hydration": [
                r for r in results if r["category"] in ("PARTIALLY_HYDRATED", "UNKNOWN", "HISTORICAL")
            ],
            "conversations": results,
        }


async def main():
    auditor = HistoryCompletenessAuditor()
    data = await auditor.run()

    if "--json" in sys.argv:
        print(json.dumps(data, indent=2, default=str))
        return

    print("\n" + "=" * 90)
    print(" WHATSAPP CONVERSATION HISTORY COMPLETENESS AUDIT")
    print("=" * 90)
    print(f"Total Conversations: {data['total_conversations']}")
    for cat, cnt in data["category_counts"].items():
        print(f"  - {cat:<20}: {cnt}")
    print(f"Eligible for Hydration Expansion: {len(data['eligible_for_hydration'])}")
    print("-" * 90)
    print(f"{'ID':<6} {'Name':<28} {'Msgs':<6} {'Oldest':<12} {'Latest':<12} {'Category':<18} {'HasMore':<8}")
    print("-" * 90)

    for r in data["conversations"][:25]:
        name = (r["display_name"][:26] + "..") if r["display_name"] and len(r["display_name"]) > 26 else (r["display_name"] or "-")
        oldest = str(r["oldest_message_at"][:10]) if r["oldest_message_at"] else "-"
        latest = str(r["latest_message_at"][:10]) if r["latest_message_at"] else "-"
        has_more_str = str(r["sync_state"]["has_more"]) if r["sync_state"] else "unknown"
        print(f"{r['conversation_id']:<6} {name:<28} {r['message_count']:<6} {oldest:<12} {latest:<12} {r['category']:<18} {has_more_str:<8}")

    print("=" * 90 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
