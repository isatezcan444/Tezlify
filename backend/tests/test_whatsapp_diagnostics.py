"""Low-volume WhatsApp diagnostics must not leak tenant identifiers."""

import pytest

from backend.app.services.whatsapp_gateway import _diagnostic_route


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/sessions/4d53bdda-99e9-4a56-a6d0-388b92423715", "/sessions/:session"),
        (
            "/sessions/4d53bdda/conversations/905551112233@s.whatsapp.net/messages",
            "/sessions/:session/conversations/:jid/messages",
        ),
        (
            "/sessions/4d53bdda/media/private-media-id",
            "/sessions/:session/media/:media",
        ),
    ],
)
def test_diagnostic_route_redacts_session_jid_and_media_ids(path: str, expected: str) -> None:
    assert _diagnostic_route(path) == expected
