"""
Application-level Credential Encryption Vault for Meta WhatsApp Cloud API Tokens.

Provides authenticated symmetric encryption (Fernet / AES-128-CBC + HMAC-SHA256)
to ensure Meta permanent access tokens are never persisted plaintext in the database.

Security Invariants:
1. Encryption key is sourced from TEZLIFY_CREDENTIAL_ENCRYPTION_KEY or derived from SECRET_KEY in dev/test.
2. Raw tokens are NEVER logged, serialized into API DTOs, or exposed in error messages.
3. Decryption failures fail securely without leaking ciphertext.
"""
import os
import base64
import hashlib
import logging
from typing import Optional
from cryptography.fernet import Fernet, InvalidToken

from backend.app.core.config import settings

logger = logging.getLogger(__name__)


class CredentialVaultError(Exception):
    """Base exception for credential vault operations."""
    pass


class CredentialDecryptionError(CredentialVaultError):
    """Raised when decrypting a stored credential fails."""
    def __init__(self, message: str = "Failed to decrypt WhatsApp access token. Key mismatch or corrupted ciphertext."):
        super().__init__(message)


class CredentialVault:
    """Service providing encryption and decryption for sensitive third-party tokens."""

    @classmethod
    def _get_fernet_key(cls) -> bytes:
        """
        Resolves the 32-byte URL-safe base64-encoded encryption key.
        """
        raw_key = (settings.TEZLIFY_CREDENTIAL_ENCRYPTION_KEY or "").strip()
        if raw_key:
            try:
                # Validate key length / formatting
                key_bytes = raw_key.encode("utf-8")
                Fernet(key_bytes)
                return key_bytes
            except Exception as e:
                logger.error("[CredentialVault] Configured TEZLIFY_CREDENTIAL_ENCRYPTION_KEY is invalid.")
                raise CredentialVaultError(f"Invalid TEZLIFY_CREDENTIAL_ENCRYPTION_KEY: {e}")

        # Fallback in dev/test environment using deterministic KDF from SECRET_KEY
        is_test = bool(os.getenv("PYTEST_CURRENT_TEST"))
        is_dev = settings.SECRET_KEY == "dev-only-insecure-secret-key" or not settings.ENVIRONMENT or settings.ENVIRONMENT.lower() == "development"

        if is_test or is_dev:
            # Deterministic 32-byte derivation ensures tokens survive dev server restarts
            derived = hashlib.sha256((settings.SECRET_KEY + "_tezlify_credential_vault_salt_v1").encode("utf-8")).digest()
            return base64.urlsafe_b64encode(derived)

        raise RuntimeError(
            "TEZLIFY_CREDENTIAL_ENCRYPTION_KEY environment variable is mandatory in production mode."
        )

    @classmethod
    def encrypt_token(cls, raw_token: str) -> str:
        """
        Encrypts a raw Meta access token into an authenticated Fernet ciphertext string.
        """
        if not raw_token or not raw_token.strip():
            raise ValueError("Cannot encrypt an empty token.")

        key = cls._get_fernet_key()
        fernet = Fernet(key)
        encrypted_bytes = fernet.encrypt(raw_token.strip().encode("utf-8"))
        return encrypted_bytes.decode("utf-8")

    @classmethod
    def decrypt_token(cls, encrypted_token: str) -> str:
        """
        Decrypts an encrypted token string back to the raw token string.
        Raises CredentialDecryptionError on tamper, key change, or corruption.
        """
        if not encrypted_token or not encrypted_token.strip():
            raise ValueError("Cannot decrypt an empty ciphertext.")

        key = cls._get_fernet_key()
        fernet = Fernet(key)
        try:
            decrypted_bytes = fernet.decrypt(encrypted_token.strip().encode("utf-8"))
            return decrypted_bytes.decode("utf-8")
        except InvalidToken:
            logger.error("[CredentialVault] Decryption failed: invalid token or key mismatch.")
            raise CredentialDecryptionError()
        except Exception as e:
            logger.error(f"[CredentialVault] Unexpected error during credential decryption: {type(e).__name__}")
            raise CredentialDecryptionError()

    @staticmethod
    def mask_token(token: Optional[str]) -> str:
        """
        Safely formats a token for debugging: e.g. 'EAAB...9xyz' without exposing the body.
        """
        if not token:
            return "<none>"
        clean = token.strip()
        if len(clean) <= 8:
            return "******"
        return f"{clean[:4]}...{clean[-4:]}"

    # Ergonomic aliases
    encrypt = encrypt_token
    decrypt = decrypt_token
    mask_secret = mask_token
