"""Production WhatsApp Chat & History Inventory Diagnostic.

Collects complete inventories across:
- Gateway (in-memory store, contacts, messages, chats)
- Backend services & Database (PostgreSQL conversations, contacts, messages)
- Frontend API view (GET /whatsapp/conversations)

Usage:
  PYTHONPATH=. python3 scripts/diagnostics/whatsapp_chat_inventory.py
"""
import asyncio
import json
import logging
import os
import sys
import urllib.parse
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx
from sqlalchemy import distinct, func, or_, select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.identity import (
    contact_phone_for_jid,
    is_broadcast_only_jid,
    is_degenerate_jid,
    jid_to_phone,
    phone_to_jid,
    strip_jid_prefix,
)

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://tezlify-gateway:8787")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:8000/api/v1")


async def fetch_gateway_data(gateway_id: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Session status
        sess_resp = await client.get(f"{GATEWAY_URL}/sessions/{gateway_id}")
        session_info = sess_resp.json() if sess_resp.status_code == 200 else {}

        # Conversations
        conv_resp = await client.get(f"{GATEWAY_URL}/sessions/{gateway_id}/conversations?limit=2000")
        conv_data = conv_resp.json() if conv_resp.status_code == 200 else {"items": [], "total": 0}

        # Contacts
        cont_resp = await client.get(f"{GATEWAY_URL}/sessions/{gateway_id}/contacts")
        cont_data = cont_resp.json() if cont_resp.status_code == 200 else {"contacts": []}

        # Bulk messages (up to 10,000)
        msg_resp = await client.get(f"{GATEWAY_URL}/sessions/{gateway_id}/messages/bulk?limit=10000")
        msg_data = msg_resp.json() if msg_resp.status_code == 200 else {"messages": [], "total": 0}

        return {
            "session": session_info,
            "conversations": conv_data.get("items", []),
            "contacts": cont_data.get("contacts", []),
            "messages": msg_data.get("messages", []),
            "messages_total": msg_data.get("total", 0),
        }


async def run_inventory() -> Dict[str, Any]:
    async with AsyncSessionLocal() as db:
        # Find active connected session or latest session
        stmt = (
            select(WhatsAppSession)
            .where(WhatsAppSession.status == SessionStatus.CONNECTED)
            .order_by(WhatsAppSession.id.desc())
        )
        res = await db.execute(stmt)
        active_sess = res.scalars().first()
        if not active_sess:
            # Fallback to any session
            res = await db.execute(select(WhatsAppSession).order_by(WhatsAppSession.id.desc()))
            active_sess = res.scalars().first()

        if not active_sess:
            print("ERROR: No WhatsAppSession found in DB.")
            return {}

        session_id = active_sess.id
        user_id = str(active_sess.user_id)
        gateway_id = str(active_sess.gateway_id)

        print(f"=== INVENTORY AUDIT TARGET ===")
        print(f"Session ID:         {session_id}")
        print(f"User ID:            {user_id}")
        print(f"Gateway ID:         {gateway_id}")
        print(f"Phone:              {active_sess.phone_number}")
        print(f"Status:             {active_sess.status.value}")
        print()

        # 1. Fetch Gateway Data
        gw = await fetch_gateway_data(gateway_id)
        gw_chats = gw["conversations"]
        gw_contacts = gw["contacts"]
        gw_messages = gw["messages"]

        gw_chat_jids = {c["jid"]: c for c in gw_chats if "jid" in c}
        gw_msg_chat_jids = set(m.get("conversation_id") for m in gw_messages if m.get("conversation_id"))

        # 2. Fetch DB Data
        conv_res = await db.execute(
            select(Conversation, Contact)
            .outerjoin(Contact, Conversation.contact_id == Contact.id)
            .where(Conversation.session_id == session_id)
        )
        db_rows = conv_res.all()
        db_convs = [c for c, _ct in db_rows]
        db_contacts_map = {c.id: ct for c, ct in db_rows if ct}

        # User all contacts
        all_ct_res = await db.execute(select(Contact).where(Contact.user_id == user_id))
        all_user_contacts = all_ct_res.scalars().all()

        # Session messages
        msg_res = await db.execute(
            select(
                Message.id,
                Message.conversation_id,
                Message.wa_message_id,
                Message.body,
                Message.created_at,
                Message.external_timestamp,
                Message.sender_phone,
                Message.recipient_phone,
            )
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(Conversation.session_id == session_id)
        )
        db_messages = msg_res.all()

        # Group messages by conversation_id
        db_msgs_by_conv: Dict[int, List[Any]] = {}
        for m in db_messages:
            db_msgs_by_conv.setdefault(m.conversation_id, []).append(m)

        # 3. Categorize Gateway Chats
        gw_pn_chats = [c for c in gw_chats if "@s.whatsapp.net" in c.get("jid", "")]
        gw_lid_chats = [c for c in gw_chats if "@lid" in c.get("jid", "")]
        gw_group_chats = [c for c in gw_chats if "@g.us" in c.get("jid", "")]
        gw_unknown_chats = [
            c for c in gw_chats
            if "@s.whatsapp.net" not in c.get("jid", "")
            and "@lid" not in c.get("jid", "")
            and "@g.us" not in c.get("jid", "")
        ]

        # In messages, are there chats that are NOT in gw_chats?
        gw_msg_only_jids = gw_msg_chat_jids - set(gw_chat_jids.keys())

        # 4. Categorize DB Conversations
        db_conv_by_phone: Dict[str, Conversation] = {}
        db_pn_convs = []
        db_lid_convs = []
        db_group_convs = []
        db_unknown_convs = []

        for conv, contact in db_rows:
            p = contact.phone_e164 if contact else None
            if not p:
                db_unknown_convs.append(conv)
            elif "@g.us" in p or conv.is_group:
                db_group_convs.append(conv)
                db_conv_by_phone[p] = conv
            elif "@lid" in p:
                db_lid_convs.append(conv)
                db_conv_by_phone[p] = conv
            elif p.startswith("+"):
                db_pn_convs.append(conv)
                db_conv_by_phone[p] = conv
            else:
                db_unknown_convs.append(conv)
                db_conv_by_phone[p] = conv

        # 5. Message Age Breakdown (DB)
        old_history_convs = []
        recent_only_convs = []
        no_messages_convs = []

        for conv in db_convs:
            msgs = db_msgs_by_conv.get(conv.id, [])
            if not msgs:
                no_messages_convs.append(conv)
                continue
            oldest_ts = min(
                (m.external_timestamp or m.created_at for m in msgs),
                default=None,
            )
            if oldest_ts and oldest_ts.year < 2026:
                old_history_convs.append((conv, oldest_ts))
            else:
                recent_only_convs.append(conv)

        # 6. Parity sets
        # Map gateway JID to canonical phone representation
        def jid_to_canonical(j: str) -> str:
            if not j:
                return ""
            if "@g.us" in j:
                return f"jid:{j}"
            if "@lid" in j:
                return f"jid:{j}"
            phone = jid_to_phone(j)
            return phone or f"jid:{j}"

        gw_canonical_keys = {jid_to_canonical(c["jid"]): c for c in gw_chats if "jid" in c}
        db_canonical_keys = set(db_conv_by_phone.keys())

        gateway_only_keys = set(gw_canonical_keys.keys()) - db_canonical_keys
        db_only_keys = db_canonical_keys - set(gw_canonical_keys.keys())

        # Print Live Audit Report
        print("=" * 60)
        print("         WHATSAPP CHAT DISCOVERY & HISTORY INVENTORY       ")
        print("=" * 60)
        print(f"TOTAL GATEWAY CHATS:             {len(gw_chats)}")
        print(f"  Gateway PN chats:              {len(gw_pn_chats)}")
        print(f"  Gateway LID chats:             {len(gw_lid_chats)}")
        print(f"  Gateway Group chats:           {len(gw_group_chats)}")
        print(f"  Gateway Unknown chats:         {len(gw_unknown_chats)}")
        print(f"  Chats with msgs but no chat:   {len(gw_msg_only_jids)} ({list(gw_msg_only_jids)[:5]})")
        print(f"GATEWAY TOTAL MESSAGES IN RAM:   {len(gw_messages)} (reported: {gw['messages_total']})")
        print(f"GATEWAY CONTACTS IN RAM:         {len(gw_contacts)}")
        print()
        print(f"TOTAL DB CONVERSATIONS:          {len(db_convs)}")
        print(f"  DB PN conversations:           {len(db_pn_convs)}")
        print(f"  DB LID conversations:          {len(db_lid_convs)}")
        print(f"  DB Group conversations:        {len(db_group_convs)}")
        print(f"  DB Unknown conversations:      {len(db_unknown_convs)}")
        print(f"TOTAL DB MESSAGES (Session {session_id}): {len(db_messages)}")
        print(f"TOTAL USER CONTACTS (DB):        {len(all_user_contacts)}")
        print()
        print(f"HISTORY DISTRIBUTION (DB):")
        print(f"  Chats with OLD (<2026) msgs:   {len(old_history_convs)}")
        print(f"  Chats with ONLY 2026 msgs:     {len(recent_only_convs)}")
        print(f"  Chats with NO messages in DB:  {len(no_messages_convs)}")
        print()
        print(f"DISCOVERY PARITY:")
        print(f"  Gateway-only chats:            {len(gateway_only_keys)}")
        print(f"  DB-only chats:                 {len(db_only_keys)}")
        print("=" * 60)

        # Missing categories inspection:
        print("\n--- SAMPLE MISSING CHAT CATEGORIES ---")
        # Category A: 2025 / older history examples
        print("\nA) OLD CHAT EXAMPLES (<2026 in DB):")
        for conv, ts in old_history_convs[:5]:
            contact = db_contacts_map.get(conv.id)
            name = contact.display_name if contact else "No name"
            phone = contact.phone_e164 if contact else "No phone"
            print(f"  [ID {conv.id}] {name} ({phone}) - Oldest msg: {ts}")

        # Category B: LID-only / LID mapped
        print("\nB) LID EXAMPLES in Gateway or DB:")
        lid_in_gw_msgs = [j for j in gw_msg_chat_jids if "@lid" in j]
        print(f"  LIDs in Gateway msgs: {len(lid_in_gw_msgs)} -> {lid_in_gw_msgs[:5]}")
        print(f"  LIDs in DB convs:     {len(db_lid_convs)}")

        # Category C: No-phone contacts
        print("\nC) NO-PHONE OR SENTINEL CONTACTS in DB:")
        no_phone_cts = [c for c in all_user_contacts if c.phone_e164.startswith("jid:")]
        print(f"  Total sentinel 'jid:' contacts: {len(no_phone_cts)}")
        for ct in no_phone_cts[:5]:
            print(f"  [Contact {ct.id}] {ct.display_name} -> {ct.phone_e164}")

        # Category D: Group chats
        print("\nD) GROUP CHATS:")
        print(f"  Gateway groups: {len(gw_group_chats)}, DB groups: {len(db_group_convs)}")
        for g in gw_group_chats[:5]:
            print(f"  GW Group: {g.get('name')} ({g.get('jid')})")

        # Category E: Archived chats
        archived_db = [c for c in db_convs if c.is_archived or c.status == ConversationStatus.ARCHIVED]
        archived_gw = [c for c in gw_chats if c.get("archived")]
        print(f"\nE) ARCHIVED CHATS: Gateway={len(archived_gw)}, DB={len(archived_db)}")

        # Category F: Gateway-only
        print(f"\nF) GATEWAY-ONLY CHATS: {len(gateway_only_keys)}")
        for k in list(gateway_only_keys)[:5]:
            c = gw_canonical_keys[k]
            print(f"  {k} -> {c.get('name')} (last_msg: {c.get('last_message_at')})")

        # Category G: DB-only
        print(f"\nG) DB-ONLY CHATS: {len(db_only_keys)}")
        for k in list(db_only_keys)[:5]:
            conv = db_conv_by_phone[k]
            contact = db_contacts_map.get(conv.id)
            print(f"  {k} -> {contact.display_name if contact else None} (conv_id: {conv.id})")

        # Category H: Chats with current messages but no old history
        print(f"\nH) CHATS WITH ONLY RECENT MESSAGES (Missing older history): {len(recent_only_convs)}")
        for conv in recent_only_convs[:5]:
            contact = db_contacts_map.get(conv.id)
            msgs = db_msgs_by_conv.get(conv.id, [])
            oldest = min((m.external_timestamp or m.created_at for m in msgs), default=None)
            print(f"  [Conv {conv.id}] {contact.display_name if contact else None} - msgs: {len(msgs)}, oldest: {oldest}")

        return {
            "session_id": session_id,
            "gw_chats_count": len(gw_chats),
            "db_convs_count": len(db_convs),
            "gw_messages_count": len(gw_messages),
            "db_messages_count": len(db_messages),
        }


if __name__ == "__main__":
    asyncio.run(run_inventory())
