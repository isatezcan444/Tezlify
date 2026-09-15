import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from backend.app.auth.domain.exceptions import InvalidOAuthStateException
from backend.app.auth.domain.models import UserDomain, SessionDomain
from backend.app.auth.infrastructure.sql_models import OAuthStateDB
from backend.app.auth.infrastructure.google_provider import GoogleOAuthProvider
from backend.app.auth.application.user_service import UserService
from backend.app.auth.application.session_service import SessionService


class OAuthService:
    def __init__(
        self,
        google_provider: GoogleOAuthProvider,
        user_service: UserService,
        session_service: SessionService,
    ):
        self.google_provider = google_provider
        self.user_service = user_service
        self.session_service = session_service

    @staticmethod
    def hash_state(raw_state: str) -> str:
        return hashlib.sha256(raw_state.encode("utf-8")).hexdigest()

    async def initiate_google_flow(self, db: AsyncSession) -> Tuple[str, str]:
        raw_state = secrets.token_urlsafe(32)
        state_hash = self.hash_state(raw_state)
        expires_at = datetime.utcnow() + timedelta(minutes=10)

        db_state = OAuthStateDB(
            state_hash=state_hash,
            expires_at=expires_at,
            created_at=datetime.utcnow(),
            consumed_at=None,
        )
        db.add(db_state)
        await db.flush()

        auth_url = self.google_provider.get_authorization_url(state=raw_state)
        return auth_url, raw_state

    async def verify_and_consume_state(self, db: AsyncSession, raw_state: str) -> bool:
        state_hash = self.hash_state(raw_state)
        now = datetime.utcnow()

        stmt = select(OAuthStateDB).where(OAuthStateDB.state_hash == state_hash)
        res = await db.execute(stmt)
        db_state = res.scalar_one_or_none()

        if not db_state:
            raise InvalidOAuthStateException("OAuth state not found or invalid")

        if db_state.consumed_at is not None:
            raise InvalidOAuthStateException("OAuth state has already been consumed (replay attempt)")

        if db_state.expires_at < now:
            raise InvalidOAuthStateException("OAuth state has expired")

        # Atomically consume state
        db_state.consumed_at = now
        await db.flush()
        return True

    async def handle_callback(
        self,
        db: AsyncSession,
        code: str,
        state: str,
    ) -> Tuple[UserDomain, SessionDomain, str]:
        # 1. Verify and consume CSRF state
        await self.verify_and_consume_state(db, state)

        # 2. Exchange code for Google tokens
        token_data = await self.google_provider.exchange_code(code)
        id_token = token_data.get("id_token")
        if not id_token:
            raise InvalidOAuthStateException("Google response missing id_token")

        # 3. Verify ID token and extract identity
        identity = self.google_provider.verify_and_extract_identity(id_token)

        # 4. Resolve or create user with identity linking
        user = await self.user_service.get_or_create_from_oauth(
            db=db,
            provider=identity["provider"],
            provider_subject=identity["provider_subject"],
            email=identity["email"],
            display_name=identity.get("name"),
            avatar_url=identity.get("avatar_url"),
        )

        # 5. Create native session
        session, raw_token = await self.session_service.create_session(db, user.id)
        return user, session, raw_token
