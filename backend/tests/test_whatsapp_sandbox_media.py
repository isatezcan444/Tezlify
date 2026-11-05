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


def test_sandbox_media_symlink_traversal_rejection(temp_sandbox_media_dir):
    """Sembolik link (symlink) üzerinden dizin atlama girişimleri fail-closed engellenir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    # Hedef dosya oluştur (dışarıda veya başka bir dizinde)
    outside_dir = tempfile.mkdtemp(prefix="outside_secret_")
    outside_file = os.path.join(outside_dir, "secret.txt")
    with open(outside_file, "wb") as f:
        f.write(b"TOP_SECRET_DATA")

    # Geçerli bir test dizini hazırla
    test_dir = manager._resolve_test_directory("tenant-sec", "test-symlink")
    os.makedirs(test_dir, exist_ok=True)

    # 1. Medya dosyasının kendisi symlink ise
    symlink_media = os.path.join(test_dir, "symlink_file.png")
    os.symlink(outside_file, symlink_media)
    # Yanına sahte sidecar koy
    with open(f"{symlink_media}.meta.json", "w", encoding="utf-8") as f:
        f.write('{"filename": "symlink_file.png", "mime_type": "image/png"}')

    with pytest.raises(SandboxPathTraversalError, match="Symlinks are strictly forbidden"):
        manager.read_media("tenant-sec", "test-symlink", "symlink_file.png")

    # 2. Sidecar dosyasının kendisi symlink ise
    regular_media = os.path.join(test_dir, "regular_file.png")
    with open(regular_media, "wb") as f:
        f.write(b"regular content")
    symlink_meta = f"{regular_media}.meta.json"
    os.symlink(outside_file, symlink_meta)

    with pytest.raises(SandboxPathTraversalError, match="Symlinks are strictly forbidden"):
        manager.read_media("tenant-sec", "test-symlink", "regular_file.png")


def test_sandbox_media_corrupted_sidecar_rejection(temp_sandbox_media_dir):
    """Bozuk veya geçersiz JSON içeren sidecar dosyaları SandboxMediaIntegrityError fırlatır."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    saved = manager.save_media(
        tenant_id="tenant-corrupt",
        test_id="test-corrupt-sidecar",
        filename="valid_image.jpeg",
        content=b"sample image content",
        mime_type="image/jpeg",
    )

    # Sidecar dosyasını boz
    meta_path = f"{saved.file_path}.meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        f.write("{corrupted_json: missing_quotes_and_brackets")

    with pytest.raises(SandboxMediaIntegrityError, match="Corrupted or unreadable sidecar metadata"):
        manager.read_media("tenant-corrupt", "test-corrupt-sidecar", "valid_image.jpeg")


def test_sandbox_media_cross_test_id_isolation(temp_sandbox_media_dir):
    """Aynı kiracı altındaki farklı test_id'lerin medyaları birbirine erişemez."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    manager.save_media("tenant-multi", "test-session-1", "doc.pdf", b"Session 1 PDF", "application/pdf")
    manager.save_media("tenant-multi", "test-session-2", "doc.pdf", b"Session 2 PDF", "application/pdf")

    c1, meta1 = manager.read_media("tenant-multi", "test-session-1", "doc.pdf")
    assert c1 == b"Session 1 PDF"
    assert meta1.test_id == "test-session-1"

    c2, meta2 = manager.read_media("tenant-multi", "test-session-2", "doc.pdf")
    assert c2 == b"Session 2 PDF"
    assert meta2.test_id == "test-session-2"

    # test-session-3 içerisinde arandığında bulunamaz
    with pytest.raises(SandboxMediaError, match="Media file or sidecar not found"):
        manager.read_media("tenant-multi", "test-session-3", "doc.pdf")


def test_sandbox_media_outside_directory_cleanup_protection(temp_sandbox_media_dir):
    """Temizleme işlemi yol atlamaları ile üst dizinleri silemez."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    with pytest.raises(SandboxPathTraversalError):
        manager.cleanup_test_media("../outside", "test-1")

    with pytest.raises(SandboxPathTraversalError):
        manager.cleanup_test_media("tenant-1", "../outside")


def test_sandbox_media_concurrent_cleanup_resilience(temp_sandbox_media_dir):
    """Temizleme işlemi idempotent'tir; olmayan veya birden çok silinen testlerde çökmez."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    # 1. Olmayan test için temizlik 0 döner
    assert manager.cleanup_test_media("tenant-none", "test-none") == 0

    # 2. Kaydedip temizledikten sonra tekrar temizlemek 0 döner
    manager.save_media("tenant-idemp", "test-idemp", "f.png", b"data", "image/png")
    first_clean = manager.cleanup_test_media("tenant-idemp", "test-idemp")
    assert first_clean == 2

    second_clean = manager.cleanup_test_media("tenant-idemp", "test-idemp")
    assert second_clean == 0


def test_sandbox_media_filename_normalization_and_sanitization(temp_sandbox_media_dir):
    """Dosya adlarında null byte, ters eğik çizgi, iki nokta veya tehlikeli karakterler reddedilir."""
    manager = SandboxMediaManager(base_dir=temp_sandbox_media_dir)

    dangerous_filenames = [
        "file\x00name.png",
        "sub\\file.png",
        "file:stream.png",
        "file;cmd.png",
        "   ",
        "",
        "..",
        "...",
    ]

    for fname in dangerous_filenames:
        with pytest.raises(SandboxPathTraversalError):
            manager._sanitize_path_segment(fname, "filename")
