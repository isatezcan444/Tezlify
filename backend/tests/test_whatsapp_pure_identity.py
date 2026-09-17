"""
Unit tests for WhatsApp pure identity resolution module (Phase 11.6 Batch 1).
"""

import pytest

from backend.app.services.whatsapp.identity import (
    NAME_RANK,
    contact_phone_for_jid,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_phone_like,
    is_raw_jid_name,
    jid_to_phone,
    phone_to_jid,
    safe_display_name,
)


class DummyContact:
    def __init__(self, display_name: str | None = None, custom_attributes: dict | None = None) -> None:
        self.display_name = display_name
        self.custom_attributes = custom_attributes


# ==============================================================================
# 1. jid_to_phone
# ==============================================================================

def test_jid_to_phone_standard_turkish():
    assert jid_to_phone("905321002030@s.whatsapp.net") == "+905321002030"
    assert jid_to_phone("905551234567@s.whatsapp.net") == "+905551234567"


def test_jid_to_phone_international():
    assert jid_to_phone("14155552671@s.whatsapp.net") == "+14155552671"
    assert jid_to_phone("447911123456@s.whatsapp.net") == "+447911123456"
    assert jid_to_phone("4915123456789@s.whatsapp.net") == "+4915123456789"


def test_jid_to_phone_lid_returns_none():
    """LID identities must NEVER synthesize phone numbers (AGENTS.md invariant)."""
    assert jid_to_phone("12345678901234@lid") is None
    assert jid_to_phone("987654321@lid") is None


def test_jid_to_phone_group_returns_none():
    """Group JIDs must NEVER synthesize phone numbers."""
    assert jid_to_phone("120363025442111111@g.us") is None
    assert jid_to_phone("905551234567-123456@g.us") is None


def test_jid_to_phone_degenerate_returns_none():
    """Degenerate JIDs (e.g. 0@s.whatsapp.net) must return None."""
    assert jid_to_phone("0@s.whatsapp.net") is None
    assert jid_to_phone("000@s.whatsapp.net") is None
    assert jid_to_phone("123@s.whatsapp.net") is None  # < 5 digits


def test_jid_to_phone_empty_and_none():
    assert jid_to_phone(None) is None
    assert jid_to_phone("") is None


# ==============================================================================
# 2. is_degenerate_jid
# ==============================================================================

def test_is_degenerate_jid():
    assert is_degenerate_jid("0@s.whatsapp.net") is True
    assert is_degenerate_jid("00000@s.whatsapp.net") is True
    assert is_degenerate_jid("1234@s.whatsapp.net") is True
    assert is_degenerate_jid("905551234567@s.whatsapp.net") is False
    assert is_degenerate_jid(None) is False
    assert is_degenerate_jid("") is False


# ==============================================================================
# 3. is_broadcast_only_jid
# ==============================================================================

def test_is_broadcast_only_jid():
    assert is_broadcast_only_jid("status@broadcast") is True
    assert is_broadcast_only_jid("123456789@newsletter") is True
    assert is_broadcast_only_jid("905551234567@s.whatsapp.net") is False
    assert is_broadcast_only_jid("120363025442111111@g.us") is False
    assert is_broadcast_only_jid(None) is False
    assert is_broadcast_only_jid("") is False


# ==============================================================================
# 4. phone_to_jid
# ==============================================================================

def test_phone_to_jid():
    assert phone_to_jid("+905321002030") == "905321002030@s.whatsapp.net"
    assert phone_to_jid("905321002030") == "905321002030@s.whatsapp.net"
    assert phone_to_jid("+1 (415) 555-2671") == "14155552671@s.whatsapp.net"


# ==============================================================================
# 5. is_phone_like
# ==============================================================================

def test_is_phone_like():
    assert is_phone_like(None) is True
    assert is_phone_like("") is True
    assert is_phone_like("+905551234567") is True
    assert is_phone_like("jid:120363025442111111@g.us") is True
    assert is_phone_like("Ahmet Yılmaz") is False
    assert is_phone_like("Tezlify Support") is False


# ==============================================================================
# 6. is_raw_jid_name & safe_display_name
# ==============================================================================

def test_is_raw_jid_name():
    assert is_raw_jid_name(None) is False
    assert is_raw_jid_name("") is False
    assert is_raw_jid_name("jid:905551234567@s.whatsapp.net") is True
    assert is_raw_jid_name("12345678901234@lid") is True
    assert is_raw_jid_name("905551234567@c.us") is True
    assert is_raw_jid_name("905551234567@s.whatsapp.net") is True
    assert is_raw_jid_name("120363025442111111@g.us") is True
    assert is_raw_jid_name("Mehmet Demir") is False


def test_safe_display_name():
    assert safe_display_name(None) is None
    assert safe_display_name(DummyContact("Ali Veli")) == "Ali Veli"
    assert safe_display_name(DummyContact("12345678901234@lid")) is None
    assert safe_display_name(DummyContact("jid:120363025442111111@g.us")) is None
    # Push name fallback for no-phone / LID contacts
    assert safe_display_name(DummyContact("12345678901234@lid", {"push_name": "Semih Doğan"})) == "Semih Doğan"
    assert safe_display_name(DummyContact(None, {"push_name": "Semih Doğan"})) == "Semih Doğan"
    assert safe_display_name(DummyContact(None, {"push_name": "6277000@lid"})) is None


# ==============================================================================
# 7. contact_phone_for_jid
# ==============================================================================

def test_contact_phone_for_jid():
    assert contact_phone_for_jid("905551234567@s.whatsapp.net") == "+905551234567"
    assert contact_phone_for_jid("120363025442111111@g.us") == "jid:120363025442111111@g.us"
    assert contact_phone_for_jid("12345678901234@lid") == "jid:12345678901234@lid"


# ==============================================================================
# 8. NAME_RANK
# ==============================================================================

def test_name_rank_precedence():
    assert NAME_RANK["addressbook"] > NAME_RANK["verified"]
    assert NAME_RANK["verified"] >= NAME_RANK["group_subject"]
    assert NAME_RANK["group_subject"] > NAME_RANK["history"]
    assert NAME_RANK["history"] > NAME_RANK["push"]
    assert NAME_RANK["push"] > NAME_RANK["phone"]
