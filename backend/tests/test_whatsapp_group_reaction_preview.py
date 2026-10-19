"""Test group reaction preview formatting and reactor name resolution.

Ensures WhatsApp Web parity:
- Group reactions display the reactor's contact name (e.g., 'Filiz Ablam şu mesaja 😂 ifadesini bıraktı').
- Group reactions NEVER display the group's own name (e.g. 'Tezcan Ailesi şu mesaja...').
- Outbound self-reactions display 'Şu mesaja 😂 ifadesini bıraktınız'.
- Unresolved / unknown participants display 'Şu mesaja 😂 ifadesini bıraktı'.
"""
import uuid
import pytest
from sqlalchemy import select
from backend.app.core.database import AsyncSessionLocal
from backend.app.services.whatsapp.preview_normalization import format_reaction_preview
from backend.app.services.whatsapp.repositories.reactions import (
    batch_resolve_reactor_names,
    resolve_reactor_display_name,
)
from backend.app.models.contact import Contact


def test_format_reaction_preview_group_with_reactor_name():
    # TR
    text_tr = format_reaction_preview(
        "😂",
        from_me=False,
        sender_name="Filiz Ablam",
        is_group=True,
        lang="tr",
    )
    assert text_tr == "Filiz Ablam şu mesaja 😂 ifadesini bıraktı"

    # EN
    text_en = format_reaction_preview(
        "😂",
        from_me=False,
        sender_name="Filiz Ablam",
        is_group=True,
        lang="en",
    )
    assert text_en == "Filiz Ablam reacted 😂 to a message"


def test_format_reaction_preview_group_without_reactor_name_never_uses_group_name():
    # When sender_name is None, it should not invent a name
    text = format_reaction_preview(
        "😂",
        from_me=False,
        sender_name=None,
        is_group=True,
        lang="tr",
    )
    assert text == "Şu mesaja 😂 ifadesini bıraktı"
    assert "Tezcan" not in text


def test_format_reaction_preview_from_me():
    text_tr = format_reaction_preview(
        "😂",
        from_me=True,
        sender_name="Filiz Ablam",
        is_group=True,
        lang="tr",
    )
    assert text_tr == "Şu mesaja 😂 ifadesini bıraktınız"


@pytest.mark.asyncio
async def test_batch_resolve_reactor_names_with_contact():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        contact = Contact(
            user_id=user_id,
            phone_e164="+905356872662",
            display_name="Filiz Ablam",
        )
        db.add(contact)
        await db.commit()

        resolved = await batch_resolve_reactor_names(
            db,
            user_id,
            ["905356872662@s.whatsapp.net", "ME"],
        )

        assert "905356872662@s.whatsapp.net" in resolved
        assert resolved["905356872662@s.whatsapp.net"] == "Filiz Ablam"
        assert "ME" not in resolved  # ME is filtered out from external names
