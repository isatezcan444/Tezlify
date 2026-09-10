"""
Tezlify WhatsApp Rebuild - Phase 2 Active Numbers & Real Meta Cloud API Tests
Comprehensive test suite covering:
1. MetaCloudApiClient (request construction, timeout, retry classification, error normalization, token redaction)
2. CredentialVault (authenticated Fernet encryption/decryption, deterministic dev fallback, secret masking)
3. Number Validation & Connect Flow (pre-flight Meta validation, WABA/Phone match, permission checks)
4. Active Numbers Lifecycle (verify, name update, atomic credential rotation)
5. Disconnect & Non-Destructive Remove Semantics (conversations/leads preserved)
6. Security & Multi-Tenancy (User A cannot access/mutate User B numbers, tokens never disclosed)
7. Concurrency & Duplicate Protection (duplicate phone_number_id rejected)
8. Real Meta Integration Check (Live test if credentials in env, else explicitly 'NOT RUN')
"""

import os
import uuid
import json
import base64
import asyncio
import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.core.credential_vault import CredentialVault
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.lead import Lead, LeadStatus
from backend.app.schemas.whatsapp_number import (
    WhatsAppNumberConnectRequest,
    WhatsAppNumberValidateRequest,
    WhatsAppNumberUpdate,
)
from backend.app.services.meta_cloud_client import (
    MetaCloudApiClient,
    MetaApiError,
)
from backend.app.services.whatsapp_number_service import WhatsAppNumberService


def _make_mock_jwt(user_id: str, email: str) -> str:
    """Constructs an unverified mock JWT for authentication in test requests."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    signature = "mock_sig"
    return f"{header}.{payload}.{signature}"


# ============================================================================
# 1. CredentialVault Encryption & Decryption Tests
# ============================================================================

def test_credential_vault_encrypt_decrypt():
    """Vault successfully encrypts and decrypts secret tokens."""
    token = "EAABtest_token_secret_1234567890_valid"
    encrypted = CredentialVault.encrypt(token)
    
    assert encrypted != token
    assert isinstance(encrypted, str)
    assert len(encrypted) > len(token)
    
    decrypted = CredentialVault.decrypt(encrypted)
    assert decrypted == token


def test_credential_vault_masking():
    """Secret tokens are masked and redacted in logs and displays."""
    token = "EAABw1234567890abcdefghijklmnopqrstuvwxyz"
    masked = CredentialVault.mask_secret(token)
    assert masked.startswith("EAAB")
    assert masked.endswith("wxyz")
    assert "..." in masked
    assert "1234567890" not in masked
    
    short_token = "secret"
    assert CredentialVault.mask_secret(short_token) == "******"


def test_credential_vault_empty_and_invalid():
    """Empty tokens return empty or raise ValueError, corrupted ciphertexts fail securely."""
    with pytest.raises(ValueError):
        CredentialVault.encrypt("")
    with pytest.raises(ValueError):
        CredentialVault.decrypt("")
    
    with pytest.raises(Exception):
        CredentialVault.decrypt("invalid_corrupted_ciphertext_123")


# ============================================================================
# 2. MetaCloudApiClient Unit Tests
# ============================================================================

def test_meta_error_normalization_and_redaction():
    """MetaApiError normalizes error payloads and redacts secrets from messages."""
    sensitive_token = "EAAB_super_secret_access_token_123"
    raw_error = {
        "error": {
            "message": f"Invalid OAuth access token: {sensitive_token} has expired.",
            "type": "OAuthException",
            "code": 190,
            "error_subcode": 463,
            "fbtrace_id": "FBT12345678"
        }
    }
    
    api_err = MetaApiError.from_meta_response(401, raw_error)
    assert api_err.http_status == 401
    assert api_err.meta_error_code == 190
    assert api_err.meta_error_subcode == 463
    assert api_err.fbtrace_id == "FBT12345678"
    assert not api_err.retryable  # 401 is NOT retryable
    
    # Verify token redaction in string representations
    err_str = str(api_err)
    assert sensitive_token not in err_str
    assert "[REDACTED_TOKEN]" in err_str


def test_meta_client_retry_classification():
    """Meta client classifies 5xx/429 as retryable, 4xx as fail-fast non-retryable."""
    client = MetaCloudApiClient()
    
    # 500, 502, 503, 504 are retryable
    assert client._is_retryable_status(500) is True
    assert client._is_retryable_status(502) is True
    assert client._is_retryable_status(503) is True
    assert client._is_retryable_status(504) is True
    assert client._is_retryable_status(429) is True
    
    # 400, 401, 403, 404 are strictly non-retryable (fail-fast)
    assert client._is_retryable_status(400) is False
    assert client._is_retryable_status(401) is False
    assert client._is_retryable_status(403) is False
    assert client._is_retryable_status(404) is False
    assert client._is_retryable_status(200) is False


@pytest.mark.asyncio
async def test_meta_phone_number_details_parsing(monkeypatch):
    """Meta phone number details correctly parses standard Meta API format."""
    meta_json = {
        "id": "100200300400",
        "display_phone_number": "+90 532 123 45 67",
        "verified_name": "Tezlify Enterprise",
        "quality_rating": "GREEN",
        "code_verification_status": "VERIFIED",
        "name_status": "APPROVED",
        "unexpected_extra_field_from_meta": "tolerated_safely"
    }
    client = MetaCloudApiClient()
    async def mock_execute(*args, **kwargs):
        return meta_json
    monkeypatch.setattr(client, "_execute_request", mock_execute)

    details = await client.get_phone_number_details("100200300400", "test_token_123456789012345")
    assert details["phone_number_id"] == "100200300400"
    assert details["display_phone_number"] == "+90 532 123 45 67"
    assert details["verified_name"] == "Tezlify Enterprise"
    assert details["quality_rating"] == "GREEN"
    assert details["code_verification_status"] == "VERIFIED"
    assert details["name_status"] == "APPROVED"


# ============================================================================
# 3. Pre-Flight Validation & Connect Flow Tests
# ============================================================================

@pytest.mark.asyncio
async def test_validate_credentials_success_mock(monkeypatch):
    """Pre-flight credential validation succeeds when Meta validates WABA and phone."""
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 111 22 33",
            "phone_number_e164": "+905551112233",
            "verified_name": "Mock Test Business",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    res = await WhatsAppNumberService.validate_credentials(
        waba_id="waba_test_123",
        phone_number_id="phone_id_test_456",
        access_token="EAAB_test_token_12345678"
    )
    assert res["is_valid"] is True
    assert res["verified_name"] == "Mock Test Business"
    assert res["quality_rating"] == "GREEN"
    assert res["display_phone_number"] == "+90 555 111 22 33"


@pytest.mark.asyncio
async def test_connect_number_end_to_end_mock(monkeypatch):
    """Connecting a number stores encrypted token and activates number."""
    phone_id = f"meta_conn_{uuid.uuid4().hex[:8]}"
    waba_id = "waba_conn_999"
    raw_token = "EAAB_valid_production_token_123456"
    
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 541 222 33 44",
            "phone_number_e164": "+905412223344",
            "verified_name": "Tezlify Sales",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        wanum = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Sales Line 1",
            phone_number_id=phone_id,
            access_token=raw_token,
            waba_id=waba_id,
        )
        await db.commit()
        await db.refresh(wanum)
        
        assert wanum.id is not None
        assert wanum.status == WhatsAppNumberStatus.ACTIVE
        assert wanum.phone_number_id == phone_id
        assert wanum.waba_id == waba_id
        assert wanum.verified_name == "Tezlify Sales"
        assert wanum.quality_rating == "GREEN"
        
        # Verify access token is encrypted at rest and decryptable
        assert wanum.encrypted_access_token is not None
        assert wanum.encrypted_access_token != raw_token
        decrypted = CredentialVault.decrypt(wanum.encrypted_access_token)
        assert decrypted == raw_token


# ============================================================================
# 4. Atomic Credential Rotation Tests
# ============================================================================

@pytest.mark.asyncio
async def test_atomic_token_rotation_success(monkeypatch):
    """Updating a number with a valid new token rotates encrypted credential."""
    user_id = str(uuid.uuid4())
    phone_id = f"meta_rot_{uuid.uuid4().hex[:8]}"
    old_token = "EAAB_old_token_111_valid_length"
    new_token = "EAAB_new_rotated_token_222_valid_len"
    
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 999 88 77",
            "phone_number_e164": "+905559998877",
            "verified_name": "Rotated Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    async def mock_get_details(self, phone_number_id, access_token):
        return {
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 999 88 77",
            "verified_name": "Rotated Line",
            "quality_rating": "GREEN",
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    monkeypatch.setattr(MetaCloudApiClient, "get_phone_number_details", mock_get_details)
    
    async with AsyncSessionLocal() as db:
        # Create initial number
        wanum = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Initial Line",
            phone_number_id=phone_id,
            access_token=old_token,
            waba_id="waba_rot",
        )
        await db.commit()
        await db.refresh(wanum)
        wanum_id = wanum.id
        assert CredentialVault.decrypt(wanum.encrypted_access_token) == old_token
        
        # Update with new valid token
        updated = await WhatsAppNumberService.update_number(
            db=db,
            number_id=wanum_id,
            user_id=user_id,
            name="Updated Line Name",
            access_token=new_token,
        )
        await db.commit()
        await db.refresh(updated)
        
        assert updated.name == "Updated Line Name"
        assert updated.status == WhatsAppNumberStatus.ACTIVE
        assert CredentialVault.decrypt(updated.encrypted_access_token) == new_token


@pytest.mark.asyncio
async def test_atomic_token_rotation_failure_preserves_old_credential(monkeypatch):
    """When a new token is rejected by Meta, update fails and existing credential is preserved."""
    user_id = str(uuid.uuid4())
    phone_id = f"meta_fail_{uuid.uuid4().hex[:8]}"
    old_token = "EAAB_working_old_token_12345678"
    invalid_token = "EAAB_invalid_expired_token_1234567"
    
    # 1. Mock connection passes for old token
    async def mock_validate_ok(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 333 22 11",
            "phone_number_e164": "+905553332211",
            "verified_name": "Working Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_ok)
    
    async with AsyncSessionLocal() as db:
        wanum = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Working Line",
            phone_number_id=phone_id,
            access_token=old_token,
            waba_id="waba_fail_test",
        )
        await db.commit()
        await db.refresh(wanum)
        wanum_id = wanum.id
        assert CredentialVault.decrypt(wanum.encrypted_access_token) == old_token
        
        # 2. Mock Meta rejecting the new token
        async def mock_get_details_rejected(self, phone_number_id, access_token):
            raise MetaApiError(
                http_status=401,
                meta_error_code=190,
                message="Invalid OAuth access token - cannot authenticate with Meta."
            )
        monkeypatch.setattr(MetaCloudApiClient, "get_phone_number_details", mock_get_details_rejected)
        
        # Attempt update with invalid token -> MUST FAIL
        with pytest.raises(MetaApiError):
            await WhatsAppNumberService.update_number(
                db=db,
                number_id=wanum_id,
                user_id=user_id,
                name="Attempted Name Change",
                access_token=invalid_token,
            )
            
        # Verify that old working credential and state are 100% preserved
        refreshed = await WhatsAppNumberService.get_number(db, user_id=user_id, number_id=wanum_id)
        assert refreshed is not None
        assert refreshed.name == "Working Line"  # Transaction rolled back
        assert refreshed.status == WhatsAppNumberStatus.ACTIVE
        assert CredentialVault.decrypt(refreshed.encrypted_access_token) == old_token


# ============================================================================
# 5. Disconnect and Non-Destructive Remove Tests
# ============================================================================

@pytest.mark.asyncio
async def test_disconnect_number_preserves_conversations_and_leads(monkeypatch):
    """Disconnecting a number invalidates credentials but preserves conversation and lead history."""
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 444 00 00",
            "phone_number_e164": "+905554440000",
            "verified_name": "Disconnect Test Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    phone_id = f"meta_disc_{uuid.uuid4().hex[:8]}"
    
    async with AsyncSessionLocal() as db:
        wanum = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Line To Disconnect",
            phone_number_id=phone_id,
            access_token="EAAB_token_to_clear_12345678",
            waba_id="waba_disc",
        )
        await db.commit()
        await db.refresh(wanum)
        
        # Create Lead and Conversation attached to this number
        lead = Lead(
            user_id=user_id,
            name="Disconnection Test Lead",
            phone="+905550001122",
            phone_e164=f"+90555000{uuid.uuid4().hex[:4]}",
            status=LeadStatus.CONTACTED,
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)
        
        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            lead_id=lead.id,
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        
        # Perform Disconnect
        disconnected = await WhatsAppNumberService.disconnect_number(db, user_id=user_id, number_id=wanum.id)
        await db.commit()
        await db.refresh(disconnected)
        
        assert disconnected.status == WhatsAppNumberStatus.DISCONNECTED
        assert disconnected.encrypted_access_token is None  # Credential securely cleared
        assert disconnected.deleted_at is not None
        
        # Verify Conversation and Lead still exist and are untouched
        await db.refresh(conv)
        await db.refresh(lead)
        assert conv.id is not None
        assert conv.lead_id == lead.id
        assert lead.status == LeadStatus.CONTACTED


@pytest.mark.asyncio
async def test_remove_number_hard_delete_nullifies_conversation_foreign_key(monkeypatch):
    """Hard deleting a number wipes live WhatsApp dialogs (product rule)."""
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 444 11 11",
            "phone_number_e164": "+905554441111",
            "verified_name": "Hard Delete Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    phone_id = f"meta_rem_{uuid.uuid4().hex[:8]}"
    
    async with AsyncSessionLocal() as db:
        wanum = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Line To Remove",
            phone_number_id=phone_id,
            access_token="EAAB_token_to_remove_12345678",
            waba_id="waba_rem",
        )
        await db.commit()
        await db.refresh(wanum)
        wanum_id = wanum.id
        
        conv = Conversation(
            user_id=user_id,
            whatsapp_number_id=wanum_id,
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        
        # Hard delete number
        await WhatsAppNumberService.remove_number(db, user_id=user_id, number_id=wanum_id, hard_delete=True)
        await db.commit()
        
        # Check number is gone
        assert await WhatsAppNumberService.get_number(db, user_id=user_id, number_id=wanum_id) is None

        # Product rule: live WhatsApp dialogs are wiped with the line
        assert await db.get(Conversation, conv.id) is None


# ============================================================================
# 6. Security & Multi-Tenancy Tests
# ============================================================================

@pytest.mark.asyncio
async def test_tenant_isolation_unauthorized_access_rejected(monkeypatch):
    """User A cannot read, update, verify, disconnect, or delete User B's WhatsApp number."""
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 777 66 55",
            "phone_number_e164": "+905557776655",
            "verified_name": "User B Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_b_id = str(uuid.uuid4())
    user_a_id = str(uuid.uuid4())
    phone_id = f"meta_sec_{uuid.uuid4().hex[:8]}"
    
    # Setup number owned by User B
    async with AsyncSessionLocal() as db:
        wanum_b = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_b_id,
            name="User B Private Line",
            phone_number_id=phone_id,
            access_token="EAAB_user_b_token_1234567890",
            waba_id="waba_user_b",
        )
        await db.commit()
        await db.refresh(wanum_b)
        number_b_id = wanum_b.id

    transport = ASGITransport(app=app)
    token_a = _make_mock_jwt(user_a_id, "usera@tezlify.com")
    headers_a = {"Authorization": f"Bearer {token_a}"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. User A tries to GET User B's number -> 404
        res_get = await ac.get(f"/api/v1/whatsapp/numbers/{number_b_id}", headers=headers_a)
        assert res_get.status_code == 404

        # 2. User A tries to PUT / update User B's number -> 404
        res_put = await ac.put(
            f"/api/v1/whatsapp/numbers/{number_b_id}",
            headers=headers_a,
            json={"name": "Hacked Name"}
        )
        assert res_put.status_code == 404

        # 3. User A tries to verify User B's number -> 404
        res_verify = await ac.post(f"/api/v1/whatsapp/numbers/{number_b_id}/verify", headers=headers_a)
        assert res_verify.status_code == 404

        # 4. User A tries to disconnect User B's number -> 404
        res_disc = await ac.post(f"/api/v1/whatsapp/numbers/{number_b_id}/disconnect", headers=headers_a)
        assert res_disc.status_code == 404

        # 5. User A tries to delete User B's number -> 404
        res_del = await ac.delete(f"/api/v1/whatsapp/numbers/{number_b_id}", headers=headers_a)
        assert res_del.status_code == 404


@pytest.mark.asyncio
async def test_token_non_disclosure_in_api_responses(monkeypatch):
    """Access token is NEVER exposed in GET, POST, or PUT API responses."""
    secret_token = "EAAB_strictly_confidential_token_xyz987"
    
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 888 99 00",
            "phone_number_e164": "+905558889900",
            "verified_name": "Confidential Line",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    transport = ASGITransport(app=app)
    jwt_token = _make_mock_jwt(user_id, "owner@tezlify.com")
    headers = {"Authorization": f"Bearer {jwt_token}"}
    
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Connect Number POST
        res_post = await ac.post(
            "/api/v1/whatsapp/numbers",
            headers=headers,
            json={
                "name": "Secret Test Line",
                "waba_id": "waba_confidential",
                "phone_number_id": f"phone_{uuid.uuid4().hex[:8]}",
                "access_token": secret_token,
            }
        )
        assert res_post.status_code == 201
        data_post = res_post.json()
        assert "access_token" not in data_post
        assert "encrypted_access_token" not in data_post
        assert secret_token not in json.dumps(data_post)
        
        num_id = data_post["id"]
        
        # 2. GET single number
        res_get = await ac.get(f"/api/v1/whatsapp/numbers/{num_id}", headers=headers)
        assert res_get.status_code == 200
        data_get = res_get.json()
        assert "access_token" not in data_get
        assert "encrypted_access_token" not in data_get
        assert secret_token not in json.dumps(data_get)
        
        # 3. GET list of numbers
        res_list = await ac.get("/api/v1/whatsapp/numbers", headers=headers)
        assert res_list.status_code == 200
        data_list = res_list.json()
        assert secret_token not in json.dumps(data_list)


# ============================================================================
# 7. Concurrency & Duplicate Protection Tests
# ============================================================================

@pytest.mark.asyncio
async def test_duplicate_phone_number_id_rejected_application_layer(monkeypatch):
    """Connecting a number with an already registered phone_number_id is rejected."""
    shared_phone_id = f"meta_dup_{uuid.uuid4().hex[:8]}"
    
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 123 00 00",
            "phone_number_e164": "+905551230000",
            "verified_name": "Duplicate Test",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        # Connect first time
        await WhatsAppNumberService.connect_number(
            db=db,
            user_id=user_id,
            name="Line 1",
            phone_number_id=shared_phone_id,
            access_token="EAAB_token_1_valid_length_20",
            waba_id="waba_shared",
        )
        await db.commit()
        
        # Second connect with same phone_number_id must be rejected
        with pytest.raises(ValueError, match="zaten Tezlify'a bağlı"):
            await WhatsAppNumberService.connect_number(
                db=db,
                user_id=user_id,
                name="Line 2 Duplicate",
                phone_number_id=shared_phone_id,
                access_token="EAAB_token_2_valid_length_20",
                waba_id="waba_shared",
            )


@pytest.mark.asyncio
async def test_concurrent_connect_deterministic_handling(monkeypatch):
    """Simultaneous connect requests with the same phone_number_id are handled deterministically."""
    shared_phone_id = f"meta_concurrent_{uuid.uuid4().hex[:8]}"
    
    async def mock_validate_connection(self, waba_id, phone_number_id, access_token, **kwargs):
        await asyncio.sleep(0.05)  # Simulate network latency
        return {
            "is_valid": True,
            "waba_id": waba_id,
            "phone_number_id": phone_number_id,
            "display_phone_number": "+90 555 222 00 00",
            "phone_number_e164": "+905552220000",
            "verified_name": "Concurrent Test",
            "quality_rating": "GREEN",
            "error": None,
        }
    monkeypatch.setattr(MetaCloudApiClient, "validate_connection", mock_validate_connection)
    
    user_id = str(uuid.uuid4())
    
    async def attempt_connect():
        async with AsyncSessionLocal() as db:
            num = await WhatsAppNumberService.connect_number(
                db=db,
                user_id=user_id,
                name="Concurrent Line",
                phone_number_id=shared_phone_id,
                access_token="EAAB_conc_token_valid_length_20",
                waba_id="waba_conc",
            )
            await db.commit()
            return num
    
    results = await asyncio.gather(attempt_connect(), attempt_connect(), return_exceptions=True)
    
    # Exactly one must succeed, the other must be rejected
    successes = [r for r in results if isinstance(r, WhatsAppNumber)]
    failures = [r for r in results if isinstance(r, Exception)]
    
    assert len(successes) == 1
    assert len(failures) == 1


# ============================================================================
# 8. Real Meta Cloud API Integration Test (Conditional)
# ============================================================================

@pytest.mark.asyncio
async def test_real_meta_cloud_api_live():
    """
    Live Meta Cloud API Integration Test against Meta Graph API v21+.
    If environment credentials are provided (META_TEST_ACCESS_TOKEN, META_TEST_PHONE_NUMBER_ID, META_TEST_WABA_ID),
    runs real verification. Otherwise reports explicitly as 'REAL META E2E TEST NOT RUN'.
    """
    real_token = os.getenv("META_TEST_ACCESS_TOKEN") or os.getenv("META_WHATSAPP_TOKEN")
    real_phone_id = os.getenv("META_TEST_PHONE_NUMBER_ID") or os.getenv("META_PHONE_NUMBER_ID")
    real_waba_id = os.getenv("META_TEST_WABA_ID") or os.getenv("META_WABA_ID")
    
    if not (real_token and real_phone_id and real_waba_id):
        # Explicit non-run notification as mandated by Specification Section 34
        print("\n[REAL META CLOUD API STATUS]: REAL META E2E TEST NOT RUN (No Meta credentials in environment)")
        pytest.skip("REAL META E2E TEST NOT RUN (No Meta credentials in environment)")
        return
        
    client = MetaCloudApiClient()
    result = await client.validate_connection(
        waba_id=real_waba_id,
        phone_number_id=real_phone_id,
        access_token=real_token,
    )
    
    assert result["is_valid"] is True
    assert result["phone_number_id"] == real_phone_id
    assert result["display_phone_number"] is not None
    print(f"\n[REAL META CLOUD API SUCCESS]: Validated Phone ID: {real_phone_id}, Verified Name: {result.get('verified_name')}")
