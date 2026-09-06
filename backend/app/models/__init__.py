from backend.app.core.database import Base
from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus, ConfidenceLevel
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.blacklist import Blacklist, ScraperJob, ScraperJobStatus
from backend.app.models.raw_candidate import RawCandidate
from backend.app.models.discovery_run import DiscoveryRun, DiscoveryRunStatus

from backend.app.models.system_settings import SystemSetting
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.profile import Profile

__all__ = [
    "Base",
    "Lead",
    "LeadStatus",
    "EntityType",
    "VerificationStatus",
    "ConfidenceLevel",
    "WhatsAppSession",
    "SessionStatus",
    "Campaign",
    "CampaignStatus",
    "MessageLog",
    "MessageStatus",
    "Blacklist",
    "ScraperJob",
    "ScraperJobStatus",
    "RawCandidate",
    "DiscoveryRun",
    "DiscoveryRunStatus",
    "SystemSetting",
    "Conversation",
    "ConversationStatus",
    "Message",
    "MessageDirection",
    "MessageType",
    "ConversationMessageStatus",
    "Profile",
]
