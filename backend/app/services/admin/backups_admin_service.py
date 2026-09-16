"""Backups metadata service for Admin Center.

Invariants:
- Read-only filesystem metadata inspection (filename, size, timestamps).
- Zero file content transmission, zero binary download, zero mutation endpoints.
- Reports certified Phase 10.1 statuses:
  - certification_status: "BACKUP_RESTORE_VERIFIED"
  - off_host_status: "OFF_HOST_BACKUP_NOT_CONFIGURED"
"""

import logging
import os
from datetime import datetime, timezone
from typing import Optional, Tuple

from backend.app.core.config import settings
from backend.app.schemas.admin import (
    AdminBackupFileInfo,
    AdminBackupDiskUsage,
    AdminBackupsResponse,
)

logger = logging.getLogger(__name__)


def _format_size_human(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def _inspect_backup_dir(dir_path: str) -> AdminBackupFileInfo:
    if not os.path.exists(dir_path) or not os.path.isdir(dir_path):
        return AdminBackupFileInfo()

    latest_file: Optional[str] = None
    latest_mtime: float = 0.0
    latest_size: int = 0

    try:
        for entry in os.scandir(dir_path):
            if entry.is_file() and not entry.name.startswith("."):
                stat = entry.stat()
                if stat.st_mtime > latest_mtime:
                    latest_mtime = stat.st_mtime
                    latest_file = entry.name
                    latest_size = stat.st_size
    except Exception as e:
        logger.debug("Failed to inspect backup dir %s: %s", dir_path, e)
        return AdminBackupFileInfo()

    if not latest_file:
        return AdminBackupFileInfo()

    created_dt = datetime.fromtimestamp(latest_mtime, tz=timezone.utc)
    now_dt = datetime.now(timezone.utc)
    age_hours = round(max(0.0, (now_dt - created_dt).total_seconds() / 3600.0), 1)

    return AdminBackupFileInfo(
        latest_backup_filename=latest_file,
        size_bytes=latest_size,
        size_human=_format_size_human(latest_size),
        created_at=created_dt.isoformat(),
        age_hours=age_hours,
    )


def _compute_total_backup_usage(root_dir: str) -> Tuple[int, str]:
    total_bytes = 0
    if os.path.exists(root_dir) and os.path.isdir(root_dir):
        try:
            for dirpath, _, filenames in os.walk(root_dir):
                for f in filenames:
                    if not f.startswith("."):
                        fp = os.path.join(dirpath, f)
                        try:
                            total_bytes += os.path.getsize(fp)
                        except OSError:
                            pass
        except Exception as e:
            logger.debug("Failed calculating total backup usage: %s", e)

    return total_bytes, _format_size_human(total_bytes)


def get_backups_metadata() -> AdminBackupsResponse:
    now_iso = datetime.now(timezone.utc).isoformat()
    backups_root = getattr(settings, "TEZLIFY_BACKUPS_DIR", "/opt/tezlify/backups")

    pg_info = _inspect_backup_dir(os.path.join(backups_root, "postgres"))
    media_info = _inspect_backup_dir(os.path.join(backups_root, "media"))
    config_info = _inspect_backup_dir(os.path.join(backups_root, "config"))

    tot_bytes, tot_human = _compute_total_backup_usage(backups_root)

    return AdminBackupsResponse(
        timestamp=now_iso,
        certification_status="BACKUP_RESTORE_VERIFIED",
        off_host_status="OFF_HOST_BACKUP_NOT_CONFIGURED",
        postgres=pg_info,
        media=media_info,
        config=config_info,
        total_backup_disk_usage=AdminBackupDiskUsage(
            bytes=tot_bytes,
            human=tot_human,
        ),
    )
