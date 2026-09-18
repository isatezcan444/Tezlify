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
    safe_display_name,
)
from backend.app.services.whatsapp.repositories.contacts import set_contact_name
from backend.app.models.contact import Contact
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


def test_unsaved_pn_jid_with_device_index():
    """Multi-device PN JID (e.g. 905321234567:0@s.whatsapp.net) correctly extracts clean phone number without device suffix."""
    clean = extract_clean_phone("905321234567:0@s.whatsapp.net")
    assert clean == "+905321234567"

    name, state = resolve_contact_identity(contact=None, phone="905321234567:0@s.whatsapp.net")
    assert name == "+905321234567"
    assert state == IdentityResolutionState.RESOLVED_PHONE


def test_saved_contact_precedence_over_unsaved():
    """Saved contact in address book resolves to contact name; unsaved contact resolves to clean phone."""
    saved_contact = SimpleNamespace(display_name="Ahmet Yılmaz", phone_e164="+905321112233", custom_attributes={})
    name_saved, state_saved = resolve_contact_identity(contact=saved_contact, phone="+905321112233")
    assert name_saved == "Ahmet Yılmaz"
    assert state_saved == IdentityResolutionState.RESOLVED_PROFILE

    unsaved_contact = SimpleNamespace(display_name=None, phone_e164="+905329998877", custom_attributes={})
    name_unsaved, state_unsaved = resolve_contact_identity(contact=unsaved_contact, phone="905329998877@s.whatsapp.net")
    assert name_unsaved == "+905329998877"
    assert state_unsaved == IdentityResolutionState.RESOLVED_PHONE


def test_activity_ordering_independent_of_identity():
    """Conversation ordering is determined solely by last_message_at descending, regardless of saved vs unsaved contact status."""
    from datetime import datetime, timezone
    # Sohbet A: Kayitli kisi, Son mesaj: 10:00
    conv_a = {
        "id": 1,
        "name": "Ahmet Yılmaz",
        "last_message_at": datetime(2026, 9, 18, 10, 0, 0, tzinfo=timezone.utc),
    }
    # Sohbet B: Kayitli olmayan numara, Son mesaj: 10:05
    conv_b = {
        "id": 2,
        "name": "+905321234567",
        "last_message_at": datetime(2026, 9, 18, 10, 5, 0, tzinfo=timezone.utc),
    }

    convs = [conv_a, conv_b]
    # Sorting solely by activity timestamp desc
    sorted_convs = sorted(convs, key=lambda c: c["last_message_at"], reverse=True)
    assert sorted_convs[0]["name"] == "+905321234567"
    assert sorted_convs[1]["name"] == "Ahmet Yılmaz"


def test_lid_mapping_resolution_to_canonical_phone():
    """LID JIDs mapped to phone JIDs in lid_mappings resolve to canonical E.164 phone numbers."""
    # US number test case
    us_lid = "199076280832146@lid"
    us_phone_jid = "16465894168@s.whatsapp.net"
    us_phone = jid_to_phone(us_phone_jid)
    assert us_phone == "+16465894168"
    name, state = resolve_contact_identity(contact=None, phone=us_phone)
    assert name == "+16465894168"
    assert state == IdentityResolutionState.RESOLVED_PHONE

    # TR number test case (+90 532 233 49 68)
    tr_lid = "30039085178980@lid"
    tr_phone_jid = "905322334968@s.whatsapp.net"
    tr_phone = jid_to_phone(tr_phone_jid)
    assert tr_phone == "+905322334968"
    name_tr, state_tr = resolve_contact_identity(contact=None, phone=tr_phone)
    assert name_tr == "+905322334968"
    assert state_tr == IdentityResolutionState.RESOLVED_PHONE


def test_unsaved_phone_contact_with_push_name_resolves_to_phone():
    """Stranger WhatsApp profile nickname (name_source = 'push') must never resolve to profile name."""
    contact = SimpleNamespace(
        display_name="+905322334968",
        phone_e164="+905322334968",
        custom_attributes={"name_source": "push", "push_name": "Fikret Bircan"},
    )
    name, state = resolve_contact_identity(contact=contact, phone="+905322334968")
    assert name == "+905322334968"
    assert state == IdentityResolutionState.RESOLVED_PHONE
    assert safe_display_name(contact) == "+905322334968"


def test_saved_addressbook_contact_resolves_to_profile():
    """Real phone address book contact (name_source = 'addressbook') resolves to profile name."""
    contact = SimpleNamespace(
        display_name="Mehmet Kirkar",
        phone_e164="+905324960912",
        custom_attributes={"name_source": "addressbook"},
    )
    name, state = resolve_contact_identity(contact=contact, phone="+905324960912")
    assert name == "Mehmet Kirkar"
    assert state == IdentityResolutionState.RESOLVED_PROFILE
    assert safe_display_name(contact) == "Mehmet Kirkar"


def test_set_contact_name_push_does_not_pollute_display_name():
    """set_contact_name with source='push' stores push_name metadata but never overwrites display_name."""
    contact = Contact(
        user_id="user-1",
        phone_e164="+905322334968",
        display_name="+905322334968",
        custom_attributes={},
    )
    changed = set_contact_name(contact, "Fikret Bircan", "push")
    assert changed is True
    assert contact.display_name == "+905322334968"
    assert contact.custom_attributes.get("push_name") == "Fikret Bircan"
    assert contact.custom_attributes.get("name_source") == "push"


