from fastapi import APIRouter
from backend.app.api.v1.endpoints import (
    leads,
    scraper,
    campaigns,
    whatsapp,
    whatsapp_cloud_webhook,
    conversations,
    blacklist,
    analytics,
    settings,
    smart_outreach,
    campaign_groups,
    auth,
)

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["Auth"])
api_router.include_router(leads.router, prefix="/leads", tags=["Leads"])
api_router.include_router(scraper.router, prefix="/scraper", tags=["Scraper"])
api_router.include_router(campaigns.router, prefix="/campaigns", tags=["Campaigns"])
api_router.include_router(campaign_groups.router, prefix="/campaign-groups", tags=["Campaign Groups"])
api_router.include_router(whatsapp.router, prefix="/whatsapp", tags=["WhatsApp"])
api_router.include_router(whatsapp_cloud_webhook.router, prefix="/whatsapp/cloud-webhook", tags=["WhatsApp Cloud API"])
api_router.include_router(conversations.router, prefix="/conversations", tags=["Conversations"])
api_router.include_router(blacklist.router, prefix="/blacklist", tags=["Blacklist"])
api_router.include_router(analytics.router, prefix="/analytics", tags=["Analytics"])
api_router.include_router(settings.router, prefix="/settings", tags=["Settings"])
api_router.include_router(smart_outreach.router, prefix="/smart-outreach", tags=["Smart Outreach"])

