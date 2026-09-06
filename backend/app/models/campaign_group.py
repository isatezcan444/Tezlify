from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Table
from sqlalchemy.orm import relationship

from backend.app.core.database import Base

# Many-to-Many Association Table between CampaignGroup and Lead
campaign_group_leads = Table(
    "campaign_group_leads",
    Base.metadata,
    Column("group_id", Integer, ForeignKey("campaign_groups.id", ondelete="CASCADE"), primary_key=True),
    Column("lead_id", Integer, ForeignKey("leads.id", ondelete="CASCADE"), primary_key=True),
    Column("added_at", DateTime, default=datetime.utcnow, nullable=False),
)

class CampaignGroup(Base):
    __tablename__ = "campaign_groups"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(String(36), nullable=True, index=True)
    name = Column(String(200), nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Discovery / Target Context (e.g. Diş Klinikleri, Kadıköy)
    target_category = Column(String(100), nullable=True, index=True)
    target_location = Column(String(200), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    leads = relationship(
        "Lead",
        secondary=campaign_group_leads,
        backref="campaign_groups",
        lazy="selectin"
    )
