"""
Application Service managing Meta WhatsApp Cloud API Numbers.

Enforces:
- Multi-tenant isolation (user_id ownership).
- Uniqueness of Meta phone_number_id (database & application level).
- Real Meta Graph API validation before activation.
- Secure token encryption via CredentialVault (never stored plaintext, never leaked).
- Atomic credential rotation (failed new token never destroys existing working credential).
- Deletion semantics (product rule): removing a number wipes the tenant's live
  WhatsApp dialogs (Conversations + auto-synced WhatsApp Leads) and purges the
  linked Baileys gateway session(s), so the next "QR ile bağla" always starts
  from a fresh QR code and no orphaned chat survives. Disconnect only flips
  status and preserves history.
"""
import hashlib
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus, WhatsAppNumberProvider
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.phone_service import PhoneService
from backend.app.core.auth import get_user_filter
from backend.app.core.credential_vault import CredentialVault
from backend.app.services.meta_cloud_client import MetaCloudApiClient, MetaApiError

logger = logging.getLogger(__name__)


class DuplicatePhoneNumberIdError(ValueError):
    """Raised when an attempt is made to bind an existing Meta phone_number_id."""
    def __init__(self, phone_number_id: str):
        super().__init__(f"Bu WhatsApp hattı (Phone Number ID: '{phone_number_id}') zaten Tezlify'a bağlı.")
        self.phone_number_id = phone_number_id


class WhatsAppNumberNotFoundError(ValueError, KeyError):
    """Raised when the requested number is not found or belongs to another tenant."""
    def __init__(self, number_id: int):
        super().__init__(f"WhatsApp number with ID {number_id} was not found or access denied.")
        self.number_id = number_id


class WhatsAppNumberGatewayError(RuntimeError):
    """Raised when the live Baileys gateway session cannot be purged.

    Deletion is fail-closed: reporting success while the gateway session
    survives would resurrect the old line (via chats-synced webhooks) and
    reconnect it without a fresh QR scan.
    """


class WhatsAppNumberService:
    """Domain and application operations for WhatsAppNumber."""

    @classmethod
    def generate_credential_reference(cls, user_id: Optional[str], phone_number_id: str, token: str) -> str:
        """
        Generates a secure, deterministic vault reference for Meta access token.
        Token is NEVER stored plaintext in the database.
        """
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
        return f"vault:meta:{phone_number_id}:{token_hash}"

    @classmethod
    async def validate_credentials(
        cls,
        waba_id: str,
        phone_number_id: str,
        access_token: str,
    ) -> Dict[str, Any]:
        """
        Validates the provided Meta credentials against Meta Graph API.
        Verifies phone number existence, WABA relationship, and permissions.
        """
        client = MetaCloudApiClient()
        return await client.validate_connection(
            waba_id=waba_id,
            phone_number_id=phone_number_id,
            access_token=access_token,
        )

    @classmethod
    async def connect_number(
        cls,
        db: AsyncSession,
        user_id: Optional[str],
        name: str,
        waba_id: str,
        phone_number_id: str,
        access_token: str,
        business_account_id: Optional[str] = None,
        skip_meta_validation: bool = False,
    ) -> WhatsAppNumber:
        """
        Connects a new Meta WhatsApp Business number.
        Pre-flight verifies via Meta Graph API, encrypts access token,
        and activates the number in the database.
        """
        clean_phone_id = str(phone_number_id).strip()
        clean_waba_id = str(waba_id).strip()
        clean_name = str(name).strip()
        clean_token = str(access_token).strip()

        if not clean_phone_id:
            raise ValueError("Phone Number ID cannot be empty.")
        if not clean_token:
            raise ValueError("Access Token cannot be empty.")

        # Check existing phone_number_id in DB across all tenants
        stmt = select(WhatsAppNumber).where(WhatsAppNumber.phone_number_id == clean_phone_id)
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if existing:
            raise DuplicatePhoneNumberIdError(clean_phone_id)

        # Meta validation
        display_phone = ""
        verified_name = None
        quality_rating = "UNKNOWN"

        if not skip_meta_validation:
            validation_res = await cls.validate_credentials(
                waba_id=clean_waba_id,
                phone_number_id=clean_phone_id,
                access_token=clean_token,
            )
            display_phone = validation_res.get("display_phone_number") or ""
            verified_name = validation_res.get("verified_name")
            quality_rating = validation_res.get("quality_rating") or "UNKNOWN"

        if not display_phone:
            display_phone = clean_phone_id

        # Normalize phone to E.164
        parsed = PhoneService.normalize_to_e164(display_phone)
        phone_e164 = parsed["e164"] if parsed and parsed.get("is_valid") else display_phone.replace(" ", "")

        # Encrypt token securely
        encrypted_token = CredentialVault.encrypt_token(clean_token)
        cred_ref = cls.generate_credential_reference(user_id, clean_phone_id, clean_token)

        number = WhatsAppNumber(
            user_id=user_id,
            name=clean_name,
            provider=WhatsAppNumberProvider.META_CLOUD,
            display_phone_number=display_phone,
            phone_number_e164=phone_e164,
            phone_number_id=clean_phone_id,
            waba_id=clean_waba_id if clean_waba_id else None,
            business_account_id=business_account_id.strip() if business_account_id else None,
            credential_reference=cred_ref,
            encrypted_access_token=encrypted_token,
            status=WhatsAppNumberStatus.ACTIVE,
            quality_rating=quality_rating,
            verified_name=verified_name,
            last_verified_at=datetime.utcnow(),
        )

        db.add(number)
        await db.flush()
        logger.info(f"[WhatsAppNumberService] Successfully connected number: id={number.id}, phone_id={clean_phone_id}")
        return number

    @classmethod
    async def create_number(
        cls,
        db: AsyncSession,
        user_id: Optional[str],
        name: str,
        display_phone_number: str,
        phone_number_id: str,
        waba_id: Optional[str] = None,
        business_account_id: Optional[str] = None,
        access_token: Optional[str] = None,
        verified_name: Optional[str] = None,
        quality_rating: Optional[str] = "UNKNOWN",
    ) -> WhatsAppNumber:
        """
        Creates and persists a new WhatsAppNumber without external Meta network call
        (for tests and internal provisioning).
        """
        clean_phone_id = str(phone_number_id).strip()
        if not clean_phone_id:
            raise ValueError("phone_number_id cannot be empty.")

        stmt = select(WhatsAppNumber).where(WhatsAppNumber.phone_number_id == clean_phone_id)
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if existing:
            raise DuplicatePhoneNumberIdError(clean_phone_id)

        parsed = PhoneService.normalize_to_e164(display_phone_number)
        phone_e164 = parsed["e164"] if parsed and parsed.get("is_valid") else display_phone_number.strip().replace(" ", "")

        cred_ref = None
        encrypted_token = None
        if access_token:
            cred_ref = cls.generate_credential_reference(user_id, clean_phone_id, access_token)
            encrypted_token = CredentialVault.encrypt_token(access_token)

        number = WhatsAppNumber(
            user_id=user_id,
            name=name.strip(),
            provider=WhatsAppNumberProvider.META_CLOUD,
            display_phone_number=display_phone_number.strip(),
            phone_number_e164=phone_e164,
            phone_number_id=clean_phone_id,
            waba_id=waba_id.strip() if waba_id else None,
            business_account_id=business_account_id.strip() if business_account_id else None,
            credential_reference=cred_ref,
            encrypted_access_token=encrypted_token,
            status=WhatsAppNumberStatus.ACTIVE,
            quality_rating=quality_rating or "UNKNOWN",
            verified_name=verified_name.strip() if verified_name else None,
            last_verified_at=datetime.utcnow() if access_token else None,
        )

        db.add(number)
        await db.flush()
        return number

    @classmethod
    async def get_number(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str] = None,
    ) -> Optional[WhatsAppNumber]:
        """Fetches a number by ID enforcing tenant isolation."""
        stmt = select(WhatsAppNumber).where(WhatsAppNumber.id == number_id)
        if user_id:
            stmt = stmt.where(get_user_filter(WhatsAppNumber.user_id, user_id))
        res = await db.execute(stmt)
        return res.scalar_one_or_none()

    get_number_by_id = get_number

    @classmethod
    async def get_by_phone_number_id(
        cls,
        db: AsyncSession,
        phone_number_id: str,
    ) -> Optional[WhatsAppNumber]:
        """Resolves number by Meta Graph API phone_number_id (for webhook routing)."""
        stmt = select(WhatsAppNumber).where(WhatsAppNumber.phone_number_id == phone_number_id.strip())
        res = await db.execute(stmt)
        return res.scalar_one_or_none()

    @classmethod
    async def list_numbers(
        cls,
        db: AsyncSession,
        user_id: Optional[str] = None,
        status: Optional[WhatsAppNumberStatus] = None,
    ) -> List[WhatsAppNumber]:
        """Lists WhatsApp numbers for tenant with optional status filtering."""
        stmt = select(WhatsAppNumber)
        if user_id:
            stmt = stmt.where(get_user_filter(WhatsAppNumber.user_id, user_id))
        if status:
            stmt = stmt.where(WhatsAppNumber.status == status)
        stmt = stmt.order_by(WhatsAppNumber.created_at.asc())
        res = await db.execute(stmt)
        return list(res.scalars().all())

    @classmethod
    async def verify_number(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str],
        skip_meta_call: bool = False,
    ) -> Dict[str, Any]:
        """
        Tests live connection health.
        For META_CLOUD: calls Meta Graph API using stored encrypted credential.
        For BAILEYS_QR: checks status of linked WhatsAppSession.
        Updates last_verified_at, verified_name, quality_rating, and status.
        """
        number = await cls.get_number(db, number_id, user_id)
        if not number:
            raise WhatsAppNumberNotFoundError(number_id)

        if number.provider == WhatsAppNumberProvider.BAILEYS_QR:
            from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
            stmt = select(WhatsAppSession).where(WhatsAppSession.whatsapp_number_id == number.id)
            sess = (await db.execute(stmt)).scalar_one_or_none()
            is_active = sess is not None and sess.status == SessionStatus.CONNECTED
            number.status = WhatsAppNumberStatus.ACTIVE if is_active else WhatsAppNumberStatus.DISCONNECTED
            number.last_verified_at = datetime.utcnow()
            number.updated_at = datetime.utcnow()
            await db.flush()
            return {
                "id": number.id,
                "status": number.status,
                "verified": is_active,
                "verified_name": number.name,
                "quality_rating": "GREEN" if is_active else "UNKNOWN",
                "last_verified_at": number.last_verified_at,
            }

        if not number.encrypted_access_token:
            number.status = WhatsAppNumberStatus.ERROR
            number.updated_at = datetime.utcnow()
            await db.flush()
            raise ValueError("Kayıtlı erişim token'ı bulunamadı. Lütfen token'ı yenileyin.")

        raw_token = CredentialVault.decrypt_token(number.encrypted_access_token)

        if not skip_meta_call:
            try:
                client = MetaCloudApiClient()
                details = await client.get_phone_number_details(number.phone_number_id, raw_token)
                number.verified_name = details.get("verified_name") or number.verified_name
                number.quality_rating = details.get("quality_rating") or number.quality_rating
                number.status = WhatsAppNumberStatus.ACTIVE
                number.last_verified_at = datetime.utcnow()
                number.updated_at = datetime.utcnow()
                await db.flush()
                return {
                    "id": number.id,
                    "status": number.status,
                    "verified": True,
                    "verified_name": number.verified_name,
                    "quality_rating": number.quality_rating,
                    "last_verified_at": number.last_verified_at,
                }
            except MetaApiError as e:
                number.status = WhatsAppNumberStatus.ERROR
                number.updated_at = datetime.utcnow()
                await db.flush()
                raise e

        number.status = WhatsAppNumberStatus.ACTIVE
        number.last_verified_at = datetime.utcnow()
        await db.flush()
        return {
            "id": number.id,
            "status": number.status,
            "verified": True,
            "verified_name": number.verified_name,
            "quality_rating": number.quality_rating,
            "last_verified_at": number.last_verified_at,
        }

    @classmethod
    async def update_number(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str],
        name: Optional[str] = None,
        display_phone_number: Optional[str] = None,
        waba_id: Optional[str] = None,
        status: Optional[WhatsAppNumberStatus] = None,
        access_token: Optional[str] = None,
        verified_name: Optional[str] = None,
        quality_rating: Optional[str] = None,
        skip_meta_validation: bool = False,
    ) -> WhatsAppNumber:
        """
        Updates number metadata.
        Supports atomic token rotation: If new access_token is provided, it is validated
        against Meta first. If validation fails, the existing working credential is kept intact!
        """
        number = await cls.get_number(db, number_id, user_id)
        if not number:
            raise WhatsAppNumberNotFoundError(number_id)

        # 1. Atomic Token Rotation: Validate new token with Meta FIRST before making any mutations
        new_encrypted_token = None
        new_cred_ref = None
        meta_verified_name = None
        meta_quality = None

        if access_token:
            clean_token = access_token.strip()
            if not skip_meta_validation:
                client = MetaCloudApiClient()
                details = await client.get_phone_number_details(number.phone_number_id, clean_token)
                meta_verified_name = details.get("verified_name")
                meta_quality = details.get("quality_rating")
            new_encrypted_token = CredentialVault.encrypt_token(clean_token)
            new_cred_ref = cls.generate_credential_reference(user_id, number.phone_number_id, clean_token)

        # 2. Only after validation succeeds, apply all field updates
        if name is not None:
            number.name = name.strip()
        if display_phone_number is not None:
            number.display_phone_number = display_phone_number.strip()
            parsed = PhoneService.normalize_to_e164(display_phone_number)
            if parsed and parsed.get("is_valid"):
                number.phone_number_e164 = parsed["e164"]
        if waba_id is not None:
            number.waba_id = waba_id.strip() if waba_id else None
        if verified_name is not None:
            number.verified_name = verified_name.strip() if verified_name else None
        elif meta_verified_name:
            number.verified_name = meta_verified_name
        if quality_rating is not None:
            number.quality_rating = quality_rating
        elif meta_quality:
            number.quality_rating = meta_quality
        if status is not None:
            number.status = status

        if new_encrypted_token:
            number.encrypted_access_token = new_encrypted_token
            number.credential_reference = new_cred_ref
            number.status = WhatsAppNumberStatus.ACTIVE
            number.last_verified_at = datetime.utcnow()

        number.updated_at = datetime.utcnow()
        await db.flush()
        return number

    @classmethod
    async def disconnect_number(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str],
    ) -> WhatsAppNumber:
        """
        Disconnects a number: sets status to DISCONNECTED, invalidates active credential.
        Preserves all Conversations, Messages, Contacts, and Leads intact.
        """
        number = await cls.get_number(db, number_id, user_id)
        if not number:
            raise WhatsAppNumberNotFoundError(number_id)

        number.status = WhatsAppNumberStatus.DISCONNECTED
        number.deleted_at = datetime.utcnow()
        number.updated_at = datetime.utcnow()
        # Invalidate credential reference
        number.encrypted_access_token = None

        # If linked to a WhatsAppSession, also update session status
        from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
        stmt = select(WhatsAppSession).where(WhatsAppSession.whatsapp_number_id == number.id)
        sess = (await db.execute(stmt)).scalar_one_or_none()
        if sess:
            sess.status = SessionStatus.DISCONNECTED
            sess.is_phone_online = False
            sess.updated_at = datetime.utcnow()

        await db.flush()
        return number

    @classmethod
    async def remove_number_safely(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str],
    ) -> Dict[str, Any]:
        """
        Removes a WhatsApp line with full live-dialog cleanup (product rule).

        Steps:
        1. Purges every Baileys gateway session linked to this number
           (tenant-aware; fail-closed via WhatsAppNumberGatewayError).
        2. Deletes the linked WhatsAppSession rows + auth backups + sync
           revision cache, so the next "QR ile bağla" cannot resurrect the
           old pairing and always starts from a fresh QR code.
        3. Deletes ALL live WhatsApp dialogs of the tenant (Conversations
           cascade to Messages) and all auto-synced WhatsApp Leads —
           including unclaimed (user_id NULL) rows, which the inbox also shows.
        4. Deletes the WhatsAppNumber row itself.

        Returns {"purged_session_names": [...]} for post-commit broadcasting.
        """
        import os
        from sqlalchemy import or_
        from backend.app.core.config import settings
        from backend.app.models.conversation import Conversation
        from backend.app.models.lead import Lead
        from backend.app.models.whatsapp_session import WhatsAppSession, WhatsAppSessionAuth
        from backend.app.services.whatsapp_chat_sync_service import WhatsAppChatSyncService
        from backend.app.services.whatsapp_gateway_client import gateway_client

        number = await cls.get_number(db, number_id, user_id)
        if not number:
            raise WhatsAppNumberNotFoundError(number_id)

        owner_id = number.user_id or user_id

        linked_sess_stmt = select(WhatsAppSession).where(
            WhatsAppSession.whatsapp_number_id == number.id
        )
        linked_sessions = (await db.execute(linked_sess_stmt)).scalars().all()

        # 1. Purge live gateway sessions first (fail-closed for BAILEYS_QR).
        if (
            number.provider == WhatsAppNumberProvider.BAILEYS_QR
            and not settings.SIMULATION_MODE
            and os.getenv("PYTEST_CURRENT_TEST") is None
        ):
            for sess in linked_sessions:
                purged = await gateway_client.delete_session(
                    sess.session_name,
                    tenant_id=str(owner_id) if owner_id else None,
                    session_id=sess.id,
                )
                if not purged:
                    raise WhatsAppNumberGatewayError(
                        "WhatsApp hattı gateway üzerinden silinemedi. Lütfen tekrar deneyin."
                    )

        purged_names = [s.session_name for s in linked_sessions]

        # 2. Delete linked session rows + auth backups.
        for sess in linked_sessions:
            auth_row = (
                await db.execute(
                    select(WhatsAppSessionAuth).where(
                        WhatsAppSessionAuth.session_name == sess.session_name
                    )
                )
            ).scalar_one_or_none()
            if auth_row:
                await db.delete(auth_row)
            await db.delete(sess)

        # 3. Wipe ALL live WhatsApp dialogs of the tenant (incl. NULL-user rows
        # the inbox displays) and all auto-synced WhatsApp leads.
        conv_stmt = select(Conversation).where(
            Conversation.channel == "WHATSAPP",
            or_(
                get_user_filter(Conversation.user_id, owner_id),
                Conversation.user_id.is_(None),
            ),
        )
        for conv in (await db.execute(conv_stmt)).scalars().all():
            await db.delete(conv)

        lead_stmt = select(Lead).where(
            Lead.category.in_(["WhatsApp Grubu", "WhatsApp Sohbeti", "WhatsApp Kişisi"]),
            or_(
                get_user_filter(Lead.user_id, owner_id),
                Lead.user_id.is_(None),
            ),
        )
        for lead in (await db.execute(lead_stmt)).scalars().all():
            await db.delete(lead)

        for name in purged_names:
            WhatsAppChatSyncService.last_sync_revisions.pop(name, None)

        await db.delete(number)
        await db.flush()
        return {"purged_session_names": purged_names}

    @classmethod
    async def remove_number(
        cls,
        db: AsyncSession,
        number_id: int,
        user_id: Optional[str],
        hard_delete: bool = False,
    ) -> None:
        """Unified deletion/disconnect method (delete wipes live dialogs)."""
        if hard_delete:
            return await cls.remove_number_safely(db, number_id, user_id)
        await cls.disconnect_number(db, number_id, user_id)
        return {"purged_session_names": []}

    @classmethod
    async def create_qr_number(
        cls,
        db: AsyncSession,
        name: str,
        user_id: Optional[str] = None,
        phone_number_e164: Optional[str] = None,
        display_phone_number: Optional[str] = None,
    ) -> WhatsAppNumber:
        """
        Creates a new WhatsAppNumber for Baileys QR transport.
        phone_number_id is intentionally None (Meta Cloud API specific).
        """
        clean_name = name.strip()
        if user_id and clean_name:
            stmt = select(WhatsAppNumber).where(
                get_user_filter(WhatsAppNumber.user_id, user_id),
                WhatsAppNumber.provider == WhatsAppNumberProvider.BAILEYS_QR,
                WhatsAppNumber.name == clean_name,
            )
            existing = (await db.execute(stmt)).scalars().first()
            if existing:
                if phone_number_e164 and not existing.phone_number_e164:
                    existing.phone_number_e164 = phone_number_e164.strip()
                if display_phone_number and not existing.display_phone_number:
                    existing.display_phone_number = display_phone_number.strip()
                existing.status = WhatsAppNumberStatus.ACTIVE
                await db.flush()
                return existing

        number = WhatsAppNumber(
            user_id=user_id,
            name=clean_name,
            provider=WhatsAppNumberProvider.BAILEYS_QR,
            phone_number_id=None,
            display_phone_number=display_phone_number.strip() if display_phone_number else None,
            phone_number_e164=phone_number_e164.strip() if phone_number_e164 else None,
            status=WhatsAppNumberStatus.ACTIVE,
        )
        db.add(number)
        await db.flush()
        return number

    @classmethod
    async def link_session(
        cls,
        db: AsyncSession,
        number_id: int,
        session_id: int,
        user_id: Optional[str] = None,
    ) -> WhatsAppSession:
        """
        Links a WhatsAppSession to a WhatsAppNumber (1:1 relationship).
        Enforces tenant isolation invariant: session.user_id == number.user_id.
        Enforces 1:1 invariant at domain level before DB UNIQUE constraint.
        """
        number = await cls.get_number(db, number_id, user_id)
        if not number:
            raise WhatsAppNumberNotFoundError(number_id)

        stmt = select(WhatsAppSession).where(WhatsAppSession.id == session_id)
        if user_id:
            stmt = stmt.where(get_user_filter(WhatsAppSession.user_id, user_id))
        session_res = await db.execute(stmt)
        session = session_res.scalar_one_or_none()
        if not session:
            raise ValueError(f"Session {session_id} not found or access denied")

        # Tenant isolation invariant
        if number.user_id and session.user_id and str(number.user_id) != str(session.user_id):
            raise ValueError("Tenant isolation violation: session and number must belong to the same tenant")

        # Check if number already has a session linked
        existing_session_stmt = select(WhatsAppSession).where(WhatsAppSession.whatsapp_number_id == number.id)
        existing_session = (await db.execute(existing_session_stmt)).scalar_one_or_none()
        if existing_session and existing_session.id != session.id:
            raise ValueError(f"WhatsAppNumber {number_id} is already linked to session {existing_session.id}")

        session.whatsapp_number_id = number.id
        session.updated_at = datetime.utcnow()
        await db.flush()
        return session

    @classmethod
    async def unlink_session(
        cls,
        db: AsyncSession,
        session_id: int,
        user_id: Optional[str] = None,
    ) -> WhatsAppSession:
        """Unlinks a session from its WhatsAppNumber."""
        stmt = select(WhatsAppSession).where(WhatsAppSession.id == session_id)
        if user_id:
            stmt = stmt.where(get_user_filter(WhatsAppSession.user_id, user_id))
        session = (await db.execute(stmt)).scalar_one_or_none()
        if not session:
            raise ValueError(f"Session {session_id} not found or access denied")

        session.whatsapp_number_id = None
        session.updated_at = datetime.utcnow()
        await db.flush()
        return session
