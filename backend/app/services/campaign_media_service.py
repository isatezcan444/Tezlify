import os
import re
import uuid
import base64
import mimetypes
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from fastapi import UploadFile, HTTPException, status

# Directory where uploaded campaign media is securely stored
UPLOAD_DIR = Path("uploads/campaign_media").resolve()

ALLOWED_MIME_TYPES = {
    # Images
    "image/jpeg": "IMAGE",
    "image/jpg": "IMAGE",
    "image/png": "IMAGE",
    "image/webp": "IMAGE",
    # Documents / Catalogs / Presentations
    "application/pdf": "DOCUMENT",
    "application/msword": "DOCUMENT",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCUMENT",
    "text/plain": "DOCUMENT",
}

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB


class CampaignMediaService:
    """Manages secure campaign media upload, storage, base64 resolution, and streaming."""

    @classmethod
    def _ensure_upload_dir(cls) -> Path:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return UPLOAD_DIR

    @classmethod
    def _sanitize_filename(cls, name: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9_.-]", "_", name)
        return clean.strip("._") or "attachment"

    @classmethod
    async def save_uploaded_media(cls, file: UploadFile, user_id: str) -> Dict[str, Any]:
        """Validates and stores uploaded campaign media, returning its URL and metadata."""
        if not file.filename:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Dosya adı bulunamadı.",
            )

        content = await file.read()
        if len(content) == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Boş dosya yüklenemez.",
            )
        if len(content) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Dosya boyutu çok büyük (Maksimum {MAX_FILE_SIZE // (1024 * 1024)}MB).",
            )

        # Detect MIME
        mime_type = file.content_type
        if not mime_type or mime_type == "application/octet-stream":
            guessed, _ = mimetypes.guess_type(file.filename)
            mime_type = guessed or "application/octet-stream"

        mime_type = mime_type.lower()
        if mime_type not in ALLOWED_MIME_TYPES:
            # Check extension fallback
            ext = Path(file.filename).suffix.lower()
            if ext in [".pdf"]:
                mime_type = "application/pdf"
            elif ext in [".png"]:
                mime_type = "image/png"
            elif ext in [".jpg", ".jpeg"]:
                mime_type = "image/jpeg"
            elif ext in [".webp"]:
                mime_type = "image/webp"
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Desteklenmeyen dosya türü ({mime_type}). Yalnızca PDF veya görsel (.png, .jpg, .webp) yükleyebilirsiniz.",
                )

        media_type = ALLOWED_MIME_TYPES.get(mime_type, "DOCUMENT")
        clean_name = cls._sanitize_filename(file.filename)
        file_id = f"camp_{uuid.uuid4().hex[:16]}"
        stored_filename = f"{file_id}_{clean_name}"

        upload_dir = cls._ensure_upload_dir()
        target_path = upload_dir / stored_filename
        target_path.write_bytes(content)

        return {
            "file_id": file_id,
            "media_url": f"/api/v1/campaigns/media/{file_id}",
            "media_type": media_type,
            "mime_type": mime_type,
            "filename": clean_name,
            "size_bytes": len(content),
        }

    @classmethod
    def get_media_file_info(cls, file_id: str) -> Optional[Tuple[bytes, str, str]]:
        """Resolves file bytes, MIME type, and original filename from file_id."""
        if not file_id or not re.match(r"^camp_[a-f0-9]{16}$", file_id):
            return None

        upload_dir = cls._ensure_upload_dir()
        matches = list(upload_dir.glob(f"{file_id}_*"))
        if not matches:
            return None

        path = matches[0]
        # Prevent symlink/path traversal escapes
        if not path.resolve().is_relative_to(upload_dir.resolve()):
            return None

        content = path.read_bytes()
        original_name = path.name[len(file_id) + 1 :]
        mime, _ = mimetypes.guess_type(original_name)
        return content, mime or "application/octet-stream", original_name

    @classmethod
    def get_campaign_media_base64(cls, media_url: str) -> Optional[str]:
        """Extracts base64 encoding if media_url points to local campaign media."""
        if not media_url:
            return None
        # Pattern: /api/v1/campaigns/media/(camp_[a-f0-9]{16})
        match = re.search(r"/campaigns/media/(camp_[a-f0-9]{16})", media_url)
        if not match:
            return None
        file_id = match.group(1)
        res = cls.get_media_file_info(file_id)
        if not res:
            return None
        data, _, _ = res
        return base64.b64encode(data).decode("utf-8")
