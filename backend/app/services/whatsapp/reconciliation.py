"""LID/telefon kimliği bölünmüş sohbetlerin BİRLEŞTİRİLMESİ (servis katmanından bağımsız).

Neden ayrı bir modül
--------------------
Bir kişi LID adresiyle yazdığında ve gateway henüz LID→telefon köprüsünü
öğrenmemişken backend, `phone_e164 = 'jid:<lid>'` olan bir "hayalet" kişi ve ona
bağlı ayrı bir sohbet oluşturur. Köprü sonradan öğrenilse bile **geçmişte**
kalıcılaşmış bölünmeler için canlı yol (`lid_mapped`) bir daha çalışmaz — o olay
yalnızca bir kez gelir.

Birleştirme ÜÇ yerden çağrılır ve üçünün de AYNI mantığı çalıştırması gerekir:

1. **canlı yol**: `lid_mapped` olayı (gateway köprüyü ilk kez öğrendiğinde),
2. **boot**: `purge_raw_jid_identity_data` köprüsü BİLİNEN hayaletleri silmez,
   erteler; bu modüldeki `merge_deferred_lid_ghosts` onları gerçekten birleştirir,
3. **onarım işi**: `scripts/diagnostics/whatsapp_lid_split_repair.py`.

Mantık orchestrator metodunda kalsaydı boot onu çağıramazdı: `core/migrations.py`
servis katmanını import edemez (döngüsel import). Gövde bu yüzden BURAYA taşındı;
orchestrator metodu ince bir delegasyondur ve kendi mock'lanabilir yardımcılarını
(`_upsert_contact`, `_ensure_conversation`, kilit) enjekte eder.

Davranış sözleşmesi (taşındığı haliyle korunur)
----------------------------------------------
- Veri SİLİNMEZ: mesajlar `conversation_id` güncellenerek TAŞINIR.
- Aynı `wa_message_id` iki sohbette varsa kopya taşınmaz; durum rütbesi yüksek
  olan kazanır (canonical okuma yolu arşivlenen satırı görmez, kayıp değildir).
- Okunmamış sayıları toplanır; daha yeni önizleme/zaman korunur.
- Eski (LID) sohbet ARŞİVLENİR — silinmez.
- Köprüsü BİLİNMEYEN hayalet ne birleştirilir ne silinir (kimlik tahmin edilmez).
"""

import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message
from backend.app.services.whatsapp.identity import (
    contact_phone_for_jid,
    strip_jid_prefix,
)
from backend.app.services.whatsapp.repositories.conversations import (
    get_conversation_lock,
    get_conversation_scope_filters,
)

logger = logging.getLogger(__name__)

# Onarım işinin ve boot adımının varsayılan sınırı: bir çalıştırma sınırsız
# sayıda satıra dokunamaz.
DEFAULT_REPAIR_LIMIT = 50
BOOT_MERGE_LIMIT = 200

# Aynı `wa_message_id` iki sohbette varsa hangi satır kazanır. DELIVERED/READ
# bir ACK'tır; LID kopyasında kalmışsa taşınan satıra işlenir, kaybedilmez.
_STATUS_RANKS = {
    "PENDING": 0,
    "FAILED": 0,
    "SENT": 1,
    "DELIVERED": 2,
    "READ": 3,
    "RECEIVED": 4,
}


def _dialect_is_postgres(bind: Any) -> bool:
    try:
        return bind.dialect.name == "postgresql"
    except Exception:  # noqa: BLE001 - ölçemezsek SQLite varsayımı güvenli
        return False


def _lid_table(postgres: bool) -> str:
    # Gateway bu tabloyu Postgres'te özel şemada, SQLite'ta düz adla açar.
    return "whatsapp_private.lid_mappings" if postgres else "lid_mappings"


def _sessions_table(postgres: bool) -> str:
    return "public.whatsapp_sessions" if postgres else "whatsapp_sessions"


async def candidate_lid_split_pairs(
    db: AsyncSession,
    *,
    user_id: Optional[str] = None,
    limit: int = DEFAULT_REPAIR_LIMIT,
    postgres: Optional[bool] = None,
) -> List[Dict[str, Any]]:
    """Köprüsü BİLİNEN ve hâlâ hayalet LID kişisine bağlı AKTİF sohbeti olan çiftler.

    Yalnızca her iki ucu da kanıtlanmış çiftler döner: eşleme tablosunda kaydı
    olmayan bir LID aday DEĞİLDİR (kimliği tahmin etmek yerine atlarız).

    Arşivlenmiş LID sohbeti aday DEĞİLDİR: birleştirme onu arşivler, ikinci bir
    koşu aynı satırı yeniden "birleştirilmiş" diye raporlamamalıdır. Idempotans
    bu filtreden gelir; onsuz her boot aynı 200 çifti işler ve "kalan" sayısı
    hiç azalmazdı.
    """
    if postgres is None:
        postgres = _dialect_is_postgres(getattr(db, "bind", None))
    # `user_id` sütunu Uuid olduğu için kayıtlı biçim dash'siz olabilir; operatör
    # ise tireli UUID yazar. İki biçimi de kabul et — yoksa `--user-id` sessizce
    # "hiç aday yok" derdi.
    where_user = " AND (ws.user_id = :user_id OR ws.user_id = :user_id_hex)" if user_id else ""
    params = {"lim": limit}
    if user_id:
        params["user_id"] = str(user_id)
        params["user_id_hex"] = str(user_id).replace("-", "")
    rows = (
        await db.execute(
            text(
                f"""
                SELECT DISTINCT lm.lid_jid, lm.phone_jid, ws.user_id
                FROM {_lid_table(postgres)} lm
                JOIN {_sessions_table(postgres)} ws ON ws.gateway_id = lm.session_id
                WHERE lm.phone_jid IS NOT NULL AND lm.phone_jid <> ''
                  AND lm.lid_jid LIKE '%@lid'
                  {where_user}
                ORDER BY lm.lid_jid
                LIMIT :lim
                """
            ),
            params,
        )
    ).all()

    pairs: List[Dict[str, Any]] = []
    for lid_jid, phone_jid, owner in rows:
        lid_phone = f"jid:{lid_jid}"
        ghost = (
            await db.execute(
                select(Contact.id, Contact.phone_e164).where(
                    Contact.phone_e164 == lid_phone,
                    Contact.user_id == owner,
                )
            )
        ).first()
        if not ghost:
            continue
        legacy_conv = (
            await db.execute(
                select(Conversation.id)
                .where(
                    Conversation.contact_id == ghost.id,
                    Conversation.user_id == owner,
                    Conversation.is_archived.is_(False),
                )
                .order_by(Conversation.id.asc())
            )
        ).first()
        if not legacy_conv:
            continue
        pairs.append(
            {
                "user_id": str(owner),
                "lid_jid": str(lid_jid),
                "phone_jid": str(phone_jid),
                "lid_contact_id": ghost.id,
                "lid_conversation_id": legacy_conv.id,
            }
        )
    return pairs


async def _default_upsert_contact(
    db: AsyncSession,
    user_id: str,
    jid: str,
    display_name: Optional[str] = None,
    name_source: Optional[str] = None,
    **_ignored: Any,
) -> Contact:
    """Kanonik (telefon JID'li) kişiyi bulur, yoksa hayaletin adıyla oluşturur.

    Canlı yol orchestrator'ın kendi (daha zengin) `_upsert_contact`'ını enjekte
    eder; boot ve onarım işi burada tanımlı, servis katmanına bağlı olmayan
    sürümü kullanır.
    """
    canonical_phone = contact_phone_for_jid(jid) or _strip_jid_prefix(jid)
    stmt = select(Contact).where(
        Contact.phone_e164 == canonical_phone,
        get_user_filter(Contact.user_id, user_id),
    )
    contact = (await db.execute(stmt)).scalars().first()
    if contact is not None:
        return contact
    contact = Contact(
        user_id=user_id,
        phone_e164=canonical_phone,
        display_name=display_name,
    )
    try:
        async with db.begin_nested():
            db.add(contact)
            await db.flush()
    except IntegrityError:
        # Eşzamanlı bir yazar aynı kişiyi yarattıysa kaydı ikiye bölmeyiz.
        contact = (await db.execute(stmt)).scalars().first()
        if contact is None:
            raise
    return contact


async def _default_ensure_conversation(
    db: AsyncSession,
    user_id: str,
    jid: str,
    session_id: Optional[int] = None,
    **_ignored: Any,
) -> Conversation:
    contact = await _default_upsert_contact(db, user_id, jid)
    filters = get_conversation_scope_filters(user_id, contact.id, session_id)
    conv = (
        await db.execute(
            select(Conversation).where(*filters).order_by(Conversation.id.asc())
        )
    ).scalars().first()
    if conv is None:
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            session_id=session_id,
            is_group=False,
            is_archived=False,
            last_message_at=None,
        )
        db.add(conv)
        await db.flush()
    conv._contact = contact
    return conv


async def merge_split_conversation(
    db: AsyncSession,
    user_id: str,
    lid_jid: str,
    phone_jid: str,
    session_id: Optional[int] = None,
    *,
    upsert_contact: Optional[Callable[..., Any]] = None,
    ensure_conversation: Optional[Callable[..., Any]] = None,
    lock_factory: Optional[Callable[[str, int], Any]] = None,
) -> Optional[Conversation]:
    """LID sohbetini telefon (kanonik) sohbetine TAŞIR ve eskisini arşivler.

    `None` dönerse LID kişisi yoktur: birleştirilecek bir şey yok, tahmin de
    yok. `upsert_contact`/`ensure_conversation`/`lock_factory` verilmezse bu
    modüldeki servis-bağımsız varsayılanlar ve paylaşılan sohbet kilidi
    (depo katmanı) kullanılır.
    """
    _upsert_contact = upsert_contact or _default_upsert_contact
    _ensure_conversation = ensure_conversation or _default_ensure_conversation
    _lock_factory = lock_factory or get_conversation_lock

    lid_phone = f"jid:{lid_jid}" if not str(lid_jid).startswith("jid:") else str(lid_jid)
    canonical_phone = contact_phone_for_jid(phone_jid)

    cres = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_([lid_phone, canonical_phone]),
            get_user_filter(Contact.user_id, user_id),
        )
    )
    contacts = {c.phone_e164: c for c in cres.scalars().all()}
    lid_contact = contacts.get(lid_phone)
    canonical_contact = contacts.get(canonical_phone)

    if not lid_contact:
        return None
    if not canonical_contact:
        canonical_contact = await _upsert_contact(
            db, user_id, phone_jid, lid_contact.display_name, None
        )

    # Avatar LID kişisinde varsa ve kanonikte yoksa taşınır: kimlik birleşirken
    # görsel kimlik de kaybolmamalı.
    lid_attrs = lid_contact.custom_attributes or {}
    canon_attrs = canonical_contact.custom_attributes or {}
    if lid_attrs.get("avatar_url") and not canon_attrs.get("avatar_url"):
        canon_attrs["avatar_url"] = lid_attrs["avatar_url"]
        canonical_contact.custom_attributes = dict(canon_attrs)
        await db.flush()

    conv_res = await db.execute(
        select(Conversation).where(
            Conversation.contact_id.in_([lid_contact.id, canonical_contact.id]),
            get_user_filter(Conversation.user_id, user_id),
            *(
                [Conversation.session_id == session_id]
                if session_id is not None
                else []
            ),
        )
    )
    convs = {c.contact_id: c for c in conv_res.scalars().all()}
    legacy_conv = convs.get(lid_contact.id)
    canonical_conv = convs.get(canonical_contact.id)

    if not legacy_conv:
        return canonical_conv
    if not canonical_conv:
        canonical_conv = await _ensure_conversation(
            db, user_id, phone_jid, session_id=legacy_conv.session_id
        )

    if legacy_conv.id == canonical_conv.id:
        return canonical_conv

    async def _do_reconciliation():
        mres = await db.execute(
            select(Message).where(
                Message.conversation_id.in_([legacy_conv.id, canonical_conv.id])
            )
        )
        all_msgs = list(mres.scalars().all())
        canonical_wa_ids = {
            m.wa_message_id: m
            for m in all_msgs
            if m.conversation_id == canonical_conv.id and m.wa_message_id
        }

        for msg in all_msgs:
            if msg.conversation_id == legacy_conv.id:
                if msg.wa_message_id and msg.wa_message_id in canonical_wa_ids:
                    canon_msg = canonical_wa_ids[msg.wa_message_id]
                    if _STATUS_RANKS.get(msg.status.value, 0) > _STATUS_RANKS.get(
                        canon_msg.status.value, 0
                    ):
                        canon_msg.status = msg.status
                        canon_msg.delivered_at = canon_msg.delivered_at or msg.delivered_at
                        canon_msg.read_at = canon_msg.read_at or msg.read_at
                else:
                    msg.conversation_id = canonical_conv.id

        canonical_conv.unread_count = (canonical_conv.unread_count or 0) + (
            legacy_conv.unread_count or 0
        )

        if legacy_conv.last_message_at and (
            canonical_conv.last_message_at is None
            or legacy_conv.last_message_at > canonical_conv.last_message_at
        ):
            canonical_conv.last_message_at = legacy_conv.last_message_at
            if legacy_conv.last_message_preview:
                canonical_conv.last_message_preview = legacy_conv.last_message_preview

        legacy_conv.status = ConversationStatus.ARCHIVED
        legacy_conv.is_archived = True
        legacy_conv.unread_count = 0
        legacy_conv.archived_at = datetime.utcnow()

        await db.commit()
        await db.refresh(canonical_conv)
        return canonical_conv

    async with _lock_factory(user_id, legacy_conv.id), _lock_factory(
        user_id, canonical_conv.id
    ):
        return await _do_reconciliation()


async def merge_deferred_lid_ghosts(
    engine: AsyncEngine,
    *,
    limit: int = BOOT_MERGE_LIMIT,
    user_id: Optional[str] = None,
    session_factory: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """Startup adımı: purge'ün ERTELEDİĞİ köprüsü bilinen hayaletleri birleştirir.

    Erteleme birleştirme değildir: `purge_raw_jid_identity_data` köprüsü bilinen
    hayaleti silmez ama boot onu canonical sohbete de taşımazdı; sonuç, kullanıcı
    için "mesajlarım isimsiz bir sohbette duruyor" olurdu. Bu adım o boşluğu
    kapatır ve onarım işiyle AYNI `merge_split_conversation`'ı çağırır.

    Sözleşme
    --------
    - Sınırlıdır (`limit`); iş sınırsız olamaz. İşlenmeyen kaldıysa rapor
      `remaining_at_least` ile dürüstçe söyler.
    - Idempotenttir: birleştirilen LID sohbeti arşivlendiği için aday listesinden
      çıkar; ikinci boot yapılacak iş bulamaz.
    - Boot'u ASLA düşürmez (fail-open): şema/erişim hatası loglanır, rapor
      `error` alanıyla döner. Kimlik birleştirmesi şema bütünlüğüne dokunmaz.

    Dönen rapor: `scanned`, `merged`, `skipped`, `errors`, `remaining_at_least`,
    `merged_pairs` (kanıt), `error` (varsa).
    """
    factory = session_factory or AsyncSessionLocal
    report: Dict[str, Any] = {
        "scanned": 0,
        "merged": 0,
        "skipped": 0,
        "errors": 0,
        "remaining_at_least": 0,
        "limit": limit,
        "merged_pairs": [],
        "skipped_pairs": [],
    }
    if limit <= 0:
        report["error"] = "limit pozitif olmali"
        return report

    try:
        async with factory() as db:
            pairs = await candidate_lid_split_pairs(
                db,
                user_id=user_id,
                limit=limit + 1,
                postgres=_dialect_is_postgres(engine),
            )
            if len(pairs) > limit:
                report["remaining_at_least"] = len(pairs) - limit
            for pair in pairs[:limit]:
                try:
                    merged = await merge_split_conversation(
                        db,
                        pair["user_id"],
                        pair["lid_jid"],
                        pair["phone_jid"],
                        session_id=None,
                    )
                except Exception as pair_exc:  # noqa: BLE001 - tek çift boot'u düşürmez
                    await db.rollback()
                    report["errors"] += 1
                    report["skipped_pairs"].append({**pair, "reason": str(pair_exc)})
                    logger.warning(
                        "[MIGRATION] lid hayalet birleştirme hatası (lid=%s): %s",
                        pair["lid_jid"],
                        pair_exc,
                    )
                    continue
                report["scanned"] += 1
                if merged is None:
                    report["skipped"] += 1
                    report["skipped_pairs"].append(
                        {**pair, "reason": "reconcile_returned_none"}
                    )
                    continue
                report["merged"] += 1
                report["merged_pairs"].append(
                    {
                        "user_id": pair["user_id"],
                        "lid_jid": pair["lid_jid"],
                        "phone_jid": pair["phone_jid"],
                        "legacy_conversation_id": pair["lid_conversation_id"],
                        "canonical_conversation_id": merged.id,
                        "canonical_unread_count": merged.unread_count,
                    }
                )
                logger.info(
                    "[MIGRATION] LID hayaleti birleştirildi: %s → %s (kullanıcı=%s, "
                    "sohbet %s → %s)",
                    pair["lid_jid"],
                    pair["phone_jid"],
                    pair["user_id"],
                    pair["lid_conversation_id"],
                    merged.id,
                )
    except Exception as exc:  # noqa: BLE001 - startup'ı düşürmez
        report["error"] = str(exc)
        logger.warning(
            "[MIGRATION] lid hayalet birleştirme atlandı: %s", exc, exc_info=True
        )
        return report

    if report["merged"] or report["skipped"] or report["remaining_at_least"]:
        logger.info(
            "[MIGRATION] LID hayalet birleştirme: %d birleştirildi, %d atlandı, "
            "%d hata, en az %d çift bekliyor (limit=%d).",
            report["merged"],
            report["skipped"],
            report["errors"],
            report["remaining_at_least"],
            limit,
        )
    else:
        logger.debug("[MIGRATION] LID hayalet birleştirme: bekleyen çift yok.")
    return report
