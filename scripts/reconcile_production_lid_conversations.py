"""Script to reconcile and archive existing ghost LID conversations in the database."""

import asyncio
from datetime import datetime
from sqlalchemy import select, text
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message


async def run_reconciliation():
    async with AsyncSessionLocal() as db:
        # 1. Fetch all active LID conversations
        query = (
            select(Conversation, Contact)
            .join(Contact, Conversation.contact_id == Contact.id)
            .where(
                Contact.phone_e164.like("jid:%@lid"),
                Conversation.status == ConversationStatus.ACTIVE,
            )
        )
        res = await db.execute(query)
        lid_rows = res.all()
        print(f"[RECONCILE] Found {len(lid_rows)} active LID conversations to process.")

        # 2. Fetch all active non-LID conversations for matching
        non_lid_query = (
            select(Conversation, Contact)
            .join(Contact, Conversation.contact_id == Contact.id)
            .where(
                ~Contact.phone_e164.like("jid:%@lid"),
                Conversation.status == ConversationStatus.ACTIVE,
            )
        )
        nl_res = await db.execute(non_lid_query)
        non_lid_rows = nl_res.all()

        reconciled_count = 0
        archived_count = 0

        for lid_conv, lid_cont in lid_rows:
            lid_avatar = (lid_cont.custom_attributes or {}).get("avatar_url")
            lid_preview = lid_conv.last_message_preview

            # Find best candidate non-LID conversation for the same user
            candidate = None

            # Strategy 1: Match by avatar URL (strongest WhatsApp proof)
            if lid_avatar:
                for nl_conv, nl_cont in non_lid_rows:
                    if nl_conv.user_id == lid_conv.user_id:
                        nl_avatar = (nl_cont.custom_attributes or {}).get("avatar_url")
                        if nl_avatar and nl_avatar == lid_avatar:
                            candidate = (nl_conv, nl_cont)
                            break

            # Strategy 2: Match by exact last message preview & user
            if not candidate and lid_preview and len(lid_preview) > 3:
                for nl_conv, nl_cont in non_lid_rows:
                    if nl_conv.user_id == lid_conv.user_id:
                        if nl_conv.last_message_preview == lid_preview:
                            candidate = (nl_conv, nl_cont)
                            break

            # Strategy 3: Match by message body in conversation
            if not candidate and lid_preview and len(lid_preview) > 5:
                # Check if this preview exists as a message body in any non-lid conversation
                m_match = await db.execute(
                    select(Conversation, Contact)
                    .join(Contact, Conversation.contact_id == Contact.id)
                    .join(Message, Message.conversation_id == Conversation.id)
                    .where(
                        Conversation.user_id == lid_conv.user_id,
                        ~Contact.phone_e164.like("jid:%@lid"),
                        Message.body == lid_preview,
                    )
                    .limit(1)
                )
                m_row = m_match.first()
                if m_row:
                    candidate = (m_row[0], m_row[1])

            # Repoint messages if candidate found
            if candidate:
                nl_conv, nl_cont = candidate
                # Check messages in lid_conv
                mres = await db.execute(
                    select(Message).where(Message.conversation_id == lid_conv.id)
                )
                lid_msgs = list(mres.scalars().all())

                canon_wa_ids = set(
                    (await db.execute(
                        select(Message.wa_message_id).where(
                            Message.conversation_id == nl_conv.id,
                            Message.wa_message_id.isnot(None),
                        )
                    )).scalars().all()
                )

                for msg in lid_msgs:
                    if msg.wa_message_id and msg.wa_message_id in canon_wa_ids:
                        await db.delete(msg)
                    else:
                        msg.conversation_id = nl_conv.id

                # If lid_conv had a newer timestamp or preview
                if lid_conv.last_message_at and (
                    nl_conv.last_message_at is None or lid_conv.last_message_at > nl_conv.last_message_at
                ):
                    nl_conv.last_message_at = lid_conv.last_message_at
                    if lid_conv.last_message_preview:
                        nl_conv.last_message_preview = lid_conv.last_message_preview

                # Copy avatar if candidate lacks it
                canon_attrs = nl_cont.custom_attributes or {}
                if lid_avatar and not canon_attrs.get("avatar_url"):
                    canon_attrs["avatar_url"] = lid_avatar
                    nl_cont.custom_attributes = dict(canon_attrs)

                reconciled_count += 1
                print(f"  Merged LID {lid_cont.phone_e164} into {nl_cont.display_name or nl_cont.phone_e164} (conv {nl_conv.id})")

            # Always archive the ghost LID conversation
            lid_conv.status = ConversationStatus.ARCHIVED
            lid_conv.is_archived = True
            lid_conv.unread_count = 0
            lid_conv.archived_at = datetime.utcnow()
            archived_count += 1

        await db.commit()

        # Final verification
        verify_query = text("""
            SELECT count(*)
            FROM conversations c
            JOIN contacts cont ON c.contact_id = cont.id
            WHERE cont.phone_e164 LIKE 'jid:%@lid' AND c.status = 'ACTIVE'
        """)
        remaining = (await db.execute(verify_query)).scalar()
        print(f"[RECONCILE] Completed! Reconciled: {reconciled_count}, Archived: {archived_count}, Remaining Active LID: {remaining}")


if __name__ == "__main__":
    asyncio.run(run_reconciliation())
