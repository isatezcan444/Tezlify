"""
Kampanya medyası: yükleme doğrulaması, saklama ve servis.

GÜVENLİK KURALI — tek cümle: **sunulan tür, dosya adının söylediği değil
BAYT'ların söylediği türdür.**

Eski hâli `file.content_type`'a (istemci beyanı) güveniyor, sonra servis
ederken türü dosya ADINDAN yeniden tahmin ediyordu. Sonuç, API kaynağında
depolanmış XSS'ti:

    content_type = "text/plain"   → ALLOWED_MIME_TYPES'ta var, kabul edilir
    filename     = "evil.html"    → _sanitize_filename noktaları korur
    servis       = mimetypes.guess_type("evil.html") → "text/html"
    başlık       = Content-Disposition: inline
    → tarayıcı dosyayı API origin'inde HTML olarak çalıştırır

`evil.svg` aynı yoldan geçiyordu (`.svg` uzantı geri-dönüşünde yok ama
`content_type: text/plain` yeterliydi) ve SVG script taşıyabilir.

Bu yüzden: yüklemede bayt kokusu (magic bytes) zorunlu, servis ederken tür
YENİDEN koklanır, ve yalnızca tarayıcının script'e çeviremeyeceği üç görsel
türü `inline` servis edilir.
"""
import base64
import re
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, NamedTuple, Optional, Tuple

from fastapi import HTTPException, UploadFile, status

# Directory where uploaded campaign media is securely stored
UPLOAD_DIR = Path("uploads/campaign_media").resolve()

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB

#: Yalnızca bu türler `inline` servis edilir. Görseller tarayıcıda script
#: çalıştıramaz; PDF/Office ise (viewer'a bağlı olarak) çalıştırabilir, bu
#: yüzden `attachment`'a zorlanır.
INLINE_SAFE_MIMES = frozenset({"image/jpeg", "image/png", "image/webp"})


class MediaKind(NamedTuple):
    """Baytlardan tanınan bir dosya türü."""

    mime: str
    media_type: str  # IMAGE | DOCUMENT
    extension: str   # kanonik uzantı — saklanan ad asla yalan söylemesin


#: İstemcinin `content_type` başlığı DEĞİL, yalnızca baytlar. `text/plain`
#: bilinçli olarak yok: magic byte'ı olmadığı için koklanamaz, ve eski
#: açığın taşıyıcısı tam olarak oydu.
_SNIFFERS: Tuple[Tuple[bytes, MediaKind], ...] = (
    (b"\xff\xd8\xff", MediaKind("image/jpeg", "IMAGE", ".jpg")),
    (b"\x89PNG\r\n\x1a\n", MediaKind("image/png", "IMAGE", ".png")),
    (b"%PDF-", MediaKind("application/pdf", "DOCUMENT", ".pdf")),
    # OLE2 / Compound File Binary — eski Word (.doc)
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", MediaKind("application/msword", "DOCUMENT", ".doc")),
)

DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
DOCX_KIND = MediaKind(DOCX_MIME, "DOCUMENT", ".docx")

SUPPORTED_FORMATS_LABEL = "PDF, DOC, DOCX veya görsel (.png, .jpg, .webp)"


def _is_docx(content: bytes) -> bool:
    """DOCX, `word/` girdisi taşıyan bir ZIP'tir.

    Sadece `PK\\x03\\x04` kontrol etmek herhangi bir zip'i (hatta bir jar'ı)
    kabul etmek olurdu; merkezi dizini okuyup `word/` aramak hem doğru hem
    ucuz.
    """
    try:
        with zipfile.ZipFile(BytesIO(content)) as zf:
            names = zf.namelist()
    except Exception:  # noqa: BLE001 - bozuk/zip olmayan içerik
        return False
    return "[Content_Types].xml" in names and any(n.startswith("word/") for n in names)


def sniff_media(content: bytes) -> Optional[MediaKind]:
    """Dosya türünü BAYTLARDAN tanır; tanınmıyorsa `None`.

    Tanınmayan içerik kabul edilmez: "bilinmeyen" bir türü sonradan
    `application/octet-stream` diye servis etmek güvenli olurdu, ama
    kullanıcıya WhatsApp'tan gönderilemeyecek bir dosya kaydetmek olurdu.
    """
    if not content:
        return None
    for magic, kind in _SNIFFERS:
        if content.startswith(magic):
            return kind
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return MediaKind("image/webp", "IMAGE", ".webp")
    if content[:4] == b"PK\x03\x04" and _is_docx(content):
        return DOCX_KIND
    return None


def inline_safe(mime: str) -> bool:
    return (mime or "").lower() in INLINE_SAFE_MIMES


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

        # Tür KARARI burada, baytlardan verilir. `file.content_type` ve uzantı
        # istemci kontrolündedir; ikisi de yalnızca ipucudur, kanıt değil.
        kind = sniff_media(content)
        if kind is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Desteklenmeyen veya tanınmayan dosya içeriği. "
                    f"Yalnızca {SUPPORTED_FORMATS_LABEL} yükleyebilirsiniz."
                ),
            )

        # Saklanan ad KANONİK uzantıyı taşır: `evil.html` içeriği PDF ise
        # `evil.pdf` olarak saklanır. Böylece diskteki/indirilen ad da
        # içerikle çelişmez.
        clean_name = cls._sanitize_filename(file.filename)
        display_name = f"{Path(clean_name).stem or 'attachment'}{kind.extension}"
        file_id = f"camp_{uuid.uuid4().hex[:16]}"
        stored_filename = f"{file_id}_{display_name}"

        upload_dir = cls._ensure_upload_dir()
        target_path = upload_dir / stored_filename
        target_path.write_bytes(content)

        return {
            "file_id": file_id,
            "media_url": f"/api/v1/campaigns/media/{file_id}",
            "media_type": kind.media_type,
            "mime_type": kind.mime,
            "filename": display_name,
            "size_bytes": len(content),
        }

    @classmethod
    def get_media_file_info(cls, file_id: str) -> Optional[Tuple[bytes, str, str]]:
        """Resolves file bytes, MIME type, and original filename from file_id.

        MIME burada dosya ADINDAN değil, saklanan BAYTLARDAN yeniden türetilir.
        Bu, kuralın geriye dönük de olması demek: eski kodun yalan söyleyen
        uzantıyla kaydettiği bir dosya bile `text/html` olarak geri dönemez —
        kokusu tutmuyorsa 404 olur.
        """
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
        kind = sniff_media(content)
        if kind is None:
            return None
        original_name = path.name[len(file_id) + 1 :]
        return content, kind.mime, original_name

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
