from datetime import datetime, timezone
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.auth.domain.models import UserDomain
from backend.app.auth.infrastructure.sql_models import AuthUserDB, OAuthAccountDB


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class UserService:
    async def get_user_by_id(
        self,
        db: AsyncSession,
        user_id: UUID,
    ) -> Optional[UserDomain]:
        stmt = select(AuthUserDB).where(AuthUserDB.id == user_id)
        res = await db.execute(stmt)
        user = res.scalar_one_or_none()
        return UserDomain.model_validate(user) if user else None

    async def get_or_create_from_oauth(
        self,
        db: AsyncSession,
        provider: str,
        provider_subject: str,
        email: str,
        display_name: Optional[str] = None,
        avatar_url: Optional[str] = None,
        preferred_user_id: Optional[UUID] = None,
    ) -> UserDomain:
        # 1. Look up existing OAuth account by (provider, provider_subject)
        stmt_oauth = select(OAuthAccountDB).where(
            OAuthAccountDB.provider == provider,
            OAuthAccountDB.provider_subject == provider_subject,
        )
        res_oauth = await db.execute(stmt_oauth)
        existing_oauth = res_oauth.scalar_one_or_none()

        if existing_oauth:
            user = await self.get_user_by_id(db, existing_oauth.user_id)
            if user:
                return user

        # 2. Check if a user with this email already exists
        stmt_user = select(AuthUserDB).where(AuthUserDB.email == email)
        res_user = await db.execute(stmt_user)
        existing_user = res_user.scalar_one_or_none()

        now = utc_now()
        if existing_user:
            # Link new OAuth account to existing user
            new_oauth = OAuthAccountDB(
                user_id=existing_user.id,
                provider=provider,
                provider_subject=provider_subject,
                provider_email=email,
                created_at=now,
                updated_at=now,
            )
            db.add(new_oauth)
            await db.flush()
            return UserDomain.model_validate(existing_user)

        # 3. Create new user (using preferred_user_id if migrating existing profile)
        new_user = AuthUserDB(
            id=preferred_user_id,
            email=email,
            display_name=display_name,
            avatar_url=avatar_url,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        db.add(new_user)
        await db.flush()

        new_oauth = OAuthAccountDB(
            user_id=new_user.id,
            provider=provider,
            provider_subject=provider_subject,
            provider_email=email,
            created_at=now,
            updated_at=now,
        )
        db.add(new_oauth)
        await db.flush()

        return UserDomain.model_validate(new_user)
