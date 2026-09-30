from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import relationship

from backend.app.core.database import Base


class MessageReaction(Base):
    """A WhatsApp reaction on a single message.

    Why a table rather than a JSON column on `messages`
    ---------------------------------------------------
    A reaction is not part of a message: it is a separate, replaceable statement
    *about* a message that arrives long after it, from any participant, and can be
    withdrawn. WhatsApp's own semantics are "at most ONE reaction per person per
    message", which is exactly a unique constraint — and that constraint is the
    only thing that makes a late/duplicate delivery idempotent instead of a second
    emoji. A JSON blob on the row cannot express it without read-modify-write
    races, and it turns every timeline query into a parse.

    `reactor_jid` uses the sentinel ``"ME"`` for this tenant's own line, matching
    the convention the message rows already use (`Message.sender_phone == "ME"`
    for outbound). A NULL would be wrong twice over: it cannot participate in a
    unique constraint (NULLs are distinct in SQL), and it would make "who
    reacted" unanswerable.
    """

    __tablename__ = "message_reactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    message_id = Column(
        Integer,
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Denormalised so the conversation list can find the newest reaction without
    # joining back through messages on every row it renders.
    conversation_id = Column(
        Integer,
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reactor_jid = Column(String(255), nullable=False)
    from_me = Column(Boolean, nullable=False, default=False)
    # Empty string means "withdrawn": keeping the row (instead of deleting it)
    # makes a later re-reaction an UPDATE, so the unique index never has to race.
    emoji = Column(String(32), nullable=False, default="")

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    message = relationship("Message")

    __table_args__ = (
        UniqueConstraint("message_id", "reactor_jid", name="uq_reaction_message_reactor"),
        Index("idx_reaction_conv_created", "conversation_id", "created_at"),
    )
