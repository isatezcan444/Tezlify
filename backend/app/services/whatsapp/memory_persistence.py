"""Gateway belleğindeki mesajları kalıcı DB'ye yazar (Faz 3.6, P0).

NEDEN VAR
---------
İlk senkron `_SYNC_PER_CHAT_LIMIT = 50` ile sohbet başına yalnızca EN YENİ 50
mesajı DB'ye yazar. Daha eski her mesaj sadece gateway'in `messagesByChat`
RAM'inde durur. Gateway yeniden oluşturulduğunda (her deploy, her çökme) bu
bellek kaybolur ve `createSessionStore` onu geri YÜKLEMEZ — yani erişilemez
hale gelir. On-demand PDO bunu kurtarabilirdi, ama PDO her sohbet için cevap
vermiyor (Faz 3.6 ölçümü: 4 sohbetten 1'i 1.8 sn'de döndü, 3'ü 8 sn'de
zaman aşımına düştü). Yani "bellek kaybı" fiilen "kalıcı veri kaybı" olabilir.

Canlı ölçüm (2026-10-28, üretim, salt okunur):
    gateway RAM'inde 9098 mesaj
    bunların 7080'i DB'de YOK (16 sohbet)
    DB'de toplam 1747 mesaj

ÇÖZÜM
-----
Gateway'in ZATEN elinde tuttuğu kayıtları, mevcut ingest yolundan DB'ye yaz.
Bu iş WhatsApp'a hiçbir şey SORMAZ: `fetch_provider` yok, PDO yok, yeni mesaj
uydurma yok. Yalnızca var olan kayıtları taşır.

TASARIM SINIRLARI (bilerek)
---------------------------
* Idempotent: `_insert_messages_resilient` → `INSERT ... ON CONFLICT
  (conversation_id, wa_message_id) DO NOTHING`. Aynı chunk iki kez gelse de
  ikinci kez satır üretmez; canlı akışla yarışan kayıt da çift olmaz.
* Kiracı güvenli: sohbetler `get_user_filter` ile çözülür. LID ile anahtarlanmış
  bir sohbet, köprüsü BİLİNEN bir eşleme yoksa ATLANIR (A14/T: tahmin etme).
* Sınırlı: tur başına en fazla `page_size * max_pages` mesaj okunur; her sayfa
  ayrı commit edilir (devasa tek transaction yok).
* Önizleme/sıralama bozulmaz: eski satırlar `apply_conversation_last_message`
  çağrılmadan yazılır, yani `last_message_at` geriye SARMAZ (A4/A11).
* Tekrar çalıştırılabilir: her tur aynı işi güvenle yeniden yapar; `dry_run`
  ile yazmadan ölçüm alınabilir.
"""

from __future__ import annotations

import asyncio
import logging
import time
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.identity import phone_to_jid
from backend.app.services.whatsapp.orchestration.sync import _insert_messages_resilient
from backend.app.services.whatsapp.repositories.messages import build_message_from_gateway

logger = logging.getLogger(__name__)

#: Sohbet kimliklerini çözerken tek sorguda okunacak azami sohbet sayısı.
_CONV_LOAD_CHUNK = 500
#: `existing wa_message_id` ön yüklemesinde tek sorguluk sohbet sayısı.
_DEDUP_CHUNK = 200

_STATE: Dict[str, Any] = {
    "enabled": None,
    "runs": 0,
    "last_started_at": None,
    "last_finished_at": None,
    "last_duration_ms": None,
    "last_inserted": None,
    "last_scanned": None,
    "last_pages": None,
    "inserted_total": 0,
    "skipped_no_session": 0,
    "errors_total": 0,
    "last_error": None,
    "dry_run_last": None,
}


def reset_memory_persistence_state() -> None:
    """Test izolasyonu: süreç-global sayaçları sıfırlar."""
    _STATE.update(
        {
            "enabled": None,
            "runs": 0,
            "last_started_at": None,
            "last_finished_at": None,
            "last_duration_ms": None,
            "last_inserted": None,
            "last_scanned": None,
            "last_pages": None,
            "inserted_total": 0,
            "skipped_no_session": 0,
            "errors_total": 0,
            "last_error": None,
            "dry_run_last": None,
        }
    )


def memory_persistence_status() -> Dict[str, Any]:
    """`/health` için PII içermeyen durum özeti.

    Dürüstlük sınırı: bu sayaçlar SÜREÇ belleğidir, restart'ta sıfırlanır.
    Bu yüzden "tüm zamanların metriği" değil, "son tur ne yaptı" sinyalidir.
    """
    return dict(_STATE)


async def _load_conversation_index(
    db: AsyncSession,
    user_id: str,
    session_db_id: Optional[int],
    gateway_id: Optional[str],
) -> Tuple[Dict[str, int], Dict[int, Any]]:
    """(jid → conversation_id) ve (conversation_id → conv-benzeri) haritaları.

    Sohbetin jid'i `contacts.phone_e164` üzerinden türetilir: telefonlar
    `+90...`, gruplar `jid:...@g.us` biçiminde saklanır. LID takma adları
    yalnızca BU oturum için KAYITLI bir eşleme varsa eklenir — bilinmeyen
    köprü tahmin edilmez.

    DİKKAT: ikinci haritanın değeri ORM `Conversation` nesnesi DEĞİL, yalnızca
    `.id` taşıyan hafif bir nesnedir. Sayfa başına commit ediyoruz ve
    `expire_on_commit=True` olan bir ORM nesnesine commit'ten sonra dokunmak
    async oturumda `MissingGreenlet` üretir. `build_message_from_gateway`
    sohbetten yalnızca `conv.id` okur; bu yüzden kimliği baştan ayırıyoruz.
    """
    stmt = (
        select(Conversation.id, Contact.phone_e164)
        .outerjoin(Contact, Contact.id == Conversation.contact_id)
        .where(
            Conversation.channel == "WHATSAPP",
            get_user_filter(Conversation.user_id, user_id),
        )
    )
    if session_db_id is not None:
        # Hat izolasyonu: bu hattın sohbetleri + eski (session_id NULL) satırlar.
        stmt = stmt.where(
            or_(
                Conversation.session_id == session_db_id,
                Conversation.session_id.is_(None),
            )
        )

    conv_by_jid: Dict[str, int] = {}
    conv_by_id: Dict[int, Any] = {}
    result = await db.execute(stmt)
    for conv_id, phone in result.all():
        cid = int(conv_id)
        conv_by_id[cid] = SimpleNamespace(id=cid)
        phone_val = str(phone) if phone else ""
        if not phone_val:
            continue
        jid = phone_val[4:] if phone_val.startswith("jid:") else phone_to_jid(phone_val)
        if jid and "@" in jid:
            conv_by_jid[jid] = cid

    if gateway_id and conv_by_jid:
        try:
            rows = await db.execute(
                text(
                    "SELECT lid_jid, phone_jid FROM whatsapp_private.lid_mappings "
                    "WHERE session_id = :sid"
                ),
                {"sid": str(gateway_id)},
            )
            for lid_jid, phone_jid in rows.fetchall():
                lid_str, phone_str = str(lid_jid), str(phone_jid)
                target = conv_by_jid.get(phone_str)
                if target is not None and lid_str not in conv_by_jid:
                    conv_by_jid[lid_str] = target
                else:
                    alias = conv_by_jid.get(lid_str)
                    if alias is not None and phone_str not in conv_by_jid:
                        conv_by_jid[phone_str] = alias
        except Exception as exc:  # noqa: BLE001 - eşleme yoksa iş durmaz
            logger.debug("LID mappings skipped in memory persistence: %s", exc)

    return conv_by_jid, conv_by_id


async def _prefetch_existing_ids(
    db: AsyncSession, conv_ids: List[int]
) -> Dict[int, Set[str]]:
    """Verilen sohbetlerde DB'de zaten olan `wa_message_id` kümesi."""
    existing: Dict[int, Set[str]] = {}
    for start in range(0, len(conv_ids), _DEDUP_CHUNK):
        chunk = conv_ids[start:start + _DEDUP_CHUNK]
        if not chunk:
            continue
        res = await db.execute(
            select(Message.conversation_id, Message.wa_message_id).where(
                Message.conversation_id.in_(chunk),
                Message.wa_message_id.isnot(None),
            )
        )
        for cid, wa in res.all():
            existing.setdefault(int(cid), set()).add(str(wa))
    return existing


async def drain_gateway_memory_once(
    db: AsyncSession,
    *,
    user_id: str,
    gateway_id: str,
    session_db_id: Optional[int] = None,
    page_size: int = 500,
    max_pages: int = 20,
    per_chat_limit: int = 2000,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Gateway belleğindeki mesajları sınırlı sayfalarla DB'ye yazar.

    WhatsApp'a soru SORMAZ (`fetch_provider` kullanılmaz); yalnızca gateway'in
    elinde olan kayıtları mevcut ingest yolundan geçirir.

    Dönen sözlük: pages / scanned / inserted / conversations / dry_run.
    """
    stats: Dict[str, Any] = {
        "pages": 0,
        "scanned": 0,
        "inserted": 0,
        "conversations": 0,
        "skipped_unmapped": 0,
        "dry_run": bool(dry_run),
        "total_reported": None,
    }
    if not user_id or not gateway_id:
        return stats

    conv_by_jid, conv_by_id = await _load_conversation_index(
        db, user_id, session_db_id, gateway_id
    )
    if not conv_by_jid:
        logger.info(
            "Memory persistence: no conversations to map for gateway=%s", gateway_id
        )
        return stats

    offset = 0
    touched: Set[int] = set()
    for _ in range(max(1, int(max_pages))):
        try:
            page = await gw.list_all_messages(
                gateway_id,
                limit=int(page_size),
                offset=offset,
                per_chat_limit=int(per_chat_limit),
            )
        except Exception as exc:  # noqa: BLE001 - tur düşerse bir sonraki tur dener
            stats["error"] = str(exc)
            logger.warning(
                "Memory persistence page failed (gateway=%s offset=%s): %s",
                gateway_id, offset, exc,
            )
            break

        msgs = page.get("messages", []) if isinstance(page, dict) else []
        total = int(page.get("total") or 0) if isinstance(page, dict) else 0
        stats["total_reported"] = total
        if not msgs:
            break
        stats["pages"] += 1
        stats["scanned"] += len(msgs)

        pending: Dict[int, List[Dict[str, Any]]] = {}
        for gm in msgs:
            if not isinstance(gm, dict):
                continue
            cid = conv_by_jid.get(str(gm.get("conversation_id") or ""))
            if cid is None:
                stats["skipped_unmapped"] += 1
                continue
            pending.setdefault(cid, []).append(gm)

        if pending:
            existing = await _prefetch_existing_ids(db, list(pending.keys()))
            rows: List[Message] = []
            for cid, gm_list in pending.items():
                conv = conv_by_id.get(cid)
                if conv is None:
                    continue
                have = existing.setdefault(cid, set())
                for gm in gm_list:
                    wa = gm.get("wa_message_id")
                    if wa and str(wa) in have:
                        continue
                    row = build_message_from_gateway(user_id, conv, gm)
                    if row is None:
                        continue
                    if wa:
                        have.add(str(wa))
                    rows.append(row)
            if rows:
                touched.update({r.conversation_id for r in rows})
                if dry_run:
                    stats["inserted"] += len(rows)
                else:
                    inserted = await _insert_messages_resilient(db, rows)
                    stats["inserted"] += len(inserted)
            if not dry_run:
                # Sayfa başına commit: tek dev transaction yerine küçük yazmalar.
                await db.commit()

        offset += int(page_size)
        if offset >= total:
            break

    stats["conversations"] = len(touched)
    return stats


async def run_memory_persistence_once(
    *,
    session_factory: Optional[Callable[[], Any]] = None,
    page_size: Optional[int] = None,
    max_pages: Optional[int] = None,
    per_chat_limit: Optional[int] = None,
    dry_run: bool = False,
) -> List[Dict[str, Any]]:
    """Bağlı her hat için bir kez çalışır. Hata fırlatmaz (durum yazar)."""
    factory = session_factory or AsyncSessionLocal
    page_size = int(page_size or getattr(settings, "WHATSAPP_MEMORY_PERSIST_PAGE_SIZE", 500))
    max_pages = int(max_pages or getattr(settings, "WHATSAPP_MEMORY_PERSIST_MAX_PAGES", 20))
    per_chat_limit = int(
        per_chat_limit or getattr(settings, "WHATSAPP_MEMORY_PERSIST_PER_CHAT_LIMIT", 2000)
    )

    started = time.monotonic()
    _STATE["runs"] = int(_STATE.get("runs") or 0) + 1
    _STATE["last_started_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _STATE["last_error"] = None
    _STATE["dry_run_last"] = bool(dry_run)

    results: List[Dict[str, Any]] = []
    async with factory() as db:
        sessions = (
            await db.execute(
                select(WhatsAppSession).where(WhatsAppSession.status == "CONNECTED")
            )
        ).scalars().all()

        for sess in sessions:
            gateway_id = getattr(sess, "gateway_id", None)
            owner = getattr(sess, "user_id", None)
            if not gateway_id or not owner:
                # Kiracı sahibi bilinmiyorsa YAZMA: sahipsiz mesaj üretme.
                _STATE["skipped_no_session"] = int(_STATE.get("skipped_no_session") or 0) + 1
                continue
            try:
                result = await drain_gateway_memory_once(
                    db,
                    user_id=str(owner),
                    gateway_id=str(gateway_id),
                    session_db_id=getattr(sess, "id", None),
                    page_size=page_size,
                    max_pages=max_pages,
                    per_chat_limit=per_chat_limit,
                    dry_run=dry_run,
                )
                result["gateway_id"] = str(gateway_id)
                results.append(result)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - bir hat diğerini durdurmaz
                _STATE["errors_total"] = int(_STATE.get("errors_total") or 0) + 1
                _STATE["last_error"] = str(exc)
                logger.warning(
                    "Memory persistence failed for gateway=%s: %s", gateway_id, exc,
                    exc_info=True,
                )
                try:
                    await db.rollback()
                except Exception:  # noqa: BLE001
                    pass

    inserted = sum(int(r.get("inserted") or 0) for r in results)
    scanned = sum(int(r.get("scanned") or 0) for r in results)
    pages = sum(int(r.get("pages") or 0) for r in results)
    _STATE["last_inserted"] = inserted
    _STATE["last_scanned"] = scanned
    _STATE["last_pages"] = pages
    _STATE["inserted_total"] = int(_STATE.get("inserted_total") or 0) + inserted
    _STATE["last_finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _STATE["last_duration_ms"] = round((time.monotonic() - started) * 1000, 1)

    if inserted or scanned:
        logger.info(
            "Memory persistence: scanned=%d inserted=%d pages=%d conversations=%d dry_run=%s",
            scanned, inserted, pages,
            sum(int(r.get("conversations") or 0) for r in results),
            dry_run,
        )
    return results


async def memory_persistence_loop(
    *,
    interval_seconds: float,
    initial_delay_seconds: float = 0.0,
    session_factory: Optional[Callable[[], Any]] = None,
) -> None:
    """Süresiz döngü; iptal edilene kadar yaşar.

    Tek bir tur patlarsa döngü ÖLMEZ: hata duruma yazılır ve sonraki tur
    beklenir. Aksi halde bir kez bozulan bir DB bağlantısı, kalıcılaştırmayı
    süreç ömrü boyunca durdururdu.
    """
    _STATE["enabled"] = True
    if initial_delay_seconds > 0:
        await asyncio.sleep(initial_delay_seconds)
    while True:
        try:
            await run_memory_persistence_once(session_factory=session_factory)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - döngü ölmez
            _STATE["errors_total"] = int(_STATE.get("errors_total") or 0) + 1
            _STATE["last_error"] = str(exc)
            logger.warning("[memory-persist] tur düştü: %s", exc, exc_info=True)
        await asyncio.sleep(max(30.0, float(interval_seconds)))
