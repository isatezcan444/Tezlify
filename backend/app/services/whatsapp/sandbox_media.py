"""WhatsApp Sandbox Dedicated Media Isolation Manager (Phase 8.0.8).

Provides strictly isolated, tamper-resistant, PII-safe media storage and lifecycle
management for WhatsApp Sandbox L4/L5 E2E tests.

Strict Invariants:
1. Production Media Isolation: Sandbox media is stored exclusively in
   `settings.WHATSAPP_SANDBOX_MEDIA_DIR` (e.g., /tmp/tezlify_sandbox_media/<tenant_id>/<test_id>/)
   and never in the production media directory (`/app/media`).
2. Tenant & Test Scoping: Media paths are scoped strictly by `tenant_id` and `test_id`.
   Cross-tenant directory access or path traversal attempts are rejected fail-closed.
3. Content & Integrity: Strict MIME validation, maximum size boundaries, and SHA-256 checksums.
4. Disposable Cleanup: Automated cleanup prunes ONLY the specified test's files, never touching
   production assets or concurrent test directories.
"""

import hashlib
import json
import logging
import os
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set, Tuple

from backend.app.core.config import settings

logger = logging.getLogger("whatsapp.sandbox.media")

ALLOWED_SANDBOX_MIME_TYPES: Set[str] = {
    "image/jpeg",
    "image/png",
    "application/pdf",
    "audio/ogg",
    "audio/mp4",
    "video/mp4",
}

MAX_SANDBOX_MEDIA_BYTES: int = 15 * 1024 * 1024  # 15 MB boundary


class SandboxMediaError(Exception):
    """Sandbox medya temel istisnası."""
    pass


class SandboxPathTraversalError(SandboxMediaError):
    """Path traversal girişimi tespit edildiğinde fırlatılır."""
    pass


class SandboxMimeTypeNotAllowedError(SandboxMediaError):
    """İzin verilmeyen MIME türü fırlatılır."""
    pass


class SandboxFileSizeExceededError(SandboxMediaError):
    """Dosya boyutu sınırı aşıldığında fırlatılır."""
    pass


class SandboxMediaIntegrityError(SandboxMediaError):
    """SHA-256 bütünlük doğrulaması başarısız olduğunda fırlatılır."""
    pass


@dataclass
class SandboxMediaFile:
    """İzole sandbox medya dosyası meta verisi."""
    file_id: str
    tenant_id: str
    test_id: str
    filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    created_at: str
    file_path: str


class SandboxMediaManager:
    """İzole sandbox medya yaşam döngüsü yöneticisi."""

    def __init__(self, base_dir: Optional[str] = None):
        self._base_dir = os.path.realpath(base_dir or settings.WHATSAPP_SANDBOX_MEDIA_DIR)
        os.makedirs(self._base_dir, exist_ok=True)

    @property
    def base_dir(self) -> str:
        return self._base_dir

    def _sanitize_path_segment(self, segment: str, label: str) -> str:
        """Yol segmentini güvenli karakterlerle sınırlandırır (path traversal engeli)."""
        if not segment or not str(segment).strip():
            raise SandboxPathTraversalError(f"{label} segment cannot be empty")
        clean = str(segment).strip()
        # Sadece alfasayısal, tire, alt çizgi ve nokta izinli
        if not re.match(r"^[a-zA-Z0-9_\-\.]+$", clean) or ".." in clean or "/" in clean or "\\" in clean:
            raise SandboxPathTraversalError(f"Invalid characters in {label}: {segment!r}")
        return clean

    def _resolve_test_directory(self, tenant_id: str, test_id: str) -> str:
        """Kiracı ve test için izole dizini çözer ve canonical yol sınırını doğrular."""
        s_tenant = self._sanitize_path_segment(tenant_id, "tenant_id")
        s_test = self._sanitize_path_segment(test_id, "test_id")
        target_dir = os.path.join(self._base_dir, s_tenant, s_test)
        real_target = os.path.realpath(target_dir)

        # Canonical path base_dir ile başlamak zorundadır
        if not real_target.startswith(self._base_dir + os.sep) and real_target != self._base_dir:
            raise SandboxPathTraversalError(
                f"Resolved directory {real_target!r} escapes base directory {self._base_dir!r}"
            )
        return real_target

    def save_media(
        self,
        tenant_id: str,
        test_id: str,
        filename: str,
        content: bytes,
        mime_type: str,
        expected_sha256: Optional[str] = None,
    ) -> SandboxMediaFile:
        """Yeni bir sandbox medya dosyasını izole dizine kaydeder ve sidecar üretir."""
        if not content:
            raise SandboxMediaError("Media content cannot be empty")

        clean_mime = (mime_type or "").split(";")[0].strip().lower()
        if clean_mime not in ALLOWED_SANDBOX_MIME_TYPES:
            raise SandboxMimeTypeNotAllowedError(
                f"MIME type '{clean_mime}' is not permitted in sandbox (allowed: {sorted(ALLOWED_SANDBOX_MIME_TYPES)})"
            )

        if len(content) > MAX_SANDBOX_MEDIA_BYTES:
            raise SandboxFileSizeExceededError(
                f"Media size {len(content)} bytes exceeds maximum {MAX_SANDBOX_MEDIA_BYTES} bytes"
            )

        actual_sha256 = hashlib.sha256(content).hexdigest()
        if expected_sha256 and expected_sha256.lower().strip() != actual_sha256:
            raise SandboxMediaIntegrityError(
                f"SHA-256 mismatch: expected {expected_sha256}, calculated {actual_sha256}"
            )

        s_filename = self._sanitize_path_segment(filename, "filename")
        test_dir = self._resolve_test_directory(tenant_id, test_id)
        os.makedirs(test_dir, exist_ok=True)

        target_file_path = os.path.realpath(os.path.join(test_dir, s_filename))
        if not target_file_path.startswith(test_dir + os.sep):
            raise SandboxPathTraversalError("Resolved file path escapes test directory")

        with open(target_file_path, "wb") as f:
            f.write(content)

        meta_file_path = f"{target_file_path}.meta.json"
        now_iso = datetime.now(timezone.utc).isoformat()
        media_file = SandboxMediaFile(
            file_id=hashlib.sha256(f"{tenant_id}:{test_id}:{s_filename}".encode()).hexdigest()[:16],
            tenant_id=tenant_id,
            test_id=test_id,
            filename=s_filename,
            mime_type=clean_mime,
            size_bytes=len(content),
            sha256=actual_sha256,
            created_at=now_iso,
            file_path=target_file_path,
        )

        with open(meta_file_path, "w", encoding="utf-8") as f:
            json.dump(asdict(media_file), f, indent=2)

        logger.info(
            "[AUDIT] Saved isolated sandbox media: tenant=%s test=%s file=%s size=%d sha256=%s",
            tenant_id, test_id, s_filename, len(content), actual_sha256[:12]
        )
        return media_file

    def read_media(self, tenant_id: str, test_id: str, filename: str) -> Tuple[bytes, SandboxMediaFile]:
        """İzole sandbox medya dosyasını ve sidecar meta verisini okur."""
        s_filename = self._sanitize_path_segment(filename, "filename")
        test_dir = self._resolve_test_directory(tenant_id, test_id)
        raw_path = os.path.join(test_dir, s_filename)

        # Symlink attack protection: neither the file nor its sidecar may be a symlink
        if os.path.islink(raw_path) or os.path.islink(f"{raw_path}.meta.json"):
            raise SandboxPathTraversalError(f"Symlinks are strictly forbidden in sandbox media: {s_filename}")

        target_file_path = os.path.realpath(raw_path)
        if not target_file_path.startswith(test_dir + os.sep):
            raise SandboxPathTraversalError(f"Resolved file path escapes test directory: {target_file_path}")

        meta_file_path = f"{target_file_path}.meta.json"

        if not os.path.isfile(target_file_path) or not os.path.isfile(meta_file_path):
            raise SandboxMediaError(f"Media file or sidecar not found: {s_filename} for test {test_id}")

        try:
            with open(meta_file_path, "r", encoding="utf-8") as f:
                meta_dict = json.load(f)
        except Exception as exc:
            raise SandboxMediaIntegrityError(f"Corrupted or unreadable sidecar metadata for {s_filename}: {exc}")

        with open(target_file_path, "rb") as f:
            content = f.read()

        return content, SandboxMediaFile(**meta_dict)

    def cleanup_test_media(self, tenant_id: str, test_id: str) -> int:
        """Yalnızca belirli bir testin medya dosyalarını güvenle temizler."""
        test_dir = self._resolve_test_directory(tenant_id, test_id)
        if not os.path.isdir(test_dir):
            return 0

        deleted_count = 0
        for entry in os.listdir(test_dir):
            full_path = os.path.join(test_dir, entry)
            if os.path.isfile(full_path):
                try:
                    os.remove(full_path)
                    deleted_count += 1
                except OSError as e:
                    logger.warning("[AUDIT] Failed to remove sandbox file %s: %s", full_path, e)

        try:
            os.rmdir(test_dir)
        except OSError:
            pass

        logger.info("[AUDIT] Cleaned up sandbox media: tenant=%s test=%s deleted_files=%d", tenant_id, test_id, deleted_count)
        return deleted_count

    def cleanup_tenant_media(self, tenant_id: str) -> int:
        """Kiracıya ait tüm test medyalarını temizler."""
        s_tenant = self._sanitize_path_segment(tenant_id, "tenant_id")
        tenant_dir = os.path.join(self._base_dir, s_tenant)
        real_tenant = os.path.realpath(tenant_dir)
        if not real_tenant.startswith(self._base_dir + os.sep) or not os.path.isdir(real_tenant):
            return 0

        total_deleted = 0
        for test_entry in os.listdir(real_tenant):
            test_path = os.path.join(real_tenant, test_entry)
            if os.path.isdir(test_path):
                total_deleted += self.cleanup_test_media(tenant_id, test_entry)

        try:
            os.rmdir(real_tenant)
        except OSError:
            pass
        return total_deleted


# Global sandbox media manager instance
sandbox_media_manager = SandboxMediaManager()
