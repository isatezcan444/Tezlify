#!/usr/bin/env python3
"""
Phase 15.4 Post-Deploy Reality Check Diagnostics.
READ-ONLY inspection of production database states.
"""
import asyncio
import json
from sqlalchemy import text
from backend.app.core.database import AsyncSessionLocal
from backend.app.services.whatsapp.identity import (
    is_raw_jid_name,
    safe_display_name,
    strip_jid_prefix,
    jid_to_phone,
)

async def main():
    report = {}
    async with AsyncSessionLocal() as db:
        # -------------------------------------------------------------
        # 1. SECTION D: IDENTITY POST-DEPLOY VALIDATION
        # -------------------------------------------------------------
        contacts_res = await db.execute(text("""
            SELECT id, display_name, phone_e164, custom_attributes
            FROM public.contacts
            ORDER BY id ASC
        """))
        contacts = contacts_res.fetchall()
        
        d_stats = {
            "total_contacts": len(contacts),
            "display_name_null": 0,
            "display_name_raw_jid": 0,
            "is_lid": 0,
            "phone_is_jid_sentinel": 0,
            "push_name_present": 0,
            "push_name_absent": 0,
            "resolved_via_push_name": 0,
            "fallback_contact_xxxx": 0,
        }
        
        sample_contacts = []
        for c in contacts:
            cid, name, phone, attrs = c[0], c[1], c[2], c[3]
            attrs_dict = attrs if isinstance(attrs, dict) else {}
            push_name = attrs_dict.get("push_name")
            
            is_lid = (phone and "@lid" in phone) or (name and "@lid" in name)
            is_sentinel = phone and phone.startswith("jid:")
            
            if not name:
                d_stats["display_name_null"] += 1
            elif is_raw_jid_name(name):
                d_stats["display_name_raw_jid"] += 1
                
            if is_lid:
                d_stats["is_lid"] += 1
            if is_sentinel:
                d_stats["phone_is_jid_sentinel"] += 1
                
            if push_name:
                d_stats["push_name_present"] += 1
            else:
                d_stats["push_name_absent"] += 1
                
            # Test how safe_display_name resolves this contact
            class DummyC:
                pass
            dc = DummyC()
            dc.display_name = name
            dc.custom_attributes = attrs_dict
            resolved_name = safe_display_name(dc)
            
            if resolved_name == push_name and push_name:
                d_stats["resolved_via_push_name"] += 1
            elif not resolved_name and is_lid:
                d_stats["fallback_contact_xxxx"] += 1
                
            if is_lid or (not name and is_sentinel):
                if len(sample_contacts) < 15:
                    sample_contacts.append({
                        "id": cid,
                        "raw_display_name": name,
                        "phone_e164": phone,
                        "push_name": push_name,
                        "resolved_name": resolved_name,
                        "is_lid": is_lid,
                    })

        report["section_d_identity"] = {
            "stats": d_stats,
            "samples": sample_contacts,
        }

        # -------------------------------------------------------------
        # 2. SECTION E: IDENTITY MERGE SAFETY
        # -------------------------------------------------------------
        dup_phones = await db.execute(text("""
            SELECT phone_e164, count(*) as cnt, array_agg(id) as ids
            FROM public.contacts
            GROUP BY phone_e164
            HAVING count(*) > 1
        """))
        dup_phone_rows = dup_phones.fetchall()
        
        dup_convs = await db.execute(text("""
            SELECT contact_id, count(*) as cnt, array_agg(id) as ids
            FROM public.conversations
            WHERE contact_id IS NOT NULL
            GROUP BY contact_id
            HAVING count(*) > 1
        """))
        dup_conv_rows = dup_convs.fetchall()

        report["section_e_merge_safety"] = {
            "duplicate_contact_phone_count": len(dup_phone_rows),
            "duplicate_contacts": [{"phone": r[0], "count": r[1], "ids": r[2]} for r in dup_phone_rows[:10]],
            "duplicate_conversation_count": len(dup_conv_rows),
            "duplicate_conversations": [{"contact_id": r[0], "count": r[1], "ids": r[2]} for r in dup_conv_rows[:10]],
        }

        # -------------------------------------------------------------
        # 3. SECTION F: ORDERING REALITY CHECK
        # -------------------------------------------------------------
        conv_order_res = await db.execute(text("""
            SELECT c.id, c.last_message_at, count(m.id) as msg_count, max(m.external_timestamp) as max_external_ts, max(m.created_at) as max_created_at
            FROM public.conversations c
            LEFT JOIN public.messages m ON m.conversation_id = c.id
            GROUP BY c.id, c.last_message_at
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT 50
        """))
        conv_rows = conv_order_res.fetchall()
        
        ordering_samples = []
        ordering_mismatches = 0
        for r in conv_rows:
            cid, lm_at, cnt, max_ext, max_created = r[0], r[1], r[2], r[3], r[4]
            max_msg_ts = max_ext or max_created
            mismatch = False
            if cnt > 0 and lm_at and max_msg_ts:
                # check divergence > 2 seconds
                diff = abs((lm_at - max_msg_ts).total_seconds())
                if diff > 5.0:
                    mismatch = True
                    ordering_mismatches += 1
            ordering_samples.append({
                "conversation_id": cid,
                "last_message_at": lm_at.isoformat() if lm_at else None,
                "message_count": cnt,
                "max_message_ts": max_msg_ts.isoformat() if max_msg_ts else None,
                "mismatch": mismatch,
            })

        report["section_f_ordering"] = {
            "total_conversations_checked": len(conv_rows),
            "ordering_mismatches": ordering_mismatches,
            "samples": ordering_samples[:15],
        }

        # -------------------------------------------------------------
        # 4. SECTION K: PHASE 15.3 INVARIANT CHECK
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
            "by_state": {},
            "groups": [],
        }
        
        for r in sync_rows:
            sid, state, checked, signal, cnt = r[0], r[1], bool(r[2]), r[3], r[4]
            k_summary["total_rows"] += cnt
            if checked:
                k_summary["provider_checked_true"] += cnt
            else:
                k_summary["provider_checked_false"] += cnt
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
        # 5. SECTION L: QR PRE-FLIGHT
        # -------------------------------------------------------------
        sessions_res = await db.execute(text("""
            SELECT id, user_id, gateway_id, session_name, status, phone_number, is_active, is_phone_online, created_at, updated_at
            FROM public.whatsapp_sessions
            ORDER BY id ASC
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
                    "updated_at": s[9].isoformat() if s[9] else None,
                }
                for s in s_rows
            ]
        }

    print(json.dumps(report, indent=2, default=str))

if __name__ == "__main__":
    asyncio.run(main())
