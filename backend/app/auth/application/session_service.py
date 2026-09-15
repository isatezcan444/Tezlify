import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from backend.app.auth.domain.models import SessionDomain
from backend.app.auth.infrastructure.sql_models import AuthSessionDB


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class SessionService:
    @staticmethod
    def hash_token(raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    async def create_session(
        self,
        db: AsyncSession,
        user_id: UUID,
        ttl_days: int = 7,
    ) -> Tuple[SessionDomain, str]:
        raw_token = secrets.token_urlsafe(32)
        token_hash = self.hash_token(raw_token)
        now = utc_now()
        expires_at = now + timedelta(days=ttl_days)

        db_session = AuthSessionDB(
            user_id=user_id,
            session_token_hash=token_hash,
            expires_at=expires_at,
            created_at=now,
            last_seen_at=now,
            revoked_at=None,
        )
        db.add(db_session)
        await db.flush()

        return SessionDomain.model_validate(db_session), raw_token

    async def get_session_by_token(
        self,
        db: AsyncSession,
        raw_token: str,
    ) -> Optional[SessionDomain]:
        token_hash = self.hash_token(raw_token)

        stmt = select(AuthSessionDB).where(
            AuthSessionDB.session_token_hash == token_hash,
            AuthSessionDB.revoked_at.is_(None),
        )
        res = await db.execute(stmt)
        db_session = res.scalar_one_or_none()

        if not db_session:
            return None

        now = utc_now() if db_session.expires_at.tzinfo is not None else datetime.utcnow()
        if db_session.expires_at <= now:
            return None

        # Update last seen timestamp
        db_session.last_seen_at = now
        await db.flush()

        return SessionDomain.model_validate(db_session)

    async def revoke_session(
        self,
        db: AsyncSession,
        raw_token: str,
    ) -> bool:
        token_hash = self.hash_token(raw_token)

        stmt = select(AuthSessionDB).where(
            AuthSessionDB.session_token_hash == token_hash,
            AuthSessionDB.revoked_at.is_(None),
        )
        res = await db.execute(stmt)
        db_session = res.scalar_one_or_none()
        if not db_session:
            return False

        now = utc_now() if db_session.expires_at.tzinfo is not None else datetime.utcnow()
        db_session.revoked_at = now
        await db.flush()
        return True
