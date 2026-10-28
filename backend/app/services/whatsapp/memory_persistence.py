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

Canlı ölçüm (2026-10-28, üretim, salt okunur; KİMLİK üzerinden, sayaçla değil):
    gateway RAM'inde 9122 mesaj (9122'sinin de geçerli kimliği var, 0 kopya)
    bunların 7336'sı DB'de YOK (40 sohbet)
    DB'de toplam 1786 mesaj — hepsi RAM'de ve DOĞRU sohbetin altında (DB ⊆ RAM)

DİKKAT — bu sayı bir kez yanlış raporlandı: ilk ölçüm gateway'e
`perChatLimit=50` ile sorulduğu için sohbet başına yalnızca son 50 mesajı
görüyordu ve "7080 / 16 sohbet" gibi eksik bir sonuç verdi. Bu bir veri
değişimi değil, ÖLÇÜM DERİNLİĞİ hatasıydı. Doğru ölçüm `perChatLimit=2000`
(gateway'in kendi tavanı) ve kimlik kümesi karşılaştırmasıdır:
`scripts/diagnostics/audit_memory_gap.py`.

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
    # gateway_id -> sonraki turun başlayacağı offset. Tur başına tavan
    # toplam mesaj sayısının altında kaldığında listenin kuyruğunun
    # erişilemez olmasını engeller (bkz. `drain_gateway_memory_once`).
    "cursors": {},
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
            "cursors": {},
        }
    )


def memory_persistence_status() -> Dict[str, Any]:
    """`/health` için PII içermeyen durum özeti.

    Dürüstlük sınırı: bu sayaçlar SÜREÇ belleğidir, restart'ta sıfırlanır.
    Bu yüzden "tüm zamanların metriği" değil, "son tur ne yaptı" sinyalidir.

    `cursors` sözlüğü gateway UUID'si ile anahtarlanır; oturum kimliğini
    `/health`'e sızdırmamak için yalnızca toplu özeti yayınlanır.
    """
    snapshot = dict(_STATE)
    cursors = snapshot.pop("cursors", None) or {}
    snapshot["cursor_count"] = len(cursors)
    snapshot["max_cursor_offset"] = max(cursors.values()) if cursors else 0
    return snapshot


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


def _safe_error(exc: BaseException) -> str:
    """İstisnayı PII'siz bir etikete indirger.

    NEDEN: `str(IntegrityError)` / `str(OperationalError)` SQL ifadesini **ve
    bağlı parametreleri** taşır — yani mesaj gövdesini, telefon numarasını,
    JID'i. Bu metin `last_error` üzerinden `/health`'te yayınlanıyor ve o uç
    kimlik doğrulaması istemiyor. Aynı metin `exc_info=True` ile sunucu
    loglarına da düşerdi.

    Bu yüzden yalnızca istisna TÜRÜ ve varsa SQLSTATE yayınlanır. Ayrıştırma
    gerektiğinde aynı hata izole bir ortamda yeniden üretilir — üretim
    verisini loglara taşımak pahasına değil.
    """
    name = type(exc).__name__
    orig = getattr(exc, "orig", None)
    code = (
        getattr(orig, "pgcode", None)
        or getattr(orig, "sqlstate", None)
        or getattr(exc, "pgcode", None)
        or getattr(exc, "sqlstate", None)
    )
    return f"{name}({code})" if code else name


def _wa_id_of(msg: Dict[str, Any]) -> str:
    """Mesajın normalize edilmiş WhatsApp kimliği; yoksa boş string.

    `None` ve yalnızca boşluktan oluşan değerler kimlik SAYILMAZ: ikisi de
    `wa_message_id IS NOT NULL` tekillik indeksini atlar, yani yazılırlarsa
    her turda yeni bir kopya üretirler.
    """
    raw = msg.get("wa_message_id")
    if raw is None:
        return ""
    return str(raw).strip()


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
    start_offset: int = 0,
) -> Dict[str, Any]:
    """Gateway belleğindeki mesajları sınırlı sayfalarla DB'ye yazar.

    WhatsApp'a soru SORMAZ (`fetch_provider` kullanılmaz); yalnızca gateway'in
    elinde olan kayıtları mevcut ingest yolundan geçirir.

    `start_offset` bir ÖNCEKİ turun bıraktığı yerdir. Bu olmadan, tur başına
    tavan (`max_pages * page_size`) toplam mesaj sayısının altında kaldığında
    her tur offset 0'dan başlar ve listenin KUYRUĞU hiçbir turda erişilemez
    olurdu: ilk N sayfa zaten DB'de olduğu için 0 satır eklenir, offset hiç
    ilerlemez. Ölçüm (2026-10-28): RAM 9122 mesaj, tavan 10000 — pay yalnızca
    878 mesajdı. İmleç bunu yapısal olarak kapatır.

    Dönen sözlük: pages / scanned / inserted / conversations / dry_run /
    next_offset (0 = tur sonuna ulaşıldı).
    """
    stats: Dict[str, Any] = {
        "pages": 0,
        "scanned": 0,
        "inserted": 0,
        "conversations": 0,
        "skipped_unmapped": 0,
        "skipped_no_id": 0,
        "dry_run": bool(dry_run),
        "total_reported": None,
        "next_offset": 0,
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

    offset = max(0, int(start_offset or 0))
    total = 0
    reached_end = False
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
            stats["error"] = _safe_error(exc)
            logger.warning(
                "Memory persistence page failed (gateway=%s offset=%s): %s",
                gateway_id, offset, _safe_error(exc),
            )
            break

        msgs = page.get("messages", []) if isinstance(page, dict) else []
        total = int(page.get("total") or 0) if isinstance(page, dict) else 0
        stats["total_reported"] = total
        if not msgs:
            # Gateway'de bu offset'ten sonra mesaj yok: liste bitti.
            reached_end = True
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
            if not _wa_id_of(gm):
                # Kimliksiz kayıt YAZILMAZ. Tekillik indeksi
                # `(conversation_id, wa_message_id) WHERE wa_message_id IS NOT
                # NULL` olduğu için NULL kimlik hiçbir zaman çakışmaz: yazılsaydı
                # her turda bir kopya daha üretilirdi (idempotency kırılırdı).
                # Kayıt gateway belleğinde kalır; canlı akışta gerçek kimlikle
                # gelirse o zaman yazılır.
                stats["skipped_no_id"] += 1
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
                    wa = _wa_id_of(gm)
                    if wa in have:
                        continue
                    row = build_message_from_gateway(user_id, conv, gm)
                    if row is None:
                        continue
                    have.add(wa)
                    rows.append(row)
            if rows:
                touched.update({r.conversation_id for r in rows})
                if dry_run:
                    stats["inserted"] += len(rows)
                else:
                    try:
                        inserted = await _insert_messages_resilient(db, rows)
                        stats["inserted"] += len(inserted)
                    except Exception as exc:  # noqa: BLE001 - tur düşse de durum yazılır
                        # Sayfa başına TEK INSERT: yarım sayfa kalmaz. Oturumu
                        # geri alıyoruz ki çağıran aynı oturumla sonraki hattı
                        # deneyebilsin (aksi halde "failed transaction" zehri
                        # bütün tura yayılırdı).
                        stats["error"] = _safe_error(exc)
                        logger.warning(
                            "Memory persistence insert failed (gateway=%s offset=%s): %s",
                            gateway_id, offset, _safe_error(exc),
                        )
                        try:
                            await db.rollback()
                        except Exception:  # noqa: BLE001
                            pass
                        break
            if not dry_run and "error" not in stats:
                # Sayfa başına commit: tek dev transaction yerine küçük yazmalar.
                await db.commit()

        if "error" in stats:
            break

        offset += int(page_size)
        if offset >= total:
            reached_end = True
            break

    stats["conversations"] = len(touched)
    # Tur sonuna ulaşıldıysa imleç sıfırlanır (bir sonraki tur baştan tarar,
    # hepsi DB'de olduğu için 0 satır ekler). Ulaşılamadıysa kaldığı yerden
    # devam edilir; hata durumunda da aynı sayfa bir sonraki turda yeniden
    # denenir, çünkü `offset` o sayfada ilerlememiştir.
    stats["next_offset"] = 0 if reached_end else offset
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
    # Kill-switch BURADA da kontrol edilir, yalnızca lifespan'de değil.
    # Aksi halde "kapalı" denilen bir özellik, elle/CLI ile çağrılan bir turda
    # yazmaya devam ederdi — ve bu, kapatma kararını anlamsız kılardı.
    if not getattr(settings, "WHATSAPP_MEMORY_PERSIST_ENABLED", True):
        _STATE["enabled"] = False
        logger.info("[memory-persist] kapalı (kill-switch); tur atlandı.")
        return []

    _STATE["enabled"] = True
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
                select(WhatsAppSession).where(
                    # "Açıkça izin verilen" = bağlı VE etkin hat. Devre dışı
                    # bırakılmış bir hattın geçmişini geri doldurmak, kullanıcı
                    # o hattı kapattıktan sonra veri yazmak demek olurdu.
                    WhatsAppSession.status == "CONNECTED",
                    WhatsAppSession.is_active.is_(True),
                )
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
                cursors = _STATE.setdefault("cursors", {})
                start_offset = int(cursors.get(str(gateway_id)) or 0)
                result = await drain_gateway_memory_once(
                    db,
                    user_id=str(owner),
                    gateway_id=str(gateway_id),
                    session_db_id=getattr(sess, "id", None),
                    page_size=page_size,
                    max_pages=max_pages,
                    per_chat_limit=per_chat_limit,
                    dry_run=dry_run,
                    start_offset=start_offset,
                )
                result["gateway_id"] = str(gateway_id)
                results.append(result)
                # İmleç yalnızca gerçek bir turda ilerletilir: `dry_run`
                # sayım turudur, sonrasında gerçek tur yine baştan başlamalı.
                # Hata varsa `next_offset` zaten kırılan sayfayı gösterir.
                if not dry_run:
                    cursors[str(gateway_id)] = int(result.get("next_offset") or 0)
                # Sayfa içinde yakalanan hata buraya `error` olarak döner;
                # toplam sayaca da yansımalı, aksi halde /health "sorun yok"
                # derken tur aslında yarım kalmış olurdu.
                if result.get("error"):
                    _STATE["errors_total"] = int(_STATE.get("errors_total") or 0) + 1
                    _STATE["last_error"] = str(result["error"])
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - bir hat diğerini durdurmaz
                _STATE["errors_total"] = int(_STATE.get("errors_total") or 0) + 1
                _STATE["last_error"] = _safe_error(exc)
                logger.warning(
                    "Memory persistence failed for gateway=%s: %s",
                    gateway_id, _safe_error(exc),
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
            _STATE["last_error"] = _safe_error(exc)
            logger.warning("[memory-persist] tur düştü: %s", _safe_error(exc))
        await asyncio.sleep(max(30.0, float(interval_seconds)))
