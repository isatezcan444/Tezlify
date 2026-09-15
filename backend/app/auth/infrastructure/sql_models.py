from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import Column, String, Boolean, DateTime, Uuid, ForeignKey, UniqueConstraint, Index
from backend.app.core.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AuthUserDB(Base):
    __tablename__ = "auth_staging_users"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    display_name = Column(String(255), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)


class OAuthAccountDB(Base):
    __tablename__ = "auth_staging_oauth_accounts"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("auth_staging_users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String(50), nullable=False)
    provider_subject = Column(String(255), nullable=False)
    provider_email = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("provider", "provider_subject", name="uq_oauth_provider_subject"),
        Index("ix_oauth_user_provider", "user_id", "provider"),
    )


class AuthSessionDB(Base):
    __tablename__ = "auth_staging_sessions"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("auth_staging_users.id", ondelete="CASCADE"), nullable=False, index=True)
    session_token_hash = Column(String(64), unique=True, nullable=False, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    last_seen_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_session_active", "session_token_hash", "revoked_at", "expires_at"),
    )


class OAuthStateDB(Base):
    __tablename__ = "auth_staging_oauth_states"

    state_hash = Column(String(64), primary_key=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    consumed_at = Column(DateTime(timezone=True), nullable=True)
