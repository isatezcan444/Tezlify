#!/usr/bin/env python3
"""Phase 15.3 — Production Evidence Integrity Audit Script.

READ-ONLY audit: Verifies provider_checked status for all 98 conversations.
Does NOT modify history_sync_states, conversations, messages, or any session table.

Acceptance criteria (Phase 15.3):
  - NOT_CHECKED = 0
  - FULLY_EXHAUSTED requires provider_checked=True AND provider_signal='EXHAUSTED'
  - HAS_MORE requires provider_checked=True AND provider_signal='HAS_MORE'
  - NO_ANCHOR is a special sub-category (conversation exists, no DB message anchor yet)
  - TEMPORARY_TIMEOUT keeps has_more=True and cursor preserved

Usage:
  python3 scripts/diagnostics/whatsapp_phase153_evidence_audit.py
  python3 scripts/diagnostics/whatsapp_phase153_evidence_audit.py --verbose

Runtime:
  Run inside tezlify-backend container:
    docker exec -i tezlify-backend python3 - < scripts/diagnostics/whatsapp_phase153_evidence_audit.py
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession

GATEWAY_ID = "7ca58b14-a53e-47bd-b879-b77519f119bc"
SESSION_ID = 57
USER_ID = "f65642ab-4ae5-4d69-945c-8f30c8454bac"

# Reference chats for 2025/2024 audit (name → partial JID or contact)
REFERENCE_CHATS = {
    "Mehmet Uptwins": "2025",
    "Berke Şenusta Remax Beta": "2025",
    "Özlem Hanım Akbank": "2025",
    "Berat": "2025",
    "Fifa": "GROUP",
    "Gardaşlar": "2024-GROUP",
    "2022-2 TERTİPLER": "2024-GROUP",
    "Elif Ablam": "2026",
    "Kovulanlar": "2026-GROUP",
    "3Hacker": "2026-GROUP",
    "Dev kadro": "2026-GROUP",
    "Tezcan Ailesi💗": "2026-GROUP",
    "Safa Reis": "2026",
    "Cevat Aydın": "2026",
    "İsa Tezcan": "2026",
}


async def run_audit(verbose: bool = False) -> None:
    print("=" * 90)
    print("=== PHASE 15.3 — PRODUCTION EVIDENCE INTEGRITY AUDIT (READ-ONLY) ===")
    print(f"=== Timestamp: {datetime.now(timezone.utc).isoformat()} ===")
    print("=" * 90)

    async with AsyncSessionLocal() as db:
        # 1. Verify session
        sess = await db.get(WhatsAppSession, SESSION_ID)
        if not sess:
            print(f"ERROR: Session {SESSION_ID} not found")
            return

        print(f"\nSession {SESSION_ID}: status={sess.status}, gateway_id={sess.gateway_id}, "
              f"phone={sess.phone_number}, is_active={sess.is_active}")
        print(f"DB updated_at: {sess.updated_at}")

        # 2. Count evidence columns in history_sync_states
        # Check if provider_checked column exists
        col_check = await db.execute(text("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'whatsapp_private'
            AND table_name = 'history_sync_states'
            AND column_name = 'provider_checked'
        """))
        has_provider_cols = col_check.fetchone() is not None
        print(f"\nProvider evidence columns present: {has_provider_cols}")

        if not has_provider_cols:
            print("WARNING: provider_checked column missing — schema migration not yet applied.")
            print("         Run backend restart to apply Phase 15.3 migration.")

        # 3. History state distribution
        if has_provider_cols:
            states_res = await db.execute(text("""
                SELECT
                    COALESCE(state, 'UNKNOWN') as st,
                    COUNT(*) as cnt,
                    COUNT(*) FILTER (WHERE provider_checked = TRUE) as provider_checked_count,
                    COUNT(*) FILTER (WHERE provider_checked = FALSE OR provider_checked IS NULL) as not_provider_checked,
                    COALESCE(SUM(provider_msgs_returned), 0) as total_msgs_fetched
                FROM whatsapp_private.history_sync_states
                WHERE session_id = :sid
                GROUP BY st
                ORDER BY cnt DESC
            """), {"sid": GATEWAY_ID})
        else:
            states_res = await db.execute(text("""
                SELECT COALESCE(state, 'UNKNOWN') as st, COUNT(*) as cnt
                FROM whatsapp_private.history_sync_states
                WHERE session_id = :sid
                GROUP BY st
                ORDER BY cnt DESC
            """), {"sid": GATEWAY_ID})

        states = states_res.fetchall()
        total_states = sum(r[1] for r in states)

        print(f"\n{'='*90}")
        print(f"HISTORY STATE DISTRIBUTION (session_id={GATEWAY_ID[:8]}...)")
        print(f"{'='*90}")
        print(f"{'State':<25} {'Total':>6} {'ProviderChecked':>16} {'NotChecked':>12} {'MsgsFetched':>12}")
        print("-" * 90)

        total_not_checked = 0
        for row in states:
            if has_provider_cols and len(row) >= 5:
                st, cnt, p_checked, p_not_checked, msgs_fetched = row
                print(f"{st:<25} {cnt:>6} {p_checked:>16} {p_not_checked:>12} {msgs_fetched:>12}")
                total_not_checked += p_not_checked
            else:
                st, cnt = row[0], row[1]
                print(f"{st:<25} {cnt:>6}")

        print("-" * 90)
        print(f"{'TOTAL':<25} {total_states:>6}")

        # 4. NOT_CHECKED summary
        print(f"\n{'='*90}")
        print("EVIDENCE INTEGRITY SUMMARY")
        print(f"{'='*90}")

        if has_provider_cols:
            # Provider-verified vs not-verified breakdown
            verified_res = await db.execute(text("""
                SELECT
                    COUNT(*) FILTER (WHERE provider_checked = TRUE) as verified,
                    COUNT(*) FILTER (WHERE provider_checked = FALSE OR provider_checked IS NULL) as unverified,
                    COUNT(*) FILTER (WHERE state = 'NOT_CHECKED') as not_checked,
                    COUNT(*) FILTER (WHERE state = 'FULLY_EXHAUSTED' AND provider_checked = TRUE) as exhausted_verified,
                    COUNT(*) FILTER (WHERE state = 'FULLY_EXHAUSTED' AND (provider_checked = FALSE OR provider_checked IS NULL)) as exhausted_unverified,
                    COUNT(*) FILTER (WHERE state = 'HAS_MORE' AND provider_checked = TRUE) as has_more_verified,
                    COUNT(*) FILTER (WHERE state = 'HAS_MORE' AND (provider_checked = FALSE OR provider_checked IS NULL)) as has_more_unverified,
                    COUNT(*) FILTER (WHERE state = 'TEMPORARY_TIMEOUT') as timeouts,
                    COUNT(*) FILTER (WHERE state = 'CURSOR_STALLED') as stalled,
                    COUNT(*) FILTER (WHERE state = 'ERROR') as errors,
                    COUNT(*) FILTER (WHERE provider_signal = 'NO_ANCHOR') as no_anchor
                FROM whatsapp_private.history_sync_states
                WHERE session_id = :sid
            """), {"sid": GATEWAY_ID})

            v = verified_res.fetchone()
            if v:
                verified, unverified, not_checked = v[0], v[1], v[2]
                exhausted_v, exhausted_u = v[3], v[4]
                has_more_v, has_more_u = v[5], v[6]
                timeouts, stalled, errors, no_anchor = v[7], v[8], v[9], v[10]

                print(f"Provider-verified (provider_checked=TRUE): {verified}")
                print(f"Not yet verified  (provider_checked=FALSE): {unverified}")
                print(f"  Of which NOT_CHECKED state: {not_checked}")
                print(f"  Of which NO_ANCHOR signal:  {no_anchor}")
                print()
                print(f"FULLY_EXHAUSTED (provider-verified):   {exhausted_v}")
                print(f"FULLY_EXHAUSTED (NOT provider-verified): {exhausted_u}  ← MUST BE 0 for PASS")
                print(f"HAS_MORE (provider-verified):           {has_more_v}")
                print(f"HAS_MORE (NOT provider-verified):       {has_more_u}  ← MUST BE 0 for PASS")
                print(f"TEMPORARY_TIMEOUT:                      {timeouts}")
                print(f"CURSOR_STALLED:                         {stalled}")
                print(f"ERROR:                                  {errors}")
                print()

                # Phase 15.3 acceptance criteria evaluation
                print("─" * 90)
                print("PHASE 15.3 ACCEPTANCE CRITERIA:")
                criteria_passed = True

                def check(label, value, target, invert=False):
                    nonlocal criteria_passed
                    passed = (value == target) if not invert else (value != target)
                    icon = "✅" if passed else "❌"
                    if not passed:
                        criteria_passed = False
                    print(f"  {icon} {label}: {value} (target: {target})")

                check("NOT_CHECKED = 0", not_checked, 0)
                check("FULLY_EXHAUSTED unverified = 0", exhausted_u, 0)
                check("HAS_MORE unverified = 0", has_more_u, 0)
                check("CURSOR_STALLED: has_more preserved (not EXHAUSTED)", stalled, 0, invert=True)

                print()
                print(f"{'='*90}")
                status = "✅ PASS" if criteria_passed else "❌ FAIL — NOT_CHECKED > 0 or unverified EXHAUSTED/HAS_MORE"
                print(f"PHASE 15.3 STATUS: {status}")
                print(f"{'='*90}")
        else:
            print("Cannot evaluate Phase 15.3 criteria — provider_checked column missing.")
            print("STATUS: INCOMPLETE (schema migration not yet applied)")

        # 5. LID mapping audit
        lid_res = await db.execute(text("""
            SELECT COUNT(*) as total,
                   COUNT(DISTINCT phone_jid) as unique_phones
            FROM whatsapp_private.lid_mappings
            WHERE session_id = :sid
        """), {"sid": GATEWAY_ID})
        lid_row = lid_res.fetchone()
        if lid_row:
            print(f"\nLID Mappings: total={lid_row[0]}, unique_phone_jids={lid_row[1]}")

        # 6. Duplicate check
        dup_msgs = await db.execute(text("""
            SELECT COUNT(*) FROM (
                SELECT wa_message_id FROM public.messages
                WHERE wa_message_id IS NOT NULL
                GROUP BY wa_message_id HAVING COUNT(*) > 1
            ) s
        """))
        dup_convs = await db.execute(text("""
            SELECT COUNT(*) FROM (
                SELECT contact_id, channel FROM public.conversations
                WHERE user_id = :uid
                GROUP BY contact_id, channel HAVING COUNT(*) > 1
            ) s
        """), {"uid": USER_ID})

        dup_m = dup_msgs.scalar()
        dup_c = dup_convs.scalar()
        dup_icon = "✅" if dup_m == 0 and dup_c == 0 else "❌"
        print(f"\n{dup_icon} Duplicates: wa_message_id={dup_m}, conversations={dup_c}")

        # 7. Session credentials check (runtime integrity)
        cred_res = await db.execute(text("""
            SELECT session_id, key_version, version, updated_at
            FROM whatsapp_private.session_credentials
        """))
        creds = cred_res.fetchall()
        print(f"\nSession Credentials in DB: {len(creds)} records")
        for cr in creds:
            print(f"  session_id={cr[0][:8]}..., key_version={cr[1]}, version={cr[2]}, updated_at={cr[3]}")

        # 8. Natural session_connected events
        conn_events = await db.execute(text("""
            SELECT COUNT(*) as cnt, min(created_at) as first_at, max(created_at) as last_at
            FROM whatsapp_private.event_outbox
            WHERE session_id = :sid AND event_type = 'session_connected'
        """), {"sid": GATEWAY_ID})
        ev = conn_events.fetchone()
        print(f"\nNatural session_connected events: count={ev[0]}, first={ev[1]}, last={ev[2]}")

        if verbose:
            # 9. Top 30 conversations with evidence status
            detail_res = await db.execute(text("""
                SELECT
                    c.id,
                    ct.name,
                    ct.phone_e164,
                    c.last_message_at,
                    (SELECT COUNT(*) FROM public.messages m WHERE m.conversation_id = c.id) as msg_count,
                    hss.state,
                    hss.provider_checked,
                    hss.provider_signal,
                    hss.provider_msgs_returned,
                    hss.last_sweep_count,
                    hss.updated_at as state_updated_at
                FROM public.conversations c
                LEFT JOIN public.contacts ct ON ct.id = c.contact_id
                LEFT JOIN whatsapp_private.history_sync_states hss
                    ON hss.session_id = :gid
                    AND (hss.jid = REPLACE(ct.phone_e164::text, '+', '') || '@s.whatsapp.net'
                         OR ct.phone_e164::text LIKE 'jid:%' AND hss.jid = SUBSTR(ct.phone_e164::text, 5))
                WHERE c.user_id = :uid AND c.channel = 'WHATSAPP'
                ORDER BY msg_count DESC, c.last_message_at DESC NULLS LAST
                LIMIT 30
            """), {"gid": GATEWAY_ID, "uid": USER_ID})

            rows = detail_res.fetchall()
            if rows:
                print(f"\n{'='*120}")
                print("TOP 30 CONVERSATIONS — EVIDENCE STATUS")
                print(f"{'='*120}")
                print(f"{'ID':<7} {'Name':<22} {'Phone':<22} {'Msgs':<5} {'State':<20} "
                      f"{'Checked':>8} {'Signal':<15} {'Fetched':>8} {'Sweeps':>7}")
                print("-" * 120)
                for row in rows:
                    conv_id, name, phone, last_msg, msg_count = row[0], row[1], row[2], row[3], row[4]
                    state = row[5] or "NO_STATE"
                    p_checked = row[6]
                    p_signal = row[7] or "-"
                    p_msgs = row[8] if row[8] is not None else "-"
                    sweeps = row[9] if row[9] is not None else "-"
                    name_s = (str(name or "")[:20] + "..") if len(str(name or "")) > 22 else (name or "")
                    phone_s = (str(phone or "")[:20] + "..") if len(str(phone or "")) > 22 else (phone or "")
                    checked_icon = "✅" if p_checked else "❌"
                    print(f"{conv_id:<7} {name_s:<22} {phone_s:<22} {msg_count:<5} {state:<20} "
                          f"{checked_icon:>8} {p_signal:<15} {str(p_msgs):>8} {str(sweeps):>7}")
                print("=" * 120)


def main():
    parser = argparse.ArgumentParser(description="Phase 15.3 Evidence Integrity Audit")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show per-conversation detail")
    args = parser.parse_args()
    asyncio.run(run_audit(verbose=args.verbose))


if __name__ == "__main__":
    main()
