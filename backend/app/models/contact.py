from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Index, Uuid, ForeignKey, JSON
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class Contact(Base):
    """
    Canonical Contact entity for conversational threads.
    Decoupled from B2B CRM Lead: a Contact may optionally link to a CRM Lead (lead_id is nullable).
    """
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Normalized E.164 phone number
    phone_e164 = Column(String(50), nullable=False, index=True)
    display_name = Column(String(150), nullable=True)

    # Optional connection to CRM Lead
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True, index=True)

    custom_attributes = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    lead = relationship("Lead", backref="contacts")
    conversations = relationship("Conversation", back_populates="contact")

    __table_args__ = (
        Index("idx_contact_user_phone", "user_id", "phone_e164"),
    )
