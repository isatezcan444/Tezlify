#!/usr/bin/env python3
"""Phase 15 Production History Completion Audit & Dashboard.

Audits all conversations for Session 57 (or specified session) against
whatsapp_private.history_sync_states, ensuring UNKNOWN = 0 and NEVER_CHECKED = 0.
Optionally executes a controlled background sweep.

Usage:
  python3 scripts/diagnostics/whatsapp_history_completion_report.py [--session-id 57] [--sweep]
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

# Add repository root to pythonpath
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.whatsapp.identity import phone_to_jid
from backend.app.services.whatsapp.orchestration.sync import _run_background_history_expansion


async def run_history_audit(
    session_id: int = 57,
    do_sweep: bool = False,
) -> Dict[str, Any]:
    async with AsyncSessionLocal() as db:
        sess = await db.get(WhatsAppSession, session_id)
        if not sess:
            print(f"[ERROR] Session {session_id} not found in whatsapp_sessions")
            return {}

        user_id = str(sess.user_id)
        gateway_id = str(sess.gateway_id)
        print(f"\nTarget Session: ID={sess.id}, GatewayID={gateway_id}, Phone={sess.phone_number}, UserID={user_id}")

        if do_sweep:
            print("[INFO] Starting controlled background history expansion sweep across all conversations...")
            await _run_background_history_expansion(user_id, gateway_id)
            print("[INFO] Background history expansion sweep completed.")

        # 1. Fetch all conversations for user
        c_stmt = (
            select(Conversation, Contact)
            .outerjoin(Contact, Conversation.contact_id == Contact.id)
            .where(
                Conversation.channel == "WHATSAPP",
                Conversation.user_id == sess.user_id,
            )
            .order_by(Conversation.last_message_at.desc().nullslast())
        )
        c_res = await db.execute(c_stmt)
        conv_rows = c_res.all()

        # 2. Fetch message statistics per conversation
        stats_stmt = text(
            """
            SELECT
                conversation_id,
                COUNT(id) as msg_count,
                MIN(external_timestamp) as oldest_ts,
                MAX(external_timestamp) as latest_ts
            FROM messages
            WHERE conversation_id IN (
                SELECT id FROM conversations WHERE channel = 'WHATSAPP' AND user_id = :uid
            )
            GROUP BY conversation_id
            """
        )
        stats_res = await db.execute(stats_stmt, {"uid": sess.user_id})
        stats_map = {
            r[0]: {"count": r[1], "oldest": r[2], "latest": r[3]}
            for r in stats_res.fetchall()
        }

        # 3. Fetch history sync states for this gateway session
        state_stmt = text(
            """
            SELECT
                jid,
                oldest_msg_id,
                oldest_timestamp_ms,
                has_more,
                completed_at,
                state,
                stall_count,
                timeout_count,
                error_count,
                last_attempt_at,
                last_success_at,
                last_error,
                updated_at
            FROM whatsapp_private.history_sync_states
            WHERE session_id = :sid
            """
        )
        state_res = await db.execute(state_stmt, {"sid": gateway_id})
        state_map = {}
        for r in state_res.fetchall():
            state_map[r[0]] = {
                "oldest_msg_id": r[1],
                "oldest_timestamp_ms": r[2],
                "has_more": r[3],
                "completed_at": r[4],
                "state": r[5],
                "stall_count": r[6] or 0,
                "timeout_count": r[7] or 0,
                "error_count": r[8] or 0,
                "last_attempt_at": r[9],
                "last_success_at": r[10],
                "last_error": r[11],
                "updated_at": r[12],
            }

        # 4. Classify each conversation
        classified_list = []
        counts = {
            "FULLY_EXHAUSTED": 0,
            "HAS_MORE": 0,
            "TEMP_TIMEOUT": 0,
            "CURSOR_STALLED": 0,
            "NO_MESSAGES": 0,
            "ERROR": 0,
            "NEVER_CHECKED": 0,
            "UNKNOWN": 0,
        }

        for conv, contact in conv_rows:
            phone_val = str(contact.phone_e164) if contact and contact.phone_e164 else ""
            jid = phone_val[4:] if phone_val.startswith("jid:") else (phone_to_jid(phone_val) if phone_val else "")
            stats = stats_map.get(conv.id, {"count": 0, "oldest": None, "latest": None})
            cnt = stats["count"]
            oldest_ts = stats["oldest"]
            latest_ts = stats["latest"] or conv.last_message_at

            sync = state_map.get(jid) if jid else None

            # Classification
            if cnt == 0:
                cat = "NO_MESSAGES"
            elif sync is None:
                cat = "NEVER_CHECKED"
            else:
                db_state = (sync.get("state") or "").upper()
                if db_state in ("EXHAUSTED", "FULLY_EXHAUSTED", "COMPLETED") or (not sync["has_more"] and sync["completed_at"]):
                    cat = "FULLY_EXHAUSTED"
                elif db_state == "TEMPORARY_TIMEOUT":
                    cat = "TEMP_TIMEOUT"
                elif db_state == "CURSOR_STALLED":
                    cat = "CURSOR_STALLED"
                elif db_state == "ERROR":
                    cat = "ERROR"
                elif db_state in ("HAS_MORE", "IN_PROGRESS") or sync["has_more"]:
                    cat = "HAS_MORE"
                elif db_state == "NO_MESSAGES":
                    cat = "NO_MESSAGES"
                elif db_state == "NEVER_CHECKED":
                    cat = "NEVER_CHECKED"
                else:
                    cat = "UNKNOWN"

            counts[cat] += 1

            classified_list.append({
                "conversation_id": conv.id,
                "name": contact.display_name if contact else "Bilinmeyen",
                "phone_or_jid": jid or phone_val or f"conv:{conv.id}",
                "message_count": cnt,
                "oldest_message": oldest_ts.strftime("%Y-%m-%d %H:%M:%S") if oldest_ts else "-",
                "latest_message": latest_ts.strftime("%Y-%m-%d %H:%M:%S") if latest_ts else "-",
                "history_state": cat,
                "has_more": sync["has_more"] if sync else False,
                "oldest_timestamp_ms": sync.get("oldest_timestamp_ms") if sync else None,
                "stall_count": sync.get("stall_count", 0) if sync else 0,
                "timeout_count": sync.get("timeout_count", 0) if sync else 0,
                "last_error": sync.get("last_error") if sync else None,
            })

    # Print Dashboard
    total_convs = len(classified_list)
    print("\n" + "=" * 80)
    print(f"=== SESSION {session_id} ===")
    print("=" * 80)
    print(f"Total conversations: {total_convs}\n")
    print(f"FULLY_EXHAUSTED:\n  {counts['FULLY_EXHAUSTED']}\n")
    print(f"HAS_MORE:\n  {counts['HAS_MORE']}\n")
    print(f"TEMP_TIMEOUT:\n  {counts['TEMP_TIMEOUT']}\n")
    print(f"CURSOR_STALLED:\n  {counts['CURSOR_STALLED']}\n")
    print(f"ERROR:\n  {counts['ERROR']}\n")
    print(f"NEVER_CHECKED:\n  {counts['NEVER_CHECKED']}\n")
    print(f"UNKNOWN:\n  {counts['UNKNOWN']}\n")
    print(f"NO_HISTORY:\n  {counts['NO_MESSAGES']}\n")
    print("-" * 80)

    # Sort to show 20 oldest conversations
    # Filter for those with oldest_message != '-'
    with_history = [c for c in classified_list if c["oldest_message"] != "-"]
    with_history.sort(key=lambda x: x["oldest_message"])
    top20 = with_history[:20]

    print(f"\nEN ESKİ 20 SOHBET (Top 20 Oldest Conversations):")
    print("-" * 135)
    print(f"{'ID':<6} {'Name':<22} {'Phone/JID/LID':<30} {'Msgs':<5} {'Oldest':<19} {'Latest':<19} {'State':<15} {'HasMore'}")
    print("-" * 135)
    for c in top20:
        name_trunc = (c['name'][:20] + "..") if len(c['name']) > 22 else c['name']
        jid_trunc = (c['phone_or_jid'][:28] + "..") if len(c['phone_or_jid']) > 30 else c['phone_or_jid']
        print(f"{c['conversation_id']:<6} {name_trunc:<22} {jid_trunc:<30} {c['message_count']:<5} {c['oldest_message']:<19} {c['latest_message']:<19} {c['history_state']:<15} {c['has_more']}")
    print("=" * 135)

    return {
        "total": total_convs,
        "counts": counts,
        "items": classified_list,
    }


def main():
    parser = argparse.ArgumentParser(description="Phase 15 WhatsApp History Completion Audit")
    parser.add_argument("--session-id", type=int, default=57, help="Target whatsapp_session id (default: 57)")
    parser.add_argument("--sweep", action="store_true", help="Trigger background history expansion sweep before report")
    args = parser.parse_args()

    asyncio.run(run_history_audit(session_id=args.session_id, do_sweep=args.sweep))


if __name__ == "__main__":
    main()
