"""
Unit tests for WhatsApp pure preview & message text normalization policy (Phase 11.6 Batch 3).
"""

from datetime import datetime, timezone, timedelta
import pytest

from backend.app.services.whatsapp.preview_normalization import (
    TYPE_PREVIEW_LABELS,
    as_naive_utc,
    build_last_message_summary,
    normalize_preview_text,
    parse_dt,
    should_apply_last_message,
)


# ==============================================================================
# 1. normalize_preview_text
# ==============================================================================

def test_normalize_preview_text_plain():
    assert normalize_preview_text("TEXT", "Merhaba, nasılsınız?") == "Merhaba, nasılsınız?"
    assert normalize_preview_text("TEXT", "") == ""
    assert normalize_preview_text("TEXT", None) == ""


def test_normalize_preview_text_media_empty_body():
    assert normalize_preview_text("IMAGE", "") == "📷 Fotoğraf"
    assert normalize_preview_text("VIDEO", None) == "🎥 Video"
    assert normalize_preview_text("AUDIO", "") == "🎵 Sesli mesaj"
    assert normalize_preview_text("DOCUMENT", "") == "📄 Dosya"
    assert normalize_preview_text("STICKER", "") == "Sticker"
    assert normalize_preview_text("LOCATION", "") == "📍 Konum"
    assert normalize_preview_text("CONTACT", "") == "👤 Kişi kartı"


def test_normalize_preview_text_legacy_bracket_values():
    """UI must NEVER leak raw brackets like [IMAGE] or [object Object]."""
    assert normalize_preview_text("IMAGE", "[IMAGE]") == "📷 Fotoğraf"
    assert normalize_preview_text("VIDEO", "[VIDEO]") == "🎥 Video"
    assert normalize_preview_text("AUDIO", "[AUDIO]") == "🎵 Sesli mesaj"
    assert normalize_preview_text("DOCUMENT", "[DOCUMENT]") == "📄 Dosya"
    assert normalize_preview_text("IMAGE", "[object Object]") == "📷 Fotoğraf"
    assert normalize_preview_text("TEXT", "[Medya]") == "Mesaj"


def test_normalize_preview_text_caption_preserved():
    """Media with user caption should keep caption text."""
    assert normalize_preview_text("IMAGE", "Ürün kataloğu ektedir") == "Ürün kataloğu ektedir"


# ==============================================================================
# 2. build_last_message_summary
# ==============================================================================

def test_build_last_message_summary_direct_chat():
    summary = build_last_message_summary(
        message_type="TEXT",
        body="Görüşmek üzere",
        sender_name="Ahmet Yılmaz",
        is_group=False,
        direction="INBOUND",
    )
    assert summary == "Görüşmek üzere"


def test_build_last_message_summary_group_inbound_resolved_name():
    summary = build_last_message_summary(
        message_type="IMAGE",
        body="",
        sender_name="Ahmet",
        is_group=True,
        direction="INBOUND",
    )
    assert summary == "Ahmet: 📷 Fotoğraf"


def test_build_last_message_summary_group_outbound_no_prefix():
    summary = build_last_message_summary(
        message_type="TEXT",
        body="Ben katılamayacağım",
        sender_name="ME",
        is_group=True,
        direction="OUTBOUND",
    )
    assert summary == "Ben katılamayacağım"


def test_build_last_message_summary_group_raw_identity_no_prefix():
    """Raw JID/LID/Phone names must NOT prefix group summaries (WhatsApp Web parity)."""
    summary = build_last_message_summary(
        message_type="TEXT",
        body="Toplantı başladı",
        sender_name="12345678901234@lid",
        is_group=True,
        direction="INBOUND",
    )
    assert summary == "Toplantı başladı"

    phone_summary = build_last_message_summary(
        message_type="TEXT",
        body="Toplantı başladı",
        sender_name="+905551234567",
        is_group=True,
        direction="INBOUND",
    )
    assert phone_summary == "Toplantı başladı"


# ==============================================================================
# 3. should_apply_last_message
# ==============================================================================

def test_should_apply_last_message_timestamp_ordering():
    t1 = datetime(2026, 9, 17, 10, 0, 0)
    t2 = datetime(2026, 9, 17, 10, 5, 0)

    # Newer incoming message replaces older preview
    assert should_apply_last_message(t1, t2, "Yeni mesaj") is True

    # Older incoming message does not replace newer preview
    assert should_apply_last_message(t2, t1, "Eski mesaj") is False

    # Same timestamp does not overwrite
    assert should_apply_last_message(t1, t1, "Aynı zaman") is False

    # Empty summary never applies
    assert should_apply_last_message(t1, t2, "") is False


def test_should_apply_last_message_realtime():
    t1 = datetime(2026, 9, 17, 10, 0, 0)
    # Realtime message (no timestamp) applies
    assert should_apply_last_message(t1, None, "Realtime mesaj") is True


# ==============================================================================
# 4. parse_dt & as_naive_utc
# ==============================================================================

def test_parse_dt():
    dt = parse_dt("2026-09-17T12:00:00.000Z")
    assert dt is not None
    assert dt.year == 2026
    assert dt.month == 9
    assert dt.day == 17

    assert parse_dt(None) is None
    assert parse_dt("") is None
    assert parse_dt("not-a-date") is None


def test_as_naive_utc():
    aware = datetime(2026, 9, 17, 15, 0, 0, tzinfo=timezone(timedelta(hours=3)))
    naive = as_naive_utc(aware)
    assert naive is not None
    assert naive.tzinfo is None
    assert naive.hour == 12  # Converted to UTC

    plain_naive = datetime(2026, 9, 17, 12, 0, 0)
    assert as_naive_utc(plain_naive) == plain_naive
    assert as_naive_utc(None) is None
