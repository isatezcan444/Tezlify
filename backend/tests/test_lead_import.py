import io
import uuid
import pytest
import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.services.lead_import_service import LeadImportService
from backend.app.services import whatsapp_service


async def get_test_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_csv_preview_and_import():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        csv_content = (
            "Firma Adı;Telefon;Şehir;İlçe;Sektör\n"
            "Ataşehir Diş Polikliniği;+905321112233;İstanbul;Ataşehir;Sağlık\n"
            "Kadıköy Veteriner;05332223344;İstanbul;Kadıköy;Veteriner\n"
            "Beşiktaş Cafe;5343334455;İstanbul;Beşiktaş;Gıda\n"
        ).encode("utf-8")

        # 1. Preview
        preview = LeadImportService.preview(csv_content, "klinikler.csv")
        assert preview["total_rows"] == 3
        assert "Firma Adı" in preview["headers"]
        assert preview["detected_mapping"]["name"] == "Firma Adı"
        assert preview["detected_mapping"]["phone"] == "Telefon"
        assert preview["detected_mapping"]["city"] == "Şehir"
        assert preview["detected_mapping"]["district"] == "İlçe"
        assert preview["detected_mapping"]["category"] == "Sektör"
        assert len(preview["preview_rows"]) == 3

        # 2. Import
        result = await LeadImportService.parse_and_import(
            db=db,
            file_bytes=csv_content,
            filename="klinikler.csv",
            user_id=user_id,
        )
        assert result["total_rows"] == 3
        assert result["created_count"] == 3
        assert result["updated_count"] == 0
        assert result["skipped_count"] == 0
        assert result["invalid_phone_count"] == 0

        # Verify persisted rows
        stmt = select(Lead).where(Lead.user_id == user_id).order_by(Lead.id)
        rows = (await db.execute(stmt)).scalars().all()
        assert len(rows) == 3
        assert rows[0].name == "Ataşehir Diş Polikliniği"
        assert rows[0].phone_e164 == "+905321112233"
        assert rows[0].city == "İstanbul"
        assert rows[0].district == "Ataşehir"
        assert rows[0].category == "Sağlık"
        assert rows[0].is_whatsapp_eligible is True


@pytest.mark.asyncio
async def test_csv_deduplication_on_reimport():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        csv_content = (
            "Firma Adı,Telefon,İl,İlçe\n"
            "Tekrar Testi Ltd,05351234567,İzmir,Konak\n"
        ).encode("utf-8")

        # First import
        res1 = await LeadImportService.parse_and_import(
            db=db,
            file_bytes=csv_content,
            filename="dedup.csv",
            user_id=user_id,
        )
        assert res1["created_count"] == 1

        # Second import (same content)
        res2 = await LeadImportService.parse_and_import(
            db=db,
            file_bytes=csv_content,
            filename="dedup.csv",
            user_id=user_id,
        )
        assert res2["created_count"] == 0
        assert res2["updated_count"] == 1


@pytest.mark.asyncio
async def test_csv_invalid_phones_and_skipped_no_name():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        csv_content = (
            "İşletme Adı,Telefon\n"
            ",05329998877\n"  # No name -> skipped
            "Geçersiz Numaralı İşletme,hatalı_telefon_123\n"  # Invalid phone
            "Geçerli İşletme,05321234567\n"
        ).encode("utf-8")

        result = await LeadImportService.parse_and_import(
            db=db,
            file_bytes=csv_content,
            filename="edge_cases.csv",
            user_id=user_id,
        )
        assert result["total_rows"] == 3
        assert result["skipped_count"] == 1  # empty name
        assert result["invalid_phone_count"] == 1  # invalid phone
        assert result["created_count"] == 2  # both rows created, one with phone_e164=None


@pytest.mark.asyncio
async def test_excel_import():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        df = pd.DataFrame([
            {
                "Firma": "Excel Diş Kliniği",
                "GSM": "05391234567",
                "Şehir": "Ankara",
                "İlçe": "Çankaya",
                "Kategori": "Sağlık",
            },
            {
                "Firma": "Excel Avukatlık Bürosu",
                "GSM": "05381234567",
                "Şehir": "Ankara",
                "İlçe": "Yenimahalle",
                "Kategori": "Hukuk",
            },
        ])
        buf = io.BytesIO()
        df.to_excel(buf, index=False, engine="openpyxl")
        excel_bytes = buf.getvalue()

        preview = LeadImportService.preview(excel_bytes, "test.xlsx")
        assert preview["total_rows"] == 2
        assert preview["detected_mapping"]["name"] == "Firma"
        assert preview["detected_mapping"]["phone"] == "GSM"

        result = await LeadImportService.parse_and_import(
            db=db,
            file_bytes=excel_bytes,
            filename="test.xlsx",
            user_id=user_id,
        )
        assert result["created_count"] == 2


@pytest.mark.asyncio
async def test_conversation_link_lead_and_status():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())

        # Create contact & conversation
        contact = Contact(
            user_id=user_id,
            phone_e164="+905328889900",
            display_name="Dr. Ahmet Yılmaz",
        )
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        # Create lead
        lead = Lead(
            user_id=user_id,
            name="Ahmet Diş Kliniği",
            phone="+905328889900",
            phone_e164="+905328889900",
            status=LeadStatus.NEW,
        )
        db.add(lead)
        await db.commit()

        # Link conversation to lead
        link_res = await whatsapp_service.link_conversation_lead(
            db=db,
            user_id=user_id,
            conversation_id=conv.id,
            lead_id=lead.id,
        )
        assert link_res["conversation_id"] == conv.id
        assert link_res["lead_id"] == lead.id
        assert link_res["lead_status"] == "NEW"

        # Verify conversation list returns lead_id and lead_status
        items, total = await whatsapp_service.list_conversations(
            db=db,
            user_id=user_id,
            conversation_id=conv.id,
        )
        assert total == 1
        assert items[0]["lead_id"] == lead.id
        assert items[0]["lead_status"] == "NEW"
