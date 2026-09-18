"""Contact persistence repository.

Persistence queries and entity mutation policies for WhatsApp contacts.
DOES NOT own transaction lifecycle (no commit/rollback).
"""

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.services.whatsapp.identity import (
    NAME_RANK,
    is_phone_like,
    is_raw_jid_name,
)


def set_contact_avatar(contact: Contact, avatar_url: Optional[str]) -> None:
    """Contact avatarini custom_attributes icine yazar."""
    if not avatar_url:
        return
    attrs = dict(contact.custom_attributes or {})
    if attrs.get("avatar_url") == avatar_url:
        return
    attrs["avatar_url"] = avatar_url
    contact.custom_attributes = attrs


def get_contact_avatar(contact: Optional[Contact]) -> Optional[str]:
    """Contact custom_attributes icindeki avatar_url degerini okur."""
    if contact is None:
        return None
    attrs = contact.custom_attributes or {}
    value = attrs.get("avatar_url") if isinstance(attrs, dict) else None
    return str(value) if value else None


def set_contact_name(contact: Contact, name: Optional[str], source: Optional[str]) -> bool:
    """Oncelik-cozumumlu kisi adi guncellemesi; isim degistiyse True doner.

    Kural:
    - 'push' (WhatsApp profil adi): Karsi tarafin kendi sectigi takma addir;
      kullanicinin telefon rehberinde kayitli degildir. Bu ad ASLA
      `contact.display_name` olarak yazilmaz! Yalnizca `custom_attributes['push_name']`
      olarak saklanir (WhatsApp Web paritesi: yabanci numaralar telefon gorunur).
    - 'addressbook', 'verified', 'group_subject': Gercek rehber/isletme/grup adlari
      `contact.display_name` olarak atanir.
    """
    if not name:
        return False
    # Faz 7: ham jid/lid ('6277...@lid', 'jid:...') asla gercek ad olarak
    # yazilmaz — identity cozulumu tamamlanana kadar ad None kalir.
    if is_raw_jid_name(name):
        return False
    clean = str(name).strip()[:150]
    if not clean:
        return False
    # Telefon gorunumundeki bir ad (ornek '+90532...') gercek bir adin
    # uzerine asla yazilmaz; yalnizca bos kisiye yerlestirilir.
    if is_phone_like(clean) and not is_phone_like(contact.display_name):
        return False
    src = str(source) if str(source or "") in NAME_RANK else "history"
    attrs = dict(contact.custom_attributes or {})
    stored_source = str(attrs.get("name_source") or "")
    phone_like = is_phone_like(contact.display_name) or contact.display_name == contact.phone_e164
    if stored_source in NAME_RANK:
        current_rank = NAME_RANK[stored_source]
    else:
        # Kaynagi bilinmeyen eski kayitlar: gercek ad gibi varsay (history rutbesi), telefon gibi ise 0.
        current_rank = 0 if phone_like else (NAME_RANK["history"] if contact.display_name else 0)

    # Push name: Karsi tarafin kendi profil takma adi. Asla rehber display_name'i ezmez/olusturmaz.
    if src == "push":
        if current_rank > NAME_RANK["push"]:
            return False
        changed = False
        if attrs.get("push_name") != clean:
            attrs["push_name"] = clean
            changed = True
        if not attrs.get("name_source"):
            attrs["name_source"] = "push"
            changed = True
        if changed:
            contact.custom_attributes = attrs
        return changed
    phone_like = is_phone_like(contact.display_name) or contact.display_name == contact.phone_e164
    if phone_like or NAME_RANK[src] >= current_rank:
        changed = contact.display_name != clean
        contact.display_name = clean
        if attrs.get("name_source") != src:
            attrs["name_source"] = src
            contact.custom_attributes = attrs
        return changed
    return False


async def get_contact_by_phone(
    db: AsyncSession, user_id: str, phone_e164: str
) -> Optional[Contact]:
    """Telefon numarasi ile tenant kisi kaydini arar."""
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164 == phone_e164,
            get_user_filter(Contact.user_id, user_id),
        )
    )
    return res.scalars().first()
