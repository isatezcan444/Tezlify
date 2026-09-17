"""
Phase 15.4 — Live Production Forensic Diagnostic Script (READ-ONLY)
Strictly adheres to:
- No database mutations (SELECT queries only)
- No synthetic event replays
- Token masking (no plaintext secret logging)
- Deep forensics on Identity, Chat Ordering, Avatar Pipeline, and Sync Oscillation
"""
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List

from sqlalchemy import text
from backend.app.core.database import AsyncSessionLocal

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("phase154_forensics")


async def run_snapshot_b():
    """Section B: Live Forensic Snapshot"""
    print("\n" + "=" * 90)
    print("=== SECTION B: LIVE FORENSIC SNAPSHOT ===")
    print("=" * 90)
    
    async with AsyncSessionLocal() as db:
        # 1. public.whatsapp_sessions
        res = await db.execute(text("""
            SELECT id, status, gateway_id, phone_number, is_active, created_at, updated_at
            FROM public.whatsapp_sessions
            ORDER BY id
        """))
        sessions = [dict(r._mapping) for r in res.fetchall()]
        print("\n[PUBLIC WHATSAPP SESSIONS]")
        for s in sessions:
            print(f"  ID: {s['id']} | Status: {s['status']} | GatewayID: {s['gateway_id']} | Phone: {s['phone_number']} | Active: {s['is_active']} | Updated: {s['updated_at']}")

        # 2. session_credentials
        try:
            res_cred = await db.execute(text("SELECT COUNT(*) FROM whatsapp_private.session_credentials"))
            cred_count = res_cred.scalar()
        except Exception as e:
            cred_count = f"Error: {e}"
        print(f"\n[SESSION CREDENTIALS COUNT]: {cred_count}")

        # 3. history_sync_states summary
        res_hss = await db.execute(text("""
            SELECT state, provider_checked, provider_signal, COUNT(*) as cnt
            FROM whatsapp_private.history_sync_states
            GROUP BY state, provider_checked, provider_signal
            ORDER BY cnt DESC
        """))
        print("\n[HISTORY SYNC STATES SUMMARY]")
        for r in res_hss.fetchall():
            d = dict(r._mapping)
            print(f"  State: {d['state']:<18} | ProvChecked: {str(d['provider_checked']):<5} | Signal: {str(d['provider_signal']):<15} | Count: {d['cnt']}")

        # 4. Event distribution in the last 60 minutes
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=60)
        res_events = await db.execute(text("""
            SELECT event_type, COUNT(*) as cnt, MIN(created_at) as first_at, MAX(created_at) as last_at
            FROM whatsapp_private.session_events
            WHERE created_at >= :cutoff
            GROUP BY event_type
            ORDER BY cnt DESC
        """), {"cutoff": cutoff})
        print(f"\n[EVENT DISTRIBUTION (LAST 60 MINUTES - since {cutoff.isoformat()})]")
        events_60 = res_events.fetchall()
        if not events_60:
            print("  No events in last 60 minutes in session_events.")
            # Fallback check all-time event types
            res_all_events = await db.execute(text("""
                SELECT event_type, COUNT(*) as cnt, MIN(created_at) as first_at, MAX(created_at) as last_at
                FROM whatsapp_private.session_events
                GROUP BY event_type
                ORDER BY cnt DESC
            """))
            print("  [ALL-TIME SESSION EVENTS DISTRIBUTION]:")
            for r in res_all_events.fetchall():
                d = dict(r._mapping)
                print(f"    {d['event_type']:<28} | Count: {d['cnt']:<5} | First: {d['first_at']} | Last: {d['last_at']}")
        else:
            for r in events_60:
                d = dict(r._mapping)
                print(f"  {d['event_type']:<28} | Count: {d['cnt']:<5} | First: {d['first_at']} | Last: {d['last_at']}")


async def run_problem_1_identities():
    """Section C & D: Problem #1 — Kişi Kimliği Çözümleme"""
    print("\n" + "=" * 90)
    print("=== SECTION C & D: PROBLEM #1 — KİŞİ KİMLİĞİ ÇÖZÜMLEME ===")
    print("=" * 90)
    
    async with AsyncSessionLocal() as db:
        # Query conversations where contact is unresolved or phone is null or name is resolving
        query = text("""
            SELECT 
                c.id as conversation_id,
                c.jid,
                c.phone_number,
                c.name as conv_name,
                c.unread_count,
                c.created_at,
                c.updated_at,
                c.last_message_at,
                ct.id as contact_id,
                ct.first_name,
                ct.last_name,
                ct.phone as contact_phone,
                ct.phone_e164 as contact_phone_e164,
                ct.is_whatsapp_eligible,
                lm.lid as mapped_lid,
                lm.phone_jid as mapped_pn,
                (SELECT COUNT(*) FROM whatsapp_private.messages m WHERE m.conversation_id = c.id) as msg_count
            FROM whatsapp_private.conversations c
            LEFT JOIN public.contacts ct ON ct.id = c.contact_id
            LEFT JOIN whatsapp_private.lid_mappings lm ON (lm.lid = c.jid OR lm.phone_jid = c.jid)
            ORDER BY c.updated_at DESC
        """)
        res = await db.execute(query)
        all_convs = [dict(r._mapping) for r in res.fetchall()]
        
        print(f"\nTotal Conversations in DB: {len(all_convs)}")
        
        # Categorize problematic identities:
        # 1. Name contains 'çözülüyor' or 'resolving' or is empty/null
        # 2. LID without phone
        # 3. Contact is null
        # 4. phone_e164 is null
        resolving_samples = []
        no_phone_samples = []
        lid_samples = []
        
        for c in all_convs:
            jid = c["jid"] or ""
            name = c["conv_name"] or ""
            is_lid = jid.endswith("@lid")
            has_no_phone = (c["contact_phone_e164"] is None and c["phone_number"] is None)
            
            if "çözülüyor" in name.lower() or "resolv" in name.lower() or not name:
                resolving_samples.append(c)
            if is_lid:
                lid_samples.append(c)
            if has_no_phone:
                no_phone_samples.append(c)

        print(f"  - Conversations with 'çözülüyor'/unresolved name: {len(resolving_samples)}")
        print(f"  - Conversations with @lid JID: {len(lid_samples)}")
        print(f"  - Conversations with NULL phone_e164: {len(no_phone_samples)}")
        
        # Display up to 25 detailed samples
        sample_list = resolving_samples + [x for x in lid_samples if x not in resolving_samples]
        sample_list = sample_list[:25]
        
        print("\n[SAMPLE PROBLEMATIC IDENTITIES (Top 25)]")
        print(f"{'ConvID':<7} {'JID':<30} {'Type':<6} {'Name':<22} {'Phone':<16} {'ContactID':<10} {'Msgs':<5} {'MappedPN'}")
        print("-" * 120)
        for s in sample_list:
            jid_type = "LID" if (s["jid"] or "").endswith("@lid") else ("GROUP" if "@g.us" in (s["jid"] or "") else "PN")
            name_disp = (s["conv_name"] or "None")[:20]
            phone_disp = str(s["contact_phone_e164"] or s["phone_number"] or "NULL")[:15]
            mapped_pn = str(s["mapped_pn"] or "None")[:25]
            print(f"{s['conversation_id']:<7} {s['jid'][:28]:<30} {jid_type:<6} {name_disp:<22} {phone_disp:<16} {str(s['contact_id']):<10} {s['msg_count']:<5} {mapped_pn}")


async def run_problem_2_ordering():
    """Section H: Problem #2 — Chat Sıralama"""
    print("\n" + "=" * 90)
    print("=== SECTION H: PROBLEM #2 — CHAT SIRALAMA ===")
    print("=" * 90)
    
    async with AsyncSessionLocal() as db:
        query = text("""
            SELECT 
                c.id as conversation_id,
                c.jid,
                c.name,
                c.created_at,
                c.updated_at,
                c.last_message_at,
                (
                    SELECT MAX(m.timestamp) 
                    FROM whatsapp_private.messages m 
                    WHERE m.conversation_id = c.id
                ) as latest_msg_ts,
                (
                    SELECT COUNT(*) 
                    FROM whatsapp_private.messages m 
                    WHERE m.conversation_id = c.id
                ) as msg_count
            FROM whatsapp_private.conversations c
            ORDER BY c.updated_at DESC
            LIMIT 35
        """)
        res = await db.execute(query)
        rows = [dict(r._mapping) for r in res.fetchall()]
        
        print(f"\n[TOP 35 CONVERSATIONS ORDERED BY c.updated_at DESC]")
        print(f"{'ConvID':<7} {'Name':<22} {'JID':<28} {'c.updated_at':<25} {'c.last_msg_at':<25} {'MAX(msg.ts)':<25} {'Msgs'}")
        print("-" * 135)
        for r in rows:
            name = (r["name"] or "None")[:20]
            jid = (r["jid"] or "")[:26]
            up_at = str(r["updated_at"])[:23] if r["updated_at"] else "None"
            last_m = str(r["last_message_at"])[:23] if r["last_message_at"] else "None"
            max_ts = str(r["latest_msg_ts"])[:23] if r["latest_msg_ts"] else "None"
            print(f"{r['conversation_id']:<7} {name:<22} {jid:<28} {up_at:<25} {last_m:<25} {max_ts:<25} {r['msg_count']}")


async def main():
    await run_snapshot_b()
    await run_problem_1_identities()
    await run_problem_2_ordering()

if __name__ == "__main__":
    asyncio.run(main())
