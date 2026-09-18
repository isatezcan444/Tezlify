"""
WhatsApp Pure Identity & JID/Phone Resolution Policy.

Phase 11.6: Extracted from whatsapp_service.py.
Pure, deterministic, database-independent, network-independent identity functions.
"""

from typing import Any, Dict, Optional, Tuple

SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"

# Contact name precedence dictionary (WhatsApp Web parity)
NAME_RANK: Dict[str, int] = {
    "addressbook": 5,
    "verified": 4,
    "group_subject": 4,
    "history": 3,
    "push": 2,
    "phone": 1,
}


def jid_to_phone(jid: Optional[str]) -> Optional[str]:
    """`905321002030@s.whatsapp.net` -> `+905321002030`.

    Faz 6e: `xxx@lid` kimlikleri WhatsApp'ın telefon-gizli LID anahtarıdır ve
    telefon numarası DEĞİLDİR — asla `+rakam` türetilmez (AGENTS.md: sahte
    telefon sentezlenmez). Gateway eşleşmeyi öğrenince telefona çözülmüş JID
    gönderir; öğrenemezse hiç göndermez.
    """
    if not jid:
        return None
    jid_str = str(jid)
    if jid_str.endswith("@lid"):
        return None
    # Faz 8 (RC-4): grup JID'inden (`120363...@g.us`) asla telefon türetilmez
    # — yoksa UI'da `+1203632...` gibi sahte numaralar görünür (AGENTS.md).
    if "@g.us" in jid_str:
        return None
    head = jid_str.split("@")[0].split(":")[0]
    digits = "".join(ch for ch in head if ch.isdigit())
    # Faz 9 (§4/§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`) '+0' gibi
    # uydurma telefonlar üretilmez — en az 5 hane ve tümü sıfır olamaz.
    if not digits or len(digits) < 5 or set(digits) == {"0"}:
        return None
    return f"+{digits}"


def is_degenerate_jid(jid: Optional[str]) -> bool:
    """Faz 9 (§5): WhatsApp sistem/dejenere JID'leri (`0@s.whatsapp.net`,
    `000@...`) gercek bir kisi/sohbet DEGILDIR — contact/conversation
    kaydi uretilmez (kapida '+0' chat'in kaynagi buydu). Gateway ile
    ayni kural: 5+ hane ve tamami sifir degil."""
    if not jid:
        return False
    head = str(jid).split("@")[0]
    digits = "".join(ch for ch in head if ch.isdigit())
    if not digits or digits != head.strip():
        return False
    return len(digits) < 5 or set(digits) == {"0"}


def is_broadcast_only_jid(jid: Optional[str]) -> bool:
    """WhatsApp Durum/Hikaye (`status@broadcast`) ve kanal (`@newsletter`) JID'leri."""
    if not jid:
        return False
    jid_str = str(jid)
    return jid_str == "status@broadcast" or jid_str.endswith("@newsletter")


def phone_to_jid(phone_e164: str) -> str:
    """`+905321002030` -> `905321002030@s.whatsapp.net`."""
    digits = "".join(ch for ch in str(phone_e164 or "") if ch.isdigit())
    return f"{digits}@s.whatsapp.net"


def is_phone_like(value: Optional[str]) -> bool:
    """Ad bos ya da telefon numarasi gorunumunde mi ('+90...', 'jid:...')."""
    if not value:
        return True
    v = str(value).strip()
    if (v.startswith("+") and v[1:].replace(" ", "").isdigit()) or v.startswith("jid:"):
        return True
    digits_only = "".join(ch for ch in v if ch.isdigit())
    letters_only = "".join(ch for ch in v if ch.isalpha())
    if len(digits_only) >= 5 and len(letters_only) == 0:
        return True
    return False


def is_raw_jid_name(value: Optional[str]) -> bool:
    """Ham WhatsApp kimligi gorunumunde ad mi ('6277...@lid', '123...@c.us',
    'jid:...') — presentation layer'a asla cikmamali (Faz 7)."""
    if not value:
        return False
    v = str(value).strip()
    return (
        v.startswith("jid:")
        or "@lid" in v
        or v.endswith("@c.us")
        or v.endswith("@s.whatsapp.net")
        or v.endswith("@g.us")
    )


def safe_display_name(contact: Optional[Any]) -> Optional[str]:
    """UI icin guvenli gorunen ad: ham jid/lid sizarca None'a cevrilir
    (frontend normalize edilmis telefona veya push_name fallback'ine duser).

    Phase 15.4: `name_source == 'push'` ise `display_name` karsi tarafin KENDI
    profil takma adidir — kullanicinin rehber kaydi degildir. Telefon
    cozulebiliyorsa ad olarak DONDURULMEZ (WhatsApp Web paritesi: yabanci
    numarada `+90...` gosterilir). Bu, `resolve_contact_identity` adim 2/3 ile
    ayni davranistir; boylece REST ve WebSocket ayni kimligi uretir.

    Telefon cozulemiyorsa (ornegin eslesmemis LID) push adi fallback olarak
    kullanilir — `resolve_contact_identity` adim 4 ile ayni kural.
    """
    if contact is None:
        return None
    custom = getattr(contact, "custom_attributes", None)
    attrs = custom if isinstance(custom, dict) else {}
    name_source = str(attrs.get("name_source") or "")

    name = getattr(contact, "display_name", None)
    if name and not is_raw_jid_name(name) and str(name).strip():
        if name_source != "push":
            return str(name).strip()
        # name_source == 'push': `display_name` karsi tarafin KENDI profil
        # takma adidir. Telefon cozulebiliyorsa takma ad AD olarak
        # dondurulmez — onun yerine normalize telefon doner. Bu, REST'in
        # `resolve_contact_identity` adim 2/3 cikitisi (RESOLVED_PHONE) ile
        # ayni sonucu verir, boylece REST ve WebSocket ayrisamaz.
        # Telefon cozulemiyorsa (ornegin eslesmemis LID) takma ad fallback
        # olur — `resolve_contact_identity` adim 4 ile ayni kural.
        return extract_clean_phone(getattr(contact, "phone_e164", None)) or str(name).strip()

    push_name = attrs.get("push_name")
    if push_name and not is_raw_jid_name(push_name) and str(push_name).strip():
        return str(push_name).strip()
    return None


def contact_phone_for_jid(jid: str) -> str:
    """Kisi telefon/`jid:` sentinel kurali (tek kaynak — _upsert_contact ve
    batch yollari ayni semantigi kullanir).

    Grup JID'leri ("...@g.us") telefon numarasina cevrilemez; jid: sentinel'i
    ile saklanır — _resolve_jid ve is_group bu sentinel'e guvenir.
    """
    if "@g.us" in str(jid):
        return f"jid:{jid}"
    phone = jid_to_phone(jid)
    return phone or f"jid:{jid}"


def strip_jid_prefix(value: Optional[str]) -> str:
    """Strips 'jid:' sentinel prefix from phone/JID strings."""
    if not value:
        return ""
    v = str(value).strip()
    if v.startswith("jid:"):
        return v[4:]
    return v


def is_self_identity(
    candidate: Optional[str],
    session_phone: Optional[str],
    session_lid: Optional[str] = None,
) -> bool:
    """Checks whether candidate JID/LID/phone represents the authenticated user's self identity."""
    if not candidate or not session_phone:
        return False
    clean_cand = strip_jid_prefix(candidate)
    clean_sess = strip_jid_prefix(session_phone)

    # Match session LID if provided
    if session_lid:
        clean_lid = strip_jid_prefix(session_lid)
        cand_user = clean_cand.split("@")[0].split(":")[0]
        lid_user = clean_lid.split("@")[0].split(":")[0]
        if clean_cand == clean_lid or cand_user == lid_user:
            return True

    # Match digits / phone E.164
    cand_user = clean_cand.split("@")[0].split(":")[0]
    sess_user = clean_sess.split("@")[0].split(":")[0]
    cand_digits = "".join(ch for ch in cand_user if ch.isdigit())
    sess_digits = "".join(ch for ch in sess_user if ch.isdigit())
    if cand_digits and sess_digits and cand_digits == sess_digits:
        return True

    return False


class IdentityResolutionState:
    RESOLVED_PROFILE = "RESOLVED_PROFILE"
    RESOLVED_PHONE = "RESOLVED_PHONE"
    RESOLVED_JID = "RESOLVED_JID"
    RESOLVING_TRANSIENT = "RESOLVING_TRANSIENT"
    UNRESOLVED_PERMANENT = "UNRESOLVED_PERMANENT"


def extract_clean_phone(value: Optional[str]) -> Optional[str]:
    """Extracts a valid normalized E.164 phone string from phone_e164 or raw PN JID.
    
    Returns None for LID JIDs (@lid), Group JIDs (@g.us), broadcast JIDs,
    or degenerate/invalid numbers (< 5 digits, all zeros).
    """
    if not value:
        return None
    val = strip_jid_prefix(str(value).strip())
    if not val or val.endswith("@lid") or "@g.us" in val or is_broadcast_only_jid(val):
        return None
    if "@" in val:
        val = val.split("@")[0]
    if ":" in val:
        val = val.split(":")[0]
    digits = "".join(ch for ch in val if ch.isdigit())
    if not digits or len(digits) < 5 or set(digits) == {"0"}:
        return None
    if len(digits) == 10 and digits.startswith("5"):
        digits = f"90{digits}"
    elif len(digits) == 11 and digits.startswith("05"):
        digits = f"90{digits[1:]}"
    return f"+{digits}"


def resolve_contact_identity(
    contact: Optional[Any],
    phone: Optional[str] = None,
    is_group: bool = False,
    is_transient_resolving: bool = False,
) -> Tuple[Optional[str], str]:
    """Resolves contact identity following strict WhatsApp Web parity:
    1. GROUP_MATCH: For group conversations, returns group subject -> RESOLVED_PROFILE.
    2. ADDRESS_BOOK_MATCH: For 1:1 chats, returns authentic address book or verified name.
       Stranger pushName / profile nicknames (name_source == 'push') are NEVER treated
       as contact names.
    3. PHONE_JID: Normalized +E.164 phone from contact.phone_e164 or PN JID -> RESOLVED_PHONE.
    4. LID_PROFILE_FALLBACK: Pure @lid without mapped phone may use push_name as profile fallback.
    5. GROUP_JID / LID_JID -> RESOLVED_JID.
    6. STABLE_FALLBACK -> RESOLVING_TRANSIENT (only if active resolution in-flight) or UNRESOLVED_PERMANENT.
    """
    clean_phone = extract_clean_phone(phone)
    if not clean_phone and contact is not None:
        clean_phone = extract_clean_phone(getattr(contact, "phone_e164", None))

    # 1. Group conversation check
    if is_group:
        if contact is not None:
            name = getattr(contact, "display_name", None)
            if name and not is_raw_jid_name(name) and str(name).strip():
                return str(name).strip(), IdentityResolutionState.RESOLVED_PROFILE
        return None, IdentityResolutionState.RESOLVED_JID

    # 2. Address book / verified display_name for 1:1 contacts
    if contact is not None:
        name = getattr(contact, "display_name", None)
        attrs = getattr(contact, "custom_attributes", None) or {}
        name_src = attrs.get("name_source") if isinstance(attrs, dict) else None

        # Push name is a stranger's profile nickname — NOT an address book contact!
        # If name_source is 'push', it must NEVER resolve to RESOLVED_PROFILE.
        if name_src != "push":
            if name and not is_raw_jid_name(name) and not is_phone_like(name) and str(name).strip():
                return str(name).strip(), IdentityResolutionState.RESOLVED_PROFILE

    # 3. Clean E.164 Phone from phone or contact.phone_e164
    if clean_phone:
        return clean_phone, IdentityResolutionState.RESOLVED_PHONE

    # 4. Pure @lid fallback: if phone is unmapped, allow push_name before falling back to RESOLVED_JID
    if contact is not None:
        attrs = getattr(contact, "custom_attributes", None) or {}
        if isinstance(attrs, dict):
            push_name = attrs.get("push_name")
            if push_name and not is_raw_jid_name(push_name) and not is_phone_like(push_name) and str(push_name).strip():
                return str(push_name).strip(), IdentityResolutionState.RESOLVED_PROFILE

    # 5. Group JID or LID JID
    phone_val = str(phone or (contact.phone_e164 if contact else "") or "")
    if "@g.us" in phone_val or "@lid" in phone_val:
        return None, IdentityResolutionState.RESOLVED_JID

    # 6. Transient resolving (only when genuinely in-flight)
    if is_transient_resolving:
        return None, IdentityResolutionState.RESOLVING_TRANSIENT

    # 7. Stable permanent fallback
    return None, IdentityResolutionState.UNRESOLVED_PERMANENT

