#!/usr/bin/env python3
"""
Extended Phase 15.4 Post-Deploy Reality Check Diagnostics.
READ-ONLY inspection of production database states and logs.
"""
import asyncio
import json
from datetime import datetime, timedelta
from sqlalchemy import text
from backend.app.core.database import AsyncSessionLocal
from backend.app.services.whatsapp.identity import (
    is_raw_jid_name,
    safe_display_name,
)

async def main():
    report = {}
    async with AsyncSessionLocal() as db:
        # -------------------------------------------------------------
        # SECTION F: ORDERING REALITY CHECK (>= 100 CONVERSATIONS)
        # -------------------------------------------------------------
        conv_order_res = await db.execute(text("""
            SELECT 
                c.id, 
                c.session_id,
                c.last_message_at, 
                count(m.id) as msg_count, 
                max(m.external_timestamp) as max_external_ts, 
                max(m.created_at) as max_created_at,
                c.last_message_preview
            FROM public.conversations c
            LEFT JOIN public.messages m ON m.conversation_id = c.id
            GROUP BY c.id, c.session_id, c.last_message_at, c.last_message_preview
            ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
            LIMIT 150
        """))
        conv_rows = conv_order_res.fetchall()
        
        ordering_samples = []
        ordering_mismatches = 0
        total_with_messages = 0
        
        for r in conv_rows:
            cid, sid, lm_at, cnt, max_ext, max_created, preview = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
            max_msg_ts = max_ext or max_created
            mismatch = False
            diff_sec = 0.0
            if cnt > 0 and lm_at and max_msg_ts:
                total_with_messages += 1
                diff_sec = (lm_at - max_msg_ts).total_seconds()
                # Invariant: lm_at must not be older than the newest message in the conversation.
                # If lm_at < max_msg_ts by more than 2 seconds, that's an ordering inversion/mismatch!
                # Note: lm_at can be >= max_msg_ts if a message preview was set from gateway chat metadata without full body sync yet.
                if diff_sec < -2.0:
                    mismatch = True
                    ordering_mismatches += 1
            elif cnt > 0 and not lm_at:
                mismatch = True
                ordering_mismatches += 1
                
            ordering_samples.append({
                "conversation_id": cid,
                "session_id": sid,
                "last_message_at": lm_at.isoformat() if lm_at else None,
                "message_count": cnt,
                "max_message_ts": max_msg_ts.isoformat() if max_msg_ts else None,
                "diff_sec": round(diff_sec, 2),
                "mismatch": mismatch,
            })

        # Test pagination ordering simulation (page 1: 0-35, page 2: 35-70, page 3: 70-105)
        pages_concatenated = []
        p1 = conv_rows[0:35]
        p2 = conv_rows[35:70]
        p3 = conv_rows[70:105]
        pages_concatenated = p1 + p2 + p3
        pagination_inversions = 0
        for i in range(len(pages_concatenated) - 1):
            ts_curr = pages_concatenated[i][2]
            ts_next = pages_concatenated[i+1][2]
            if ts_curr and ts_next and ts_next > ts_curr:
                pagination_inversions += 1
            elif not ts_curr and ts_next:
                # NULL appeared before a valid timestamp
                pagination_inversions += 1

        report["section_f_ordering"] = {
            "total_conversations_checked": len(conv_rows),
            "total_conversations_with_messages": total_with_messages,
            "ordering_mismatches": ordering_mismatches,
            "pagination_inversions": pagination_inversions,
            "samples_first_15": ordering_samples[:15],
        }

        # -------------------------------------------------------------
        # SECTION K: PHASE 15.3 INVARIANT CHECK
        # -------------------------------------------------------------
        sync_states_res = await db.execute(text("""
            SELECT session_id, state, provider_checked, provider_signal, count(*) as count
            FROM whatsapp_private.history_sync_states
            GROUP BY session_id, state, provider_checked, provider_signal
            ORDER BY session_id, count DESC
        """))
        sync_rows = sync_states_res.fetchall()
        
        k_summary = {
            "total_rows": 0,
            "provider_checked_true": 0,
            "provider_checked_false": 0,
            "by_session": {},
            "by_state": {},
            "groups": [],
        }
        
        for r in sync_rows:
            sid, state, checked, signal, cnt = str(r[0]), str(r[1]), bool(r[2]), str(r[3]), int(r[4])
            k_summary["total_rows"] += cnt
            if checked:
                k_summary["provider_checked_true"] += cnt
            else:
                k_summary["provider_checked_false"] += cnt
            
            k_summary["by_session"].setdefault(sid, {"total": 0, "provider_checked_true": 0, "provider_checked_false": 0})
            k_summary["by_session"][sid]["total"] += cnt
            if checked:
                k_summary["by_session"][sid]["provider_checked_true"] += cnt
            else:
                k_summary["by_session"][sid]["provider_checked_false"] += cnt
                
            k_summary["by_state"][state] = k_summary["by_state"].get(state, 0) + cnt
            k_summary["groups"].append({
                "session_id": sid,
                "state": state,
                "provider_checked": checked,
                "provider_signal": signal,
                "count": cnt,
            })

        report["section_k_phase153_invariants"] = k_summary

        # -------------------------------------------------------------
        # SECTION L: QR PRE-FLIGHT (DATABASE AUDIT)
        # -------------------------------------------------------------
        sessions_res = await db.execute(text("""
            SELECT 
                s.id, s.user_id, s.gateway_id, s.session_name, s.status, s.phone_number, 
                s.is_active, s.is_phone_online, s.created_at, s.updated_at,
                (SELECT count(*) FROM whatsapp_private.history_sync_states h WHERE h.session_id = s.gateway_id) as history_state_count,
                (SELECT count(*) FROM public.conversations c WHERE c.session_id = s.id) as conversation_count
            FROM public.whatsapp_sessions s
            ORDER BY s.id ASC
        """))
        s_rows = sessions_res.fetchall()
        
        report["section_l_qr_preflight"] = {
            "public_sessions": [
                {
                    "id": s[0],
                    "user_id": str(s[1]),
                    "gateway_id": str(s[2]),
                    "session_name": s[3],
                    "status": s[4],
                    "phone_number": s[5],
                    "is_active": s[6],
                    "is_phone_online": s[7],
                    "created_at": s[8].isoformat() if s[8] else None,
                    "updated_at": s[9].isoformat() if s[9] else None,
                    "history_state_count": s[10],
                    "conversation_count": s[11],
                }
                for s in s_rows
            ]
        }

    print(json.dumps(report, indent=2, default=str))

if __name__ == "__main__":
    asyncio.run(main())
