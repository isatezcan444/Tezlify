#!/usr/bin/env python3
"""
Phase 15.4 Forensic Analysis Suite (READ-ONLY)
Gathers real production evidence without any modifications:
- Section B: Live Forensic Snapshot
- Section C: Problem #1 — 20+ Real Problematic Identities
- Section H: Problem #2 — 30+ Chat Ordering Comparison
- Section K: Problem #3 — Avatar Pipeline Latency & Pacing
- Section O: Problem #4 — Sync Timeline & Flapping Oscillation
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


async def run_full_forensics():
    print("=" * 100)
    print("=== PHASE 15.4 PRODUCTION FORENSIC REPORT (READ-ONLY) ===")
    print(f"=== Generated at: {datetime.now(timezone.utc).isoformat()} ===")
    print("=" * 100)

    async with AsyncSessionLocal() as db:
        # =====================================================================
        # PART 1: SECTION B - LIVE FORENSIC SNAPSHOT
        # =====================================================================
        print("\n" + "-" * 80)
        print("PART 1: SECTION B - LIVE FORENSIC SNAPSHOT")
        print("-" * 80)

        # 1.1 whatsapp_sessions
        sess_rows = (await db.execute(text("""
            SELECT id, user_id, gateway_id, session_name, status, phone_number, is_active, created_at, updated_at
            FROM public.whatsapp_sessions
            ORDER BY id
        """))).fetchall()
        print("\n[1.1 public.whatsapp_sessions]")
        for s in sess_rows:
            d = dict(s._mapping)
            print(f"  ID: {d['id']:<4} | Status: {d['status']:<16} | GatewayID: {d['gateway_id']} | Phone: {str(d['phone_number']):<15} | Active: {d['is_active']} | Updated: {d['updated_at']}")

        # 1.2 gateway_sessions
        gw_rows = (await db.execute(text("""
            SELECT session_id, session_name, is_active, created_at, updated_at
            FROM whatsapp_private.gateway_sessions
            ORDER BY created_at DESC LIMIT 5
        """))).fetchall()
        print("\n[1.2 whatsapp_private.gateway_sessions (Recent 5)]")
        for g in gw_rows:
            d = dict(g._mapping)
            print(f"  SessionID: {d['session_id']} | Name: {d['session_name']} | Active: {d['is_active']} | Updated: {d['updated_at']}")

        # 1.3 socket_leases & session_credentials
        cred_cnt = (await db.execute(text("SELECT COUNT(*) FROM whatsapp_private.session_credentials"))).scalar()
        lease_cnt = (await db.execute(text("SELECT COUNT(*) FROM whatsapp_private.socket_leases"))).scalar()
        print(f"\n[1.3 Credential & Lease Status]: session_credentials={cred_cnt}, active_socket_leases={lease_cnt}")

        # 1.4 history_sync_states breakdown
        hss_rows = (await db.execute(text("""
            SELECT session_id, state, provider_checked, provider_signal, COUNT(*) as cnt
            FROM whatsapp_private.history_sync_states
            GROUP BY session_id, state, provider_checked, provider_signal
            ORDER BY session_id, cnt DESC
        """))).fetchall()
        print("\n[1.4 history_sync_states Breakdown]")
        for h in hss_rows:
            d = dict(h._mapping)
            print(f"  Session: {d['session_id']} | State: {d['state']:<18} | ProvChecked: {str(d['provider_checked']):<5} | Signal: {str(d['provider_signal']):<15} | Count: {d['cnt']}")

        # 1.5 event_outbox summary
        outbox_summary = (await db.execute(text("""
            SELECT state, COUNT(*) as cnt
            FROM whatsapp_private.event_outbox
            GROUP BY state
        """))).fetchall()
        print("\n[1.5 event_outbox by State]")
        for o in outbox_summary:
            d = dict(o._mapping)
            print(f"  State: {d['state']:<15} | Count: {d['cnt']}")

        # 1.6 Event Distribution in Recent Window (last 2 hours)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
        recent_events = (await db.execute(text("""
            SELECT event_type, COUNT(*) as cnt, MIN(created_at) as first_at, MAX(created_at) as last_at
            FROM whatsapp_private.event_outbox
            WHERE created_at >= :cutoff
            GROUP BY event_type
            ORDER BY cnt DESC
        """), {"cutoff": cutoff})).fetchall()
        print(f"\n[1.6 event_outbox Event Distribution (Last 2 Hours - since {cutoff.strftime('%H:%M:%S UTC')}):]")
        for re in recent_events:
            d = dict(re._mapping)
            print(f"  EventType: {d['event_type']:<26} | Count: {d['cnt']:<5} | First: {d['first_at'].strftime('%H:%M:%S')} | Last: {d['last_at'].strftime('%H:%M:%S')}")

        # =====================================================================
        # PART 2: SECTION C & D - PROBLEM #1 KİŞİ KİMLİĞİ ÇÖZÜMLEME
        # =====================================================================
        print("\n" + "-" * 80)
        print("PART 2: SECTION C & D - PROBLEM #1 KİŞİ KİMLİĞİ ÇÖZÜMLEME (20+ SAMPLES)")
        print("-" * 80)

        # Investigate LID mappings & Contacts
        lid_mappings = (await db.execute(text("""
            SELECT lid_jid, phone_jid, created_at
            FROM whatsapp_private.lid_mappings
            ORDER BY created_at DESC
            LIMIT 25
        """))).fetchall()
        print(f"\n[Total LID Mappings in DB]: {(await db.execute(text('SELECT COUNT(*) FROM whatsapp_private.lid_mappings'))).scalar()}")
        print("Sample 10 LID Mappings:")
        for lm in lid_mappings[:10]:
            d = dict(lm._mapping)
            print(f"  LID: {d['lid_jid']:<25} -> PhoneJID: {d['phone_jid']:<30} (Created: {d['created_at']})")

        # Find contacts with NULL or raw JID display_name, or LID in phone_e164
        problem_contacts = (await db.execute(text("""
            SELECT 
                c.id as contact_id,
                c.phone_e164,
                c.display_name,
                c.custom_attributes,
                c.created_at,
                c.updated_at,
                lm.phone_jid as mapped_pn,
                lm.lid_jid as mapped_lid
            FROM public.contacts c
            LEFT JOIN whatsapp_private.lid_mappings lm ON (lm.lid_jid = c.phone_e164 OR lm.phone_jid = c.phone_e164 OR ('jid:' || lm.lid_jid) = c.phone_e164 OR ('jid:' || lm.phone_jid) = c.phone_e164)
            WHERE c.display_name IS NULL 
               OR c.display_name LIKE '%çözülüyor%'
               OR c.display_name LIKE 'jid:%'
               OR c.display_name LIKE '%@%'
               OR c.phone_e164 LIKE '%@lid%'
               OR c.phone_e164 IS NULL
               OR c.phone_e164 LIKE 'jid:%'
            ORDER BY c.updated_at DESC
            LIMIT 30
        """))).fetchall()

        print(f"\n[Problematic Contacts Sample (Count={len(problem_contacts)})]:")
        print(f"{'ContactID':<10} {'Phone/JID':<32} {'DisplayName':<25} {'MappedPN':<25} {'NameSource'}")
        print("-" * 115)
        for pc in problem_contacts:
            d = dict(pc._mapping)
            attrs = d['custom_attributes'] or {}
            if isinstance(attrs, str):
                try: attrs = json.loads(attrs)
                except: attrs = {}
            ns = attrs.get('name_source', 'None')
            print(f"{d['contact_id']:<10} {str(d['phone_e164'])[:30]:<32} {str(d['display_name'])[:23]:<25} {str(d['mapped_pn'])[:23]:<25} {ns}")

        # Check for duplicate contacts (same phone_e164 or same normalized phone)
        dup_phones = (await db.execute(text("""
            SELECT phone_e164, COUNT(*) as cnt, array_agg(id) as ids, array_agg(display_name) as names
            FROM public.contacts
            WHERE phone_e164 IS NOT NULL AND phone_e164 NOT LIKE 'jid:%g.us%'
            GROUP BY phone_e164
            HAVING COUNT(*) > 1
            LIMIT 10
        """))).fetchall()
        print(f"\n[Duplicate Contacts by phone_e164 (Top 10)]:")
        for dp in dup_phones:
            d = dict(dp._mapping)
            print(f"  Phone: {d['phone_e164']:<18} | Count: {d['cnt']} | IDs: {d['ids']} | Names: {d['names']}")

        # =====================================================================
        # PART 3: SECTION H & I - PROBLEM #2 CHAT SIRALAMA (30+ SAMPLES)
        # =====================================================================
        print("\n" + "-" * 80)
        print("PART 3: SECTION H & I - PROBLEM #2 CHAT SIRALAMA (30+ SAMPLES)")
        print("-" * 80)

        # Inspect conversations timestamps vs actual messages timestamps
        conv_ordering = (await db.execute(text("""
            SELECT 
                c.id as conversation_id,
                c.channel,
                c.status,
                c.last_message_preview,
                c.last_message_at,
                c.created_at,
                c.updated_at,
                c.is_group,
                c.unread_count,
                ct.id as contact_id,
                ct.display_name,
                ct.phone_e164,
                (SELECT COUNT(*) FROM public.messages m WHERE m.conversation_id = c.id) as msg_count,
                (SELECT MAX(m.external_timestamp) FROM public.messages m WHERE m.conversation_id = c.id) as max_msg_ts,
                (SELECT MAX(m.created_at) FROM public.messages m WHERE m.conversation_id = c.id) as max_msg_created
            FROM public.conversations c
            LEFT JOIN public.contacts ct ON ct.id = c.contact_id
            ORDER BY c.updated_at DESC
            LIMIT 35
        """))).fetchall()

        print(f"Total rows retrieved: {len(conv_ordering)}")
        if conv_ordering:
            print(f"{'ConvID':<7} {'Name':<22} {'Phone/JID':<20} {'last_msg_at':<20} {'c.updated_at':<20} {'max_msg_ts':<20} {'Msgs'}")
            print("-" * 125)
            for co in conv_ordering:
                d = dict(co._mapping)
                name = str(d['display_name'] or 'None')[:20]
                phone = str(d['phone_e164'] or 'None')[:18]
                lmat = str(d['last_message_at'])[:19] if d['last_message_at'] else 'NULL'
                upat = str(d['updated_at'])[:19] if d['updated_at'] else 'NULL'
                mmts = str(d['max_msg_ts'])[:19] if d['max_msg_ts'] else 'NULL'
                print(f"{d['conversation_id']:<7} {name:<22} {phone:<20} {lmat:<20} {upat:<20} {mmts:<20} {d['msg_count']}")

        # =====================================================================
        # PART 4: SECTION K & L - PROBLEM #3 AVATAR LATENCY & PACING
        # =====================================================================
        print("\n" + "-" * 80)
        print("PART 4: SECTION K & L - PROBLEM #3 AVATAR LATENCY & PACING")
        print("-" * 80)

        # Count contacts with and without avatar
        avatar_stats = (await db.execute(text("""
            SELECT 
                COUNT(*) as total_contacts,
                COUNT(*) FILTER (WHERE custom_attributes->>'avatar_url' IS NOT NULL AND custom_attributes->>'avatar_url' != '') as with_avatar,
                COUNT(*) FILTER (WHERE custom_attributes->>'avatar_url' IS NULL OR custom_attributes->>'avatar_url' = '') as without_avatar
            FROM public.contacts
        """))).fetchone()
        d_av = dict(avatar_stats._mapping)
        print(f"Avatar Coverage in DB: Total={d_av['total_contacts']}, WithAvatar={d_av['with_avatar']}, WithoutAvatar={d_av['without_avatar']}")

        # Examine avatar URLs in custom_attributes
        sample_avatars = (await db.execute(text("""
            SELECT id, display_name, phone_e164, custom_attributes->>'avatar_url' as avatar_url, updated_at
            FROM public.contacts
            WHERE custom_attributes->>'avatar_url' IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 15
        """))).fetchall()
        print("\nSample Avatar URLs in Contacts (Recent 15):")
        for sa in sample_avatars:
            d = dict(sa._mapping)
            url_preview = (d['avatar_url'] or '')[:60] + "..." if d['avatar_url'] else "None"
            print(f"  ID: {d['id']:<5} | Name: {str(d['display_name'])[:20]:<20} | Phone: {str(d['phone_e164'])[:15]:<15} | URL: {url_preview}")

        # =====================================================================
        # PART 5: SECTION N & O - PROBLEM #4 SYNC OSCILLATION & FLAPPING
        # =====================================================================
        print("\n" + "-" * 80)
        print("PART 5: SECTION N & O - PROBLEM #4 SYNC OSCILLATION & FLAPPING")
        print("-" * 80)

        # Check history_sync_states for timeouts, stalls, retries
        hss_perf = (await db.execute(text("""
            SELECT 
                session_id,
                COUNT(*) as total_rows,
                COUNT(*) FILTER (WHERE state = 'TEMPORARY_TIMEOUT') as timeouts,
                COUNT(*) FILTER (WHERE state = 'CURSOR_STALLED') as stalls,
                COUNT(*) FILTER (WHERE state = 'ERROR') as errors,
                COUNT(*) FILTER (WHERE state = 'HAS_MORE') as has_more,
                COUNT(*) FILTER (WHERE state = 'FULLY_EXHAUSTED') as exhausted,
                COUNT(*) FILTER (WHERE provider_checked = TRUE) as prov_checked,
                COALESCE(SUM(timeout_count), 0) as total_timeout_retries,
                COALESCE(SUM(stall_count), 0) as total_stall_events,
                COALESCE(SUM(error_count), 0) as total_error_events,
                COALESCE(MAX(last_sweep_count), 0) as max_sweeps_per_chat
            FROM whatsapp_private.history_sync_states
            GROUP BY session_id
        """))).fetchall()

        print("[History Sync Resilience Metrics by Session]:")
        for hp in hss_perf:
            d = dict(hp._mapping)
            print(f"  Session: {d['session_id']}")
            print(f"    Total Chats tracked: {d['total_rows']}")
            print(f"    Provider Checked:    {d['prov_checked']}")
            print(f"    Timeouts:            {d['timeouts']} (Total timeout count sum: {d['total_timeout_retries']})")
            print(f"    Stalls:              {d['stalls']} (Total stall count sum: {d['total_stall_events']})")
            print(f"    Errors:              {d['errors']} (Total error count sum: {d['total_error_events']})")
            print(f"    HAS_MORE:            {d['has_more']}")
            print(f"    FULLY_EXHAUSTED:     {d['exhausted']}")
            print(f"    Max sweeps/chat:     {d['max_sweeps_per_chat']}")

        # Examine event_outbox events chronological sequence between 21:00 and 21:10 UTC
        timeline_events = (await db.execute(text("""
            SELECT sequence, event_type, state, attempts, created_at, delivered_at
            FROM whatsapp_private.event_outbox
            WHERE created_at >= '2026-09-17 21:00:00+00' AND created_at <= '2026-09-17 21:08:45+00'
              AND event_type IN ('session_connected', 'session_sync_started', 'session_sync_completed', 'history_sync_completed', 'session_disconnected')
            ORDER BY sequence ASC
        """))).fetchall()

        print("\n[Chronological Sync Lifecycle Events (21:00 - 21:08 UTC)]:")
        for te in timeline_events:
            d = dict(te._mapping)
            print(f"  Seq: {d['sequence']:<6} | Event: {d['event_type']:<26} | State: {d['state']:<10} | Created: {d['created_at'].strftime('%H:%M:%S.%f')[:-3]} | Delivered: {str(d['delivered_at'])[11:23] if d['delivered_at'] else 'None'}")

        print("\n" + "=" * 100)
        print("=== END OF PHASE 15.4 PRODUCTION FORENSIC REPORT ===")
        print("=" * 100)

if __name__ == "__main__":
    asyncio.run(run_full_forensics())
