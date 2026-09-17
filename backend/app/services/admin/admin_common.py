"""Common utilities and helpers for Admin Center services.

Invariants:
- Read-only operations.
- Fail-safe JSON reading with structured error logging.
- Deterministic size formatting.
"""

import json
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def read_json_file(filepath: str) -> Optional[Dict[str, Any]]:
    """Safely read and parse a JSON file into a dict.

    Returns None if the file does not exist, is not valid JSON, or does not
    decode into a dictionary.
    """
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else None
    except Exception as e:
        logger.debug("Failed to read JSON from %s: %s", filepath, e)
        return None


def format_bytes_human(size_bytes: int) -> str:
    """Format an integer byte count into a human-readable string (B, KB, MB, GB)."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"
