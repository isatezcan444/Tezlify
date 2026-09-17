import pytest
from backend.app.core.config import settings

@pytest.fixture(autouse=True)
def enable_history_expansion_in_tests():
    old = getattr(settings, "WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED", False)
    settings.WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = True
    yield
    settings.WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = old
