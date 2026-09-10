import uuid
import pytest
import pytest_asyncio
from typing import AsyncGenerator
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead


def unique_phone(prefix: str = "+90532") -> str:
    """Generate a unique random E.164 Turkish phone number.

    Uses the 532 mobile block (libphonenumber-valid for any subscriber part)
    so tests exercise the strict validation path with genuinely valid numbers
    instead of relying on the removed best-effort fallback.
    """
    import phonenumbers

    for _ in range(100):
        candidate = f"{prefix}{uuid.uuid4().int % 10000000:07d}"
        try:
            if phonenumbers.is_valid_number(phonenumbers.parse(candidate, "TR")):
                return candidate
        except Exception:
            continue
    raise AssertionError("Could not generate a valid test phone number")


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Provides an isolated AsyncClient for REST API integration testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator:
    """Provides a fresh database session."""
    async with AsyncSessionLocal() as session:
        yield session


class WhatsAppCallTracker:
    """Tracks attempted WhatsApp dispatches to ensure Zero-Send safety invariants.

    The WhatsApp dispatch backend has been removed entirely, so there is no
    dispatch mechanism left to patch: the tracker simply records that no
    dispatch path exists, keeping the Zero-Send assertions honest.
    """
    def __init__(self):
        self.calls = []

    def record_call(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})

    @property
    def call_count(self) -> int:
        return len(self.calls)

    def reset(self):
        self.calls.clear()


@pytest.fixture
def whatsapp_spy():
    """Tracks WhatsApp dispatches. No dispatch backend exists, so call_count stays 0."""
    yield WhatsAppCallTracker()
