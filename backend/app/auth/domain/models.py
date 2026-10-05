from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4
from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.datetime_utils import utc_now_naive


class UserDomain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID = Field(default_factory=uuid4)
    email: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_active: bool = True
    created_at: datetime = Field(default_factory=utc_now_naive)
    updated_at: datetime = Field(default_factory=utc_now_naive)


class OAuthAccountDomain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID = Field(default_factory=uuid4)
    user_id: UUID
    provider: str
    provider_subject: str
    provider_email: str
    created_at: datetime = Field(default_factory=utc_now_naive)
    updated_at: datetime = Field(default_factory=utc_now_naive)


class SessionDomain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID = Field(default_factory=uuid4)
    user_id: UUID
    session_token_hash: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=utc_now_naive)
    last_seen_at: datetime = Field(default_factory=utc_now_naive)
    revoked_at: Optional[datetime] = None

    @property
    def is_valid(self) -> bool:
        now = datetime.now(self.expires_at.tzinfo) if self.expires_at.tzinfo is not None else utc_now_naive()
        return self.revoked_at is None and self.expires_at > now


class OAuthStateDomain(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    state_hash: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=utc_now_naive)
    consumed_at: Optional[datetime] = None

    @property
    def is_valid(self) -> bool:
        now = datetime.now(self.expires_at.tzinfo) if self.expires_at.tzinfo is not None else utc_now_naive()
        return self.consumed_at is None and self.expires_at > now
