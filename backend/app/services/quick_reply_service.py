import logging
from typing import Any, Dict, List, Optional
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.quick_reply import QuickReply
from backend.app.schemas.quick_reply import QuickReplyCreate, QuickReplyUpdate

logger = logging.getLogger(__name__)

DEFAULT_QUICK_REPLIES = [
    {
        "shortcut": "/merhaba",
        "title": "Karşılama / Giriş",
        "content": "Merhaba {isim}, mesajınız için teşekkür ederiz. Size nasıl yardımcı olabilirim?",
        "category": "Genel",
        "variables": [{"key": "isim", "label": "Müşteri Adı", "default_from": "lead_name"}],
    },
    {
        "shortcut": "/fiyat",
        "title": "Fiyat Bilgisi",
        "content": "Merhaba {isim}, ilgilendiğiniz hizmetimizle ilgili detaylı fiyat ve paket teklifimizi memnuniyetle paylaşabiliriz. Detayları aktarmamı ister misiniz?",
        "category": "Satış",
        "variables": [{"key": "isim", "label": "Müşteri Adı", "default_from": "lead_name"}],
    },
    {
        "shortcut": "/katalog",
        "title": "Ürün & Hizmet Kataloğu",
        "content": "Merhaba {isim}, güncel ürün ve hizmet kataloğumuzu incelemek için web sitemizi ziyaret edebilir veya size detaylı broşürümüzü iletmemizi talep edebilirsiniz.",
        "category": "Satış",
        "variables": [{"key": "isim", "label": "Müşteri Adı", "default_from": "lead_name"}],
    },
    {
        "shortcut": "/iban",
        "title": "Ödeme / Havale Bilgileri",
        "content": "Merhaba {isim}, ödeme işlemlerinizi havale/EFT ile gerçekleştirebilirsiniz. Hesap ve sipariş detaylarınızı teyit ettikten sonra dekontu buradan iletmeniz yeterlidir.",
        "category": "Ödeme",
        "variables": [{"key": "isim", "label": "Müşteri Adı", "default_from": "lead_name"}],
    },
    {
        "shortcut": "/konum",
        "title": "Adres ve Konum",
        "content": "Merhaba {isim}, ofisimize hafta içi 09:00 - 18:00 saatleri arasında randevu alarak gelebilirsiniz. Konum detaylarını paylaşmaktan memnuniyet duyarız.",
        "category": "Genel",
        "variables": [{"key": "isim", "label": "Müşteri Adı", "default_from": "lead_name"}],
    },
]


async def seed_defaults_if_empty(db: AsyncSession, user_id: str) -> None:
    """Kullanıcının henüz hazır cevabı yoksa varsayılan generic şablonları ekler."""
    stmt = select(func.count(QuickReply.id)).where(get_user_filter(QuickReply.user_id, user_id))
    count = await db.scalar(stmt)
    if count == 0:
        for tpl in DEFAULT_QUICK_REPLIES:
            qr = QuickReply(
                user_id=user_id,
                shortcut=tpl["shortcut"],
                title=tpl["title"],
                content=tpl["content"],
                category=tpl["category"],
                variables=tpl["variables"],
            )
            db.add(qr)
        try:
            await db.commit()
            logger.info("Kullanıcı %s için varsayılan hazır cevaplar tohumlandı.", user_id)
        except Exception as e:
            await db.rollback()
            logger.warning("Varsayılan hazır cevaplar tohumlanırken hata (yok sayıldı): %s", e)


async def list_quick_replies(
    db: AsyncSession,
    user_id: str,
    category: Optional[str] = None,
    search: Optional[str] = None,
) -> List[QuickReply]:
    """Kullanıcıya ait hazır cevapları filtreler ve listeler. Boşsa önce varsayılanları tohumlar."""
    await seed_defaults_if_empty(db, user_id)

    stmt = select(QuickReply).where(get_user_filter(QuickReply.user_id, user_id))

    if category and category != "ALL" and category != "Tümü":
        stmt = stmt.where(QuickReply.category == category)

    if search and search.strip():
        q = f"%{search.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(QuickReply.shortcut).like(q),
                func.lower(QuickReply.title).like(q),
                func.lower(QuickReply.content).like(q),
            )
        )

    stmt = stmt.order_by(QuickReply.category.asc(), QuickReply.id.asc())
    res = await db.execute(stmt)
    return list(res.scalars().all())


async def get_quick_reply(
    db: AsyncSession,
    user_id: str,
    quick_reply_id: int,
) -> QuickReply:
    """Tek bir hazır cevabı getirir; yetki doğrulaması yapar."""
    stmt = select(QuickReply).where(
        QuickReply.id == quick_reply_id,
        get_user_filter(QuickReply.user_id, user_id),
    )
    res = await db.execute(stmt)
    qr = res.scalar_one_or_none()
    if not qr:
        raise LookupError(f"Hazır cevap #{quick_reply_id} bulunamadı")
    return qr


async def create_quick_reply(
    db: AsyncSession,
    user_id: str,
    data: QuickReplyCreate,
) -> QuickReply:
    """Yeni hazır cevap ekler; kısayol çakışmasını engeller."""
    # Check duplicate shortcut for this user
    existing_stmt = select(QuickReply.id).where(
        QuickReply.shortcut == data.shortcut,
        get_user_filter(QuickReply.user_id, user_id),
    )
    existing_id = await db.scalar(existing_stmt)
    if existing_id is not None:
        raise ValueError(f"Bu kısayol ({data.shortcut}) zaten kullanımda")

    qr = QuickReply(
        user_id=user_id,
        shortcut=data.shortcut,
        title=data.title,
        content=data.content,
        category=data.category or "Genel",
        variables=[v.model_dump() if hasattr(v, "model_dump") else v for v in (data.variables or [])],
    )
    db.add(qr)
    await db.commit()
    await db.refresh(qr)
    return qr


async def update_quick_reply(
    db: AsyncSession,
    user_id: str,
    quick_reply_id: int,
    data: QuickReplyUpdate,
) -> QuickReply:
    """Mevcut hazır cevabı günceller; yetki ve çakışma doğrulaması yapar."""
    qr = await get_quick_reply(db, user_id, quick_reply_id)

    if data.shortcut is not None and data.shortcut != qr.shortcut:
        existing_stmt = select(QuickReply.id).where(
            QuickReply.shortcut == data.shortcut,
            QuickReply.id != quick_reply_id,
            get_user_filter(QuickReply.user_id, user_id),
        )
        existing_id = await db.scalar(existing_stmt)
        if existing_id is not None:
            raise ValueError(f"Bu kısayol ({data.shortcut}) zaten başka bir hazır cevapta kullanımda")
        qr.shortcut = data.shortcut

    if data.title is not None:
        qr.title = data.title
    if data.content is not None:
        qr.content = data.content
    if data.category is not None:
        qr.category = data.category
    if data.variables is not None:
        qr.variables = [v.model_dump() if hasattr(v, "model_dump") else v for v in data.variables]

    qr.updated_at = utc_now_naive()
    await db.commit()
    await db.refresh(qr)
    return qr


async def delete_quick_reply(
    db: AsyncSession,
    user_id: str,
    quick_reply_id: int,
) -> bool:
    """Hazır cevabı siler; yetki doğrulaması yapar."""
    qr = await get_quick_reply(db, user_id, quick_reply_id)
    await db.delete(qr)
    await db.commit()
    return True
