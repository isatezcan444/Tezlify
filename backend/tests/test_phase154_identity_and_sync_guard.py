"""Acceptance tests for Phase 15.4: WhatsApp Identity Normalization & Sync Expansion Safety Guard.

Covers:
- Unsaved phone contact identity resolution (never stuck in unresolved / resolving)
- PN JID normalization to clean E.164 phone
- LID identity resolution (with push_name vs unmapped)
- Group JID safety (never converted to fake phone numbers)
- Transient vs terminal identity resolution states
- Background history expansion kill-switch behavior
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from types import SimpleNamespace

from backend.app.services.whatsapp.identity import (
    IdentityResolutionState,
    extract_clean_phone,
    jid_to_phone,
    phone_to_jid,
    is_raw_jid_name,
    is_self_identity,
    resolve_contact_identity,
)
from backend.app.core.config import settings
from backend.app.services.whatsapp.orchestration.sync import _run_background_history_expansion


def test_unsaved_phone_contact_is_not_unresolved():
    """Unsaved phone contact without addressbook name must resolve to its clean phone number."""
    contact = SimpleNamespace(display_name=None, phone_e164="+905413749073", custom_attributes={})
    name, state = resolve_contact_identity(contact=contact, phone="+905413749073")
    assert name == "+905413749073"
    assert state == IdentityResolutionState.RESOLVED_PHONE


def test_message_contact_without_addressbook_entry():
    """Contact with only PN JID and messages in conversation resolves to phone, not pending/resolving."""
    name, state = resolve_contact_identity(contact=None, phone="905321112233@s.whatsapp.net")
    assert name == "+905321112233"
    assert state == IdentityResolutionState.RESOLVED_PHONE


def test_pn_jid_without_contact_record():
    """Raw PN JID with jid: prefix and no contact record extracts clean +E.164 phone."""
    clean = extract_clean_phone("jid:905559876543@s.whatsapp.net")
    assert clean == "+905559876543"

    name, state = resolve_contact_identity(contact=None, phone="jid:905559876543@s.whatsapp.net")
    assert name == "+905559876543"
    assert state == IdentityResolutionState.RESOLVED_PHONE


def test_lid_without_phone_mapping():
    """Unsaved @lid without phone mapping resolves to RESOLVED_JID, avoiding endless resolving spinner."""
    name, state = resolve_contact_identity(contact=None, phone="jid:12345678901234@lid", is_transient_resolving=False)
    assert name is None
    assert state == IdentityResolutionState.RESOLVED_JID


def test_lid_with_push_name():
    """@lid contact with push_name in custom_attributes resolves to RESOLVED_PROFILE with that push_name."""
    contact = SimpleNamespace(
        display_name=None,
        phone_e164="jid:12345678901234@lid",
        custom_attributes={"push_name": "Caner"},
    )
    name, state = resolve_contact_identity(contact=contact, phone="jid:12345678901234@lid")
    assert name == "Caner"
    assert state == IdentityResolutionState.RESOLVED_PROFILE


def test_contact_resolution_timeout_becomes_terminal():
    """Transient resolution flag produces RESOLVING_TRANSIENT only while in-flight, terminal otherwise."""
    # When active resolution is genuinely running
    _, in_flight_state = resolve_contact_identity(contact=None, phone=None, is_transient_resolving=True)
    assert in_flight_state == IdentityResolutionState.RESOLVING_TRANSIENT

    # When no active resolution is running, state is terminal
    _, terminal_state = resolve_contact_identity(contact=None, phone=None, is_transient_resolving=False)
    assert terminal_state == IdentityResolutionState.UNRESOLVED_PERMANENT


def test_restart_preserves_stable_identity():
    """Deterministic resolution produces exact same result across executions."""
    contact = SimpleNamespace(display_name="Ali Veli", phone_e164="+905551234567", custom_attributes={})
    res1 = resolve_contact_identity(contact=contact, phone="+905551234567")
    res2 = resolve_contact_identity(contact=contact, phone="+905551234567")
    assert res1 == res2 == ("Ali Veli", IdentityResolutionState.RESOLVED_PROFILE)


def test_group_jid_not_treated_as_phone():
    """Group JIDs (@g.us) are never converted into fake phone numbers."""
    grp_jid = "120363023456789012@g.us"
    assert jid_to_phone(grp_jid) is None
    assert extract_clean_phone(grp_jid) is None
    assert extract_clean_phone(f"jid:{grp_jid}") is None

    name, state = resolve_contact_identity(contact=None, phone=f"jid:{grp_jid}", is_group=True)
    assert name is None
    assert state == IdentityResolutionState.RESOLVED_JID


def test_self_lid_pn_identity():
    """Self identity matcher matches phone, session LID, and PN JIDs."""
    session_phone = "+905413749073"
    session_lid = "12345678901234@lid"

    assert is_self_identity("+905413749073", session_phone, session_lid) is True
    assert is_self_identity("905413749073@s.whatsapp.net", session_phone, session_lid) is True
    assert is_self_identity("12345678901234@lid", session_phone, session_lid) is True
    assert is_self_identity("+905551234567", session_phone, session_lid) is False


def test_identity_spinner_only_for_active_resolution():
    """Spinner state RESOLVING_TRANSIENT is never returned for static or unknown contacts without active worker."""
    raw_contacts = [
        None,
        SimpleNamespace(display_name=None, phone_e164=None, custom_attributes={}),
        SimpleNamespace(display_name="6277123@lid", phone_e164=None, custom_attributes={}),
    ]
    for c in raw_contacts:
        _, state = resolve_contact_identity(contact=c, phone=None, is_transient_resolving=False)
        assert state != IdentityResolutionState.RESOLVING_TRANSIENT
        assert state == IdentityResolutionState.UNRESOLVED_PERMANENT


@pytest.mark.asyncio
async def test_background_expansion_kill_switch():
    """When WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED is False, background expansion aborts immediately."""
    from backend.app.services.whatsapp.orchestration.sync import WhatsAppSyncOrchestrator
    
    with patch.object(settings, "WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED", False):
        orchestrator = WhatsAppSyncOrchestrator()
        
        # Calling _run_background_history_expansion must exit immediately without starting tasks
        await orchestrator._run_background_history_expansion(
            user_id="test-user-id",
            gateway_id="test-gw-uuid",
        )
        
        assert ("test-user-id", "test-gw-uuid") not in orchestrator._history_expansion_running
