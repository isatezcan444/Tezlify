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
import json
import re
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, NamedTuple, Optional, Tuple
from urllib.parse import unquote

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import Text, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.campaign import Campaign

# Directory where uploaded campaign media is securely stored
UPLOAD_DIR = Path("uploads/campaign_media").resolve()

# Yükleme anında dosyanın sahibini kaydeden yan dosya. Medya uç noktası
# yetkilendirmeyi bu güvenilir kayda dayandırır; dosya adı/kimliği tek başına
# sahiplik kanıtı değildir.
OWNER_META_SUFFIX = ".owner.json"

#: Kanonik yerel medya kimliği. Dosya kimliği tek başına yetki kanıtı DEĞİLDİR:
#: bilinmesi erişim hakkı doğurmaz, yalnızca sahiplik kaydını/ilişkiyi arar.
FILE_ID_PATTERN = re.compile(r"^camp_[a-f0-9]{16}$")

#: Kanonik yerel medya referansı — TEK kabul edilen biçim. Sahiplik kanıtı
#: yalnızca bu tam eşleşmeden üretilebilir: host, şema, query/fragment,
#: traversal, encoding ve fazladan boşluk kabul edilmez. `search` yerine
#: `fullmatch` kullanılır ki URL'nin herhangi bir yerinde geçen bir kimlik
#: sahiplik sanılmasın.
CANONICAL_LOCAL_MEDIA_URL_PATTERN = re.compile(
    r"^/api/v1/campaigns/media/(camp_[a-f0-9]{16})$"
)

#: Yerel medyaya işaret eden ama kanonik olmayan girdileri yakalamak için.
LOCAL_MEDIA_PATH_MARKER = "/campaigns/media/"
EMBEDDED_FILE_ID_PATTERN = re.compile(r"camp_[0-9a-f]{16}", re.IGNORECASE)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB


class CampaignMediaAccessDenied(Exception):
    """Medya baytları okunmadan önce tenant sahipliği kanıtlanamadı.

    Gönderim yolları bunu yakalayıp iletimi DURDURUR; metne sessizce düşmez
    ve başarı raporlamaz (truthfulness invariant).
    """


def extract_local_file_id(media_url: Optional[str]) -> Optional[str]:
    """Yalnızca TAM kanonik yerel medya URL'sinden `file_id` çıkarır.

    Başka her biçim `None` döner: harici URL, şemasız yol, `..` traversal,
    yüzde-kodlama, query/fragment, baştaki/sondaki boşluk. Bu fonksiyon bir
    referansın "yerel medyaya ait olduğunu" iddia ettiğini değil, gerçekten
    kanonik olduğunu söyler; sahiplik kanıtı için tek kaynak budur.
    """
    if not isinstance(media_url, str):
        return None
    match = CANONICAL_LOCAL_MEDIA_URL_PATTERN.fullmatch(media_url)
    return match.group(1) if match else None


def looks_like_local_media_reference(media_url: Optional[str]) -> bool:
    """Referans yerel medya deposunu hedeflemeye ÇALIŞIYOR mu?

    Kanonik olmayan ama yerel medyaya benzeyen her biçim (host'lu mutlak URL,
    şemasız yol, traversal, yüzde-kodlama, query/fragment, çıplak kimlik)
    yazma anında reddedilir. Yalnızca bu deposu hedeflemeyen sıradan harici
    URL'ler serbest kalır.
    """
    if not isinstance(media_url, str) or not media_url:
        return False
    candidate = media_url
    try:
        candidate = unquote(media_url)
    except Exception:  # noqa: BLE001 - çözülemeyen girdi zaten şüpheli
        candidate = media_url
    if LOCAL_MEDIA_PATH_MARKER in candidate:
        return True
    return EMBEDDED_FILE_ID_PATTERN.search(candidate) is not None


def _normalize_tenant_id(value: Optional[object]) -> Optional[str]:
    """Tenant kimliğini tire/büyük-küçük harf farkından bağımsız normalize eder."""
    if value is None:
        return None
    cleaned = str(value).replace("-", "").strip().lower()
    return cleaned or None


def _same_tenant(left: Optional[object], right: Optional[object]) -> bool:
    left_norm = _normalize_tenant_id(left)
    right_norm = _normalize_tenant_id(right)
    return left_norm is not None and left_norm == right_norm


class MediaOwnership(NamedTuple):
    """Medya sahiplik kaydının durumu.

    - ``owner``: güvenilir sahip kaydı var.
    - ``legacy``: kayıt yok; sahiplik yalnız kampanya referansından çıkarılabilir.
    - ``corrupt``: kayıt var ama okunamıyor/geçersiz; fail-closed.
    """

    state: str
    user_id: Optional[str] = None

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
    def _owner_meta_path(cls, file_id: str) -> Path:
        return cls._ensure_upload_dir() / f"{file_id}{OWNER_META_SUFFIX}"

    @classmethod
    def read_media_ownership(cls, file_id: str) -> MediaOwnership:
        """Yükleme anında yazılan sahiplik kaydını okur.

        Eksik kayıt ``legacy`` döner (eski yüklemeler); var olup okunamayan
        kayıt ``corrupt`` döner ve çağıran tarafından fail-closed reddedilir.
        """
        if not file_id or not FILE_ID_PATTERN.match(file_id):
            return MediaOwnership("corrupt")
        path = cls._owner_meta_path(file_id)
        if not path.exists():
            return MediaOwnership("legacy")
        try:
            if not path.resolve().is_relative_to(UPLOAD_DIR.resolve()):
                return MediaOwnership("corrupt")
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - bozuk kayıt fail-closed
            return MediaOwnership("corrupt")
        if not isinstance(payload, dict):
            return MediaOwnership("corrupt")
        owner = payload.get("user_id")
        if not isinstance(owner, str) or not owner.strip():
            return MediaOwnership("corrupt")
        return MediaOwnership("owner", owner.strip())

    @classmethod
    def _write_media_ownership(cls, file_id: str, user_id: str) -> None:
        path = cls._owner_meta_path(file_id)
        path.write_text(json.dumps({"user_id": str(user_id)}), encoding="utf-8")

    @classmethod
    def _sanitize_filename(cls, name: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9_.-]", "_", name)
        return clean.strip("._") or "attachment"

    @classmethod
    async def save_uploaded_media(cls, file: UploadFile, user_id: str) -> Dict[str, Any]:
        """Validates and stores uploaded campaign media, returning its URL and metadata."""
        if not user_id or not str(user_id).strip():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Oturum açmanız gerekiyor (Authentication required)",
                headers={"WWW-Authenticate": "Bearer"},
            )
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

        # Sahiplik kaydı yazılamazsa dosya da bırakılmaz: aksi halde hiçbir
        # tenant'a atfedilemeyen bir yükleme oluşurdu.
        try:
            cls._write_media_ownership(file_id, str(user_id).strip())
        except Exception as exc:  # noqa: BLE001 - yazma hatası fail-closed
            target_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Medya sahiplik kaydı oluşturulamadı.",
            ) from exc

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
        if not file_id or not FILE_ID_PATTERN.match(file_id):
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
    async def authorize_media_reference(
        cls, db: AsyncSession, file_id: str, user_id: Optional[str]
    ) -> bool:
        """Kampanya medyasına erişim yetkisini GÜVENİLİR sunucu kayıtlarından belirler.

        Sıra:
        1. Sahiplik yan dosyası varsa TEK kanıt odur; DB referansları onu ezemez.
        2. Yan dosya yoksa (legacy) yalnızca dosyayı TAM KANONİK biçimde
           referanslayan kampanyalar kanıt sayılır. TEK tenant referans veriyor
           ve çağıran o tenant ise izin verilir; NULL sahipli, çok tenantlı
           veya hiç kanonik referansı olmayan dosya belirsizdir ve fail-closed
           reddedilir.
        3. Bozuk/geçersiz yan dosya legacy'ye DÜŞMEZ; doğrudan reddedilir.

        Kullanıcının yazdığı `media_url` sahiplik kanıtı değildir — bu yöntem
        yalnızca önceden var olan, kanonik ilişkileri okur, yenisini üretmez.
        Kampanya metni, JSON içindeki serbest metin ve URL'nin herhangi bir
        yerinde geçen kimlik sahiplik kanıtı SAYILMAZ.
        """
        if not file_id or not user_id or not str(user_id).strip():
            return False
        if not FILE_ID_PATTERN.match(str(file_id)):
            return False

        ownership = cls.read_media_ownership(file_id)
        if ownership.state == "owner":
            return _same_tenant(ownership.user_id, user_id)
        if ownership.state != "legacy":
            return False

        owners = await cls._legacy_reference_owners(db, file_id)
        if not owners or len(owners) != 1:
            return False
        return _same_tenant(next(iter(owners)), user_id)

    @staticmethod
    def _campaign_references_file_exactly(
        media_url: Optional[str],
        sequence_steps: Optional[object],
        file_id: str,
    ) -> bool:
        """Kampanya satırı dosyayı TAM kanonik biçimde referanslıyor mu?

        Yalnızca ana `media_url` ve sekans adımlarının `media_url` alanı
        denetlenir. `message_template` gibi serbest metin, JSON içinde rastgele
        eşleşme veya URL'nin bir parçası olarak geçen kimlik sayılmaz.
        """
        if extract_local_file_id(media_url) == file_id:
            return True
        if isinstance(sequence_steps, list):
            for step in sequence_steps:
                if isinstance(step, dict) and (
                    extract_local_file_id(step.get("media_url")) == file_id
                ):
                    return True
        return False

    @classmethod
    async def _legacy_reference_owners(
        cls, db: AsyncSession, file_id: str
    ) -> Optional[set[str]]:
        """Legacy sahiplik için DB'deki KANONİK referansların tenant kümesi.

        SQL `contains` yalnızca aday satırları ucuzca daraltır; sahiplik kararı
        Python'da tam parse ile verilir. Böylece `message_template` içinde veya
        harici bir URL'nin içinde geçen kimlik sahibi üretmez.

        `None` dönerse sorgu başarısız demektir; çağıran fail-closed davranır.
        NULL sahipli bir kanonik referans da `None` (belirsiz) sayılır.
        """
        try:
            rows = (
                await db.execute(
                    select(
                        Campaign.user_id,
                        Campaign.media_url,
                        Campaign.sequence_steps,
                    ).where(
                        or_(
                            Campaign.media_url.contains(file_id, autoescape=True),
                            cast(Campaign.sequence_steps, Text).contains(
                                file_id, autoescape=True
                            ),
                        )
                    )
                )
            ).all()
        except Exception:  # noqa: BLE001 - sahiplik çözülemezse fail-closed
            return None

        owners: set[str] = set()
        for user_id, media_url, sequence_steps in rows:
            if not cls._campaign_references_file_exactly(
                media_url, sequence_steps, file_id
            ):
                continue
            normalized = _normalize_tenant_id(user_id)
            if normalized is None:
                return None
            owners.add(normalized)
        return owners

    @classmethod
    async def get_authorized_campaign_media_base64(
        cls, db: AsyncSession, media_url: Optional[str], user_id: Optional[str]
    ) -> Optional[str]:
        """Dispatch için tenant doğrulamalı base64 çözümleyici.

        - yerel olmayan URL → ``None`` (çağıran harici URL'yi kendi işler);
        - yetki kanıtlanamaz → ``CampaignMediaAccessDenied``; baytlar OKUNMAZ;
        - yetkili ama dosya yok/bozuk → ``None`` (mevcut metne geri dönüş korunur);
        - yetkili ve doğrulanabilir → base64.
        """
        file_id = extract_local_file_id(media_url)
        if not file_id:
            return None
        if not await cls.authorize_media_reference(db, file_id, user_id):
            raise CampaignMediaAccessDenied(
                "Kampanya medyası sahipliği doğrulanamadı."
            )
        res = cls.get_media_file_info(file_id)
        if not res:
            return None
        data, _, _ = res
        return base64.b64encode(data).decode("utf-8")
