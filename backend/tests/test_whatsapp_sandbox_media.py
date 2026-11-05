"""WhatsApp Sandbox Dedicated Media Isolation & Security Tests (Phase 8.0.8).

Exhaustively verifies:
1. Path traversal attacks (relative paths, directory escapes) are rejected fail-closed.
2. MIME whitelist enforcement (non-media or dangerous file types rejected).
3. Maximum file size boundaries (enforces 15MB threshold).
4. SHA-256 integrity validation and sidecar (.meta.json) generation.
5. Cross-tenant isolation (Tenant A cannot access or delete Tenant B's files).
6. Scoped cleanup (only the target test's files are pruned).
"""

import hashlib
import os
import tempfile
import pytest

from backend.app.services.whatsapp.sandbox_media import (
    ALLOWED_SANDBOX_MIME_TYPES,
    MAX_SANDBOX_MEDIA_BYTES,
    SandboxFileSizeExceededError,
    SandboxMediaError,
    SandboxMediaIntegrityError,
    SandboxMediaManager,
    SandboxMimeTypeNotAllowedError,
    SandboxPathTraversalError,
)


@pytest.fixture
def temp_sandbox_media_dir():
    with tempfile.TemporaryDirectory(prefix="tezlify_test_sandbox_media_") as tmp_dir:
        yield tmp_dir


def test_sandbox_media_save_read_and_sidecar(temp_sandbox_media_dir):
    """Geçerli bir test medyası kaydedilir, okunur ve sidecar dosyası doğrulanır."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)
    payload = b"Sample JPEG media payload for Phase 8.0.8 Sandbox E2E test"
    sha = hashlib.sha256(payload).hexdigest()

    saved = manager.save_media(
        tenant_id="tenant-123",
        test_id="test-abc",
        filename="test_image.jpeg",
        content=payload,
        mime_type="image/jpeg",
        expected_sha256=sha,
    )

    assert saved.tenant_id == "tenant-123"
    assert saved.test_id == "test-abc"
    assert saved.filename == "test_image.jpeg"
    assert saved.size_bytes == len(payload)
    assert saved.sha256 == sha
    assert os.path.isfile(saved.file_path)
    assert os.path.isfile(f"{saved.file_path}.meta.json")

    # Okuma testi
    content, meta = manager.read_media("tenant-123", "test-abc", "test_image.jpeg")
    assert content == payload
    assert meta.sha256 == sha
    assert meta.mime_type == "image/jpeg"


def test_sandbox_media_path_traversal_prevention(temp_sandbox_media_dir):
    """Path traversal girişimleri fail-closed reddedilir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)
    payload = b"dangerous payload"

    # 1. Tenant ID ile traversal
    with pytest.raises(SandboxPathTraversalError):
        manager.save_media("../../etc", "test-1", "file.png", payload, "image/png")

    with pytest.raises(SandboxPathTraversalError):
        manager.save_media("tenant/sub", "test-1", "file.png", payload, "image/png")

    # 2. Test ID ile traversal
    with pytest.raises(SandboxPathTraversalError):
        manager.save_media("tenant-1", "../other-tenant", "file.png", payload, "image/png")

    # 3. Filename ile traversal
    with pytest.raises(SandboxPathTraversalError):
        manager.save_media("tenant-1", "test-1", "../../../root_file.png", payload, "image/png")

    with pytest.raises(SandboxPathTraversalError):
        manager.save_media("tenant-1", "test-1", "file/with/slash.png", payload, "image/png")


def test_sandbox_media_mime_validation(temp_sandbox_media_dir):
    """İzin verilmeyen veya tehlikeli MIME tipleri engellenir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)
    payload = b"script payload"

    # HTML, JS, Shell scriptleri kesinlikle reddedilmeli
    for dangerous_mime in ["text/html", "application/javascript", "application/x-sh", "application/json"]:
        with pytest.raises(SandboxMimeTypeNotAllowedError):
            manager.save_media("tenant-1", "test-1", "test.bin", payload, dangerous_mime)

    # İzinli tipler başarıyla kaydedilmeli
    for valid_mime in ALLOWED_SANDBOX_MIME_TYPES:
        ext = valid_mime.split("/")[-1]
        saved = manager.save_media("tenant-1", f"test-{ext}", f"file.{ext}", b"data", valid_mime)
        assert saved.mime_type == valid_mime


def test_sandbox_media_size_boundary(temp_sandbox_media_dir):
    """15 MB sınırını aşan medyalar reddedilir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)
    oversized = b"0" * (MAX_SANDBOX_MEDIA_BYTES + 1)

    with pytest.raises(SandboxFileSizeExceededError):
        manager.save_media("tenant-1", "test-1", "huge.mp4", oversized, "video/mp4")


def test_sandbox_media_sha256_integrity_mismatch(temp_sandbox_media_dir):
    """SHA-256 özeti uyuşmadığında dosya yazımı reddedilir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)
    payload = b"legit content"
    wrong_sha = "0000000000000000000000000000000000000000000000000000000000000000"

    with pytest.raises(SandboxMediaIntegrityError):
        manager.save_media(
            "tenant-1", "test-1", "test.jpeg", payload, "image/jpeg", expected_sha256=wrong_sha
        )


def test_sandbox_media_cross_tenant_isolation(temp_sandbox_media_dir):
    """Tenant A, Tenant B'nin test medyasına erişemez veya silemez."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    manager.save_media("tenant-a", "test-1", "secret_a.pdf", b"tenant A document", "application/pdf")
    manager.save_media("tenant-b", "test-1", "secret_b.pdf", b"tenant B document", "application/pdf")

    # Tenant B, Tenant A'nın dosyasını okuyamaz
    with pytest.raises(SandboxMediaError):
        manager.read_media("tenant-b", "test-1", "secret_a.pdf")

    # Tenant A, Tenant B'nin dosyasını okuyamaz
    with pytest.raises(SandboxMediaError):
        manager.read_media("tenant-a", "test-1", "secret_b.pdf")


def test_sandbox_media_scoped_cleanup(temp_sandbox_media_dir):
    """cleanup_test_media yalnızca hedeflenen testin dosyalarını siler."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    manager.save_media("tenant-1", "test-to-delete", "f1.png", b"p1", "image/png")
    manager.save_media("tenant-1", "test-to-keep", "f2.png", b"p2", "image/png")
    manager.save_media("tenant-2", "test-other-tenant", "f3.png", b"p3", "image/png")

    # Yalnızca test-to-delete temizlensin
    deleted = manager.cleanup_test_media("tenant-1", "test-to-delete")
    assert deleted == 2  # f1.png ve f1.png.meta.json

    # test-to-keep ve tenant-2 hala yerinde durmalı!
    c2, _ = manager.read_media("tenant-1", "test-to-keep", "f2.png")
    assert c2 == b"p2"

    c3, _ = manager.read_media("tenant-2", "test-other-tenant", "f3.png")
    assert c3 == b"p3"
