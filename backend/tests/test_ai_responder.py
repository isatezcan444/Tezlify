import uuid
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.main import app
from backend.app.core.database import Base, get_db
from backend.app.core.auth import get_current_user, AuthUser
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.quick_reply import QuickReply
from backend.app.services.ai_responder_service import AiResponderService


TEST_USER_ID = str(uuid.uuid4())


@pytest.fixture
def mock_user():
    return AuthUser(
        id=TEST_USER_ID,
        email="ai_test@tezlify.com",
        name="AI Tester",
        is_active=True,
    )


async def get_test_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await Base.metadata.create_all(conn)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with async_session() as session:
        yield session
    await engine.dispose()


def test_ai_intent_classification():
    # Price
    intent, _ = AiResponderService.classify_intent("Hizmetlerinizin fiyatı nedir?")
    assert intent == "PRICE_INQUIRY"

    # Meeting
    intent, _ = AiResponderService.classify_intent("Yarın müsait misiniz, bir randevu ayarlayalım")
    assert intent == "MEETING_REQUEST"

    # Catalog
    intent, _ = AiResponderService.classify_intent("Bana güncel broşür ve katalog gönderir misiniz?")
    assert intent == "CATALOG_REQUEST"

    # Objection
    intent, _ = AiResponderService.classify_intent("Teşekkürler, şu an kesinlikle ilgilenmiyoruz")
    assert intent == "OBJECTION"

    # Positive
    intent, _ = AiResponderService.classify_intent("Harika, teklifi kabul ediyoruz başlayalım")
    assert intent == "POSITIVE_CONFIRM"

    # Location
    intent, _ = AiResponderService.classify_intent("Ofisiniz nerede, adresiniz nedir?")
    assert intent == "LOCATION_HOURS"

    # General
    intent, _ = AiResponderService.classify_intent("Selamlar iyi çalışmalar")
    assert intent == "GENERAL_GREETING"


def test_ai_suggestion_generation_tones():
    suggestions = AiResponderService.generate_suggestions(
        intent="PRICE_INQUIRY",
        name="Ahmet Yılmaz",
        category="Diş Kliniği",
        city="Kadıköy",
    )
    assert len(suggestions) == 3
    tones = [s["tone"] for s in suggestions]
    assert "PROFESSIONAL" in tones
    assert "PERSUASIVE" in tones
    assert "CALL_TO_ACTION" in tones
    assert any("Ahmet Yılmaz" in s["text"] for s in suggestions)


@pytest.mark.asyncio
async def test_ai_suggest_reply_endpoint(mock_user):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with async_session() as session:
        # Create Contact & Conversation
        contact = Contact(user_id=TEST_USER_ID, display_name="Dr. Mehmet Öz", phone_e164="+905551234567")
        session.add(contact)
        await session.commit()
        await session.refresh(contact)

        lead = Lead(
            user_id=TEST_USER_ID,
            name="Mehmet Öz Sağlık Merkezi",
            phone="05551234567",
            phone_e164="+905551234567",
            category="Sağlık & Medikal",
            city="İstanbul",
            is_whatsapp_eligible=True,
            status=LeadStatus.CONTACTED,
        )
        session.add(lead)
        await session.commit()
        await session.refresh(lead)

        conv = Conversation(
            user_id=TEST_USER_ID,
            contact_id=contact.id,
            lead_id=lead.id,
            channel="WHATSAPP",
        )
        session.add(conv)
        await session.commit()
        await session.refresh(conv)

        # Inbound message asking for price
        msg = Message(
            user_id=TEST_USER_ID,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Merhaba, kurumsal paketlerinizin fiyatı ne kadar?",
            sender_phone="+905559876543",
            recipient_phone="+905551234567",
            status=ConversationMessageStatus.RECEIVED,
        )
        session.add(msg)

        # Add a quick reply for price
        qr = QuickReply(
            user_id=TEST_USER_ID,
            shortcut="/fiyat",
            title="Kurumsal Fiyat Listesi",
            content="Kurumsal fiyat listemiz ekteki gibidir.",
            category="Fiyat",
        )
        session.add(qr)
        await session.commit()

        # Test suggest_replies service method directly
        res = await AiResponderService.suggest_replies(session, TEST_USER_ID, conv.id)
        assert res["conversation_id"] == conv.id
        assert res["detected_intent"] == "PRICE_INQUIRY"
        assert len(res["suggestions"]) == 3
        assert len(res["matching_quick_replies"]) >= 1
        assert res["matching_quick_replies"][0]["shortcut"] == "/fiyat"

    await engine.dispose()
