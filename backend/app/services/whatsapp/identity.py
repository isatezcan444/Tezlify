"""
WhatsApp Pure Identity & JID/Phone Resolution Policy.

Phase 11.6: Extracted from whatsapp_service.py.
Pure, deterministic, database-independent, network-independent identity functions.
"""

from typing import Any, Dict, Optional

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
    digits = "".join(ch for ch in jid_str.split("@")[0] if ch.isdigit())
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
    return (v.startswith("+") and v[1:].isdigit()) or v.startswith("jid:")


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
    (frontend normalize edilmis telefona duser)."""
    if contact is None:
        return None
    name = getattr(contact, "display_name", None)
    if is_raw_jid_name(name):
        return None
    return name


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

