"""Quarantine ledger for unresolved LID identities that used to be deleted.

WHY THIS TABLE EXISTS
---------------------
`purge_raw_jid_identity_data` (startup, since 2026-09-12 `9647b73`) treated
every `contacts.phone_e164 = 'jid:<x>@lid'` row with no `lid_mappings` bridge as
a *ghost* and hard-deleted the contact, its conversations and its messages.

That premise is false. WhatsApp's LID privacy mode can leave a real person with
a LID-only identity whose phone JID is **never** revealed; "no bridge row" then
means "we never learned the bridge", not "nobody is behind this". Measured
consequence in production on 2026-10-29 (Phase 3.8.6 cutover): 1 contact +
1 conversation + 9 messages deleted (`126|2077|1538` -> `125|2068|1537`). The
messages survived only in gateway RAM, where the persistence sweep *skips* them
because they have no conversation — a gateway recreate would have made the loss
permanent.

The asymmetry decides the design: a duplicate chat is an annoyance, a deleted
message is unrecoverable. So the startup step no longer deletes anything it is
unsure about; it records the row here and leaves the data where it is.

WHAT IS STORED
--------------
Internal ids (`contacts.id`, `conversations.id`), the raw `jid:...@lid`
sentinel needed to re-identify the row, a machine-readable reason, the number of
messages that were at stake, and the owning `user_id`. **No message bodies, no
phone numbers, no message text.** The sentinel is a LID identifier, not a phone
number, and it is already stored verbatim in `contacts.phone_e164`.

STATE MACHINE
-------------
``QUARANTINED``  held back from deletion, awaiting review (written by startup)
``RELEASED``     an operator decided the row is genuinely disposable
``RESOLVED``     a bridge was learned and the repair job merged it

Only startup writes ``QUARANTINED``. Nothing in this codebase moves a row out
of quarantine: release/delete is an explicit operator decision, because that is
exactly the decision the old code took automatically and got wrong.
"""

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    Uuid,
)

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class WhatsAppIdentityQuarantine(Base):
    """One unresolved identity held back from the startup purge."""

    __tablename__ = "whatsapp_identity_quarantine"

    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False, index=True)
    updated_at = Column(
        DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False
    )

    contact_id = Column(Integer, nullable=False)
    conversation_id = Column(Integer, nullable=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # The `jid:<id>@lid` sentinel from `contacts.phone_e164`. Kept because the
    # operator needs to match this row to the contact without a join that may
    # have changed shape by the time they look.
    phone_e164 = Column(String(64), nullable=False)

    # 'bridge_unknown_has_messages' | 'bridge_unknown_empty' | 'bridge_known_deferred'
    reason = Column(String(48), nullable=False, index=True)
    # 'QUARANTINED' | 'RELEASED' | 'RESOLVED'
    status = Column(String(16), nullable=False, default="QUARANTINED", index=True)

    # How many messages the old behaviour would have destroyed. This is the
    # number that makes the cost of a wrong decision visible.
    message_count = Column(Integer, nullable=False, default=0)

    # PII-free extras (counts, classification). Never a body or a phone number.
    detail = Column(Text, nullable=True)

    __table_args__ = (
        # One row per contact: a repeated startup must UPDATE, never append.
        # `contact_id` is an autoincrement surrogate, so it is never reused.
        Index(
            "uq_wa_identity_quarantine_contact",
            "contact_id",
            unique=True,
        ),
        Index("idx_wa_identity_quarantine_status", "status", "reason"),
    )
