"""Telefon gerektiren iki senkron ölçümünün ARACI: önce/sonra kanıtı toplar.

Neden bir araç
--------------
"Rozet düştü" ve "sohbet telefondan gitti" elle ölçüldüğünde kanıt parmakla
gösterilir hale gelir: hangi sohbet, hangi değerden hangi değere, hangi saniyede,
ve olay gerçekten oldu mu? Bu soruların cevabı kayda geçmezse ölçüm tartışmaya
açık kalır ve "bence oldu" ile "ölçtüm, oldu" ayırt edilemez.

Bu betik hiçbir şeyi DEĞİŞTİRMEZ; yalnızca okur ve kanıtı tek bir JSON'da toplar:

  --list-candidates                        ölçüme uygun sohbetleri listeler
  --snapshot --conversation N --out b.json ölçüm öncesi/sonrası durumu yazar
  --capture-logs --since 15m --out l.json  log kanıtını (host tarafı) toplar
  --diff b.json a.json                     beklenen geçişleri satır satır söyler
  --logs                                   elle koşulacak log komutlarını yazdırır

Protokol: `docs/whatsapp-handset-measurement-protocol.md`.

Nerede koşar
------------
* `--capture-logs`, `--diff` ve `--logs` **host'ta** koşabilir: modülün ağır
  bağımlılıkları (SQLAlchemy, uygulama modülleri) yalnızca DB'ye dokunan
  fonksiyonların içinde import edilir. Loglar host'ta `docker logs` ile okunur;
  backend konteynerinin docker soketine erişimi yoktur ve OLMAMALIDIR.
* `--list-candidates` ve `--snapshot` DB okur; konteynerde koşarlar:
  `docker exec -e PYTHONPATH=/app -w /app tezlify-backend python /tmp/handset.py …`

Log kanıtı neyi kanıtlar, neyi kanıtlamaz
----------------------------------------
Kanıtların ASIL kaynağı DB önce/sonra farkı ve gateway önbelleğidir. Loglar
bağımsız bir başarı kanıtı DEĞİLDİR: gateway başarılı giden silmeyi loglamaz, bu
yüzden "log hatası yok" satırı **hatasızlık** kanıtıdır. Yalan söylememek için
kontrolün adı da budur (`gateway_delete_error_absent`), "delete_succeeded"
değil. Başarı iddiasının tek pozitif log kanıtı backend'in kendi dürüst
raporudur (`Sohbet silindi … remote=True`).

`--diff` çıkış kodu: 0 = beklenen geçişlerin hepsi gerçekleşti, 1 = en az biri
gerçekleşmedi, 2 = kanıt eksik/okunamadı. "KANIT-EKSIK", ölçümün başarısız
olduğunu değil, İDDİANIN doğrulanamadığını söyler.
"""
import argparse
import asyncio
import json
import logging
import subprocess
import sys
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger("handset_measure")

UNSAFE_PHONE_PREFIX = "jid:"

# Log kalıpları. Bir kalıp, listedeki TÜM parçaları AYNI satırda arayan bir
# filtredir: `["Sohbet silindi", "remote=True"]` gibi iki parçalı kalıplar,
# "silme raporu" ile "uzaktan başarılı" bilgisinin aynı satırda olduğunu
# doğrular. Farklı satırlardaki iki işaret ayrı kalıp olarak yazılır — birleştirmek
# yanlış pozitif üretirdi. Örnek satırlar kanıt olarak saklanır (en fazla 5).
LOG_PATTERNS: Dict[str, Dict[str, List[str]]] = {
    "gateway": {
        # Sağlayıcı reddi: giden silmenin BAŞARISIZ olduğunun doğrudan kanıtı.
        "delete_provider_error": ["Delete conversation provider error"],
        # Okuma/güncelleme yolundaki ayrıştırma hataları: rozet ölçümünü
        # sessizce bozabilecek tek sınıf (ayrı kalıplar: farklı satırlardalar).
        "chat_update_parse_warning": ["chats.update lastMessage sentezlenemedi"],
        "read_error": ["Mark read error"],
    },
    "backend": {
        # Pozitif kanıt: backend'in kendi dürüst raporu.
        "delete_reported_remote_true": ["Sohbet silindi", "remote=True"],
        "delete_reported_remote_false": ["Sohbet silindi", "remote=False"],
        "delete_remote_failed": ["uzaktan silinemedi"],
        # Olay kalıcı yazılamadı ise rozet/sohbet güncellemesi UI'a hiç gitmez.
        "event_persist_failure": ["Gateway olayi kalici yazilmadi"],
    },
}

LOG_COMMANDS = [
    "# Kanıt için log komutlarını elle koşmak yerine: --capture-logs --since 15m --out logs.json",
    "docker logs tezlify-gateway --since 15m 2>&1 | tail -100",
    "docker logs tezlify-backend --since 15m 2>&1 | tail -100",
]


def _mask(value: Optional[str], show: bool) -> str:
    """Telefon numarasını varsayılan olarak maskeler: bu betik bir transkripte kopyalanabilir."""
    if not value:
        return "-"
    text = str(value)
    if show or text.startswith(UNSAFE_PHONE_PREFIX) or not text.startswith("+"):
        return text
    return text[:4] + "*" * max(0, len(text) - 7) + text[-4:]


def _db():
    """Ağır bağımlılıkları yalnızca DB'ye dokunan yollarda yükle."""
    from backend.app.core.database import AsyncSessionLocal  # noqa: PLC0415

    return AsyncSessionLocal


# ---------------------------------------------------------------------------
# Log kanıtı (host tarafı)
# ---------------------------------------------------------------------------


def capture_logs(
    *,
    since: str,
    containers: Optional[Dict[str, str]] = None,
    conversation_id: Optional[int] = None,
    timeout: float = 60.0,
) -> Dict[str, Any]:
    """`docker logs` çıktısını yapılandırılmış kanıta çevirir (salt okuma)."""
    containers = containers or {"gateway": "tezlify-gateway", "backend": "tezlify-backend"}
    result: Dict[str, Any] = {
        "mode": "logs",
        "since": since,
        "captured_at": datetime.utcnow().isoformat(),
        "conversation_filter": conversation_id,
        "sources": {},
    }
    for source, container in containers.items():
        entry: Dict[str, Any] = {"container": container, "available": False, "matches": {}}
        try:
            proc = subprocess.run(
                ["docker", "logs", container, "--since", since],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            # docker, logs'u stderr'e de yazar; ikisini birleştirmek satır kaybını önler.
            text_out = (proc.stdout or "") + (proc.stderr or "")
            entry["available"] = proc.returncode == 0
            entry["exit_code"] = proc.returncode
            lines = text_out.splitlines()
            entry["lines"] = len(lines)
        except Exception as exc:  # noqa: BLE001 - log yoksa ölçüm yine kaydedilir
            entry["error"] = f"{type(exc).__name__}: {exc}"
            result["sources"][source] = entry
            continue

        if conversation_id is not None:
            needle = f"conv={conversation_id}"
            # Silme kanıtı sohbet bazlıdır; pencere içindeki BAŞKA bir sohbetin
            # kaydı bu ölçüme kanıt olarak yazılamaz.
            lines = [ln for ln in lines if needle in ln] or lines
            entry["conversation_filtered_lines"] = len(lines)

        for name, needles in LOG_PATTERNS.get(source, {}).items():
            hits = [ln for ln in lines if all(n in ln for n in needles)]
            entry["matches"][name] = {
                "count": len(hits),
                "samples": [ln[:400] for ln in hits[:5]],
            }
        result["sources"][source] = entry
    return result


def _log_check(
    checks: List[Dict[str, Any]],
    *,
    name: str,
    value: Optional[int],
    passed: Optional[bool],
    detail: str,
) -> None:
    checks.append({"check": name, "passed": passed, "detail": detail, "count": value})


def _apply_log_checks(
    checks: List[Dict[str, Any]],
    logs: Optional[Dict[str, Any]],
    measurement: str,
) -> None:
    """Log kanıtından türeyen kontroller. Log yoksa hüküm KANIT-EKSIK olur."""
    if not logs:
        _log_check(
            checks,
            name="log_evidence",
            value=None,
            passed=None,
            detail="log kanıtı verilmedi (--capture-logs ile alıp snapshot'a ekleyin)",
        )
        return

    sources = logs.get("sources") or {}
    gateway = ((sources.get("gateway") or {}).get("matches") or {})
    backend = ((sources.get("backend") or {}).get("matches") or {})

    def _count(bucket: Dict[str, Any], key: str) -> Optional[int]:
        if key not in bucket:
            return None
        return int((bucket.get(key) or {}).get("count") or 0)

    if measurement == "delete":
        backed = _count(backend, "delete_reported_remote_true")
        failed_report = _count(backend, "delete_reported_remote_false")
        if backed is None and failed_report is None:
            _log_check(
                checks,
                name="backend_delete_report_seen",
                value=None,
                passed=None,
                detail="log penceresinde silme raporu yok (yanlış pencere mi?)",
            )
        else:
            _log_check(
                checks,
                name="backend_reported_remote_true",
                value=backed,
                passed=bool(backed and not failed_report),
                detail=f"remote=True sayısı={backed}, remote=False sayısı={failed_report}",
            )
        gerr = _count(gateway, "delete_provider_error")
        _log_check(
            checks,
            name="gateway_delete_error_absent",
            value=gerr,
            passed=(gerr == 0) if gerr is not None else None,
            detail=(
                "gateway sağlayıcı hatası yok (hatasızlık kanıtı — başarı kanıtı DEĞİL)"
                if gerr == 0
                else f"gateway sağlayıcı hatası {gerr} kez loglandı"
            ),
        )
    else:  # badge
        parts = [
            _count(gateway, "chat_update_parse_warning"),
            _count(gateway, "read_error"),
        ]
        warn = None if all(p is None for p in parts) else sum(p or 0 for p in parts)
        _log_check(
            checks,
            name="gateway_unread_warning_absent",
            value=warn,
            passed=(warn == 0) if warn is not None else None,
            detail=(
                "okuma/sohbet güncellemesi ayrıştırma uyarısı yok"
                if warn == 0
                else f"{warn} ayrıştırma uyarısı var"
            ),
        )
        persist = _count(backend, "event_persist_failure")
        _log_check(
            checks,
            name="backend_event_persist_failure_absent",
            value=persist,
            passed=(persist == 0) if persist is not None else None,
            detail=(
                "kalıcı yazma hatası yok"
                if persist == 0
                else f"{persist} kalıcı yazma hatası var"
            ),
        )


# ---------------------------------------------------------------------------
# DB kanıtı (konteyner tarafı)
# ---------------------------------------------------------------------------


async def list_candidates(*, limit: int, show_phones: bool, user_id: Optional[str]) -> List[Dict[str, Any]]:
    """Rozet ölçümüne UYGUN sohbetler: okunmamışı olan, aktif, kanonik kimlikli.

    Hayalet kimlikli (`jid:...@lid`) sohbetler bilinçli olarak dışlanır: rozet
    ölçümü kanonik sohbette yapılmalıdır, yoksa "rozet düştü mü" sorusu
    birleştirilmemiş bir satır hakkında sorulmuş olur.
    """
    from sqlalchemy import select

    from backend.app.models.contact import Contact
    from backend.app.models.conversation import Conversation
    from backend.app.models.whatsapp_session import WhatsAppSession

    AsyncSessionLocal = _db()
    rows: List[Dict[str, Any]] = []
    async with AsyncSessionLocal() as db:
        stmt = (
            select(
                Conversation.id,
                Conversation.unread_count,
                Conversation.last_message_at,
                Conversation.is_archived,
                Contact.phone_e164,
                WhatsAppSession.gateway_id,
                WhatsAppSession.status,
            )
            .join(Contact, Contact.id == Conversation.contact_id, isouter=True)
            .join(WhatsAppSession, WhatsAppSession.id == Conversation.session_id, isouter=True)
            .where(
                Conversation.channel == "WHATSAPP",
                Conversation.is_archived.is_(False),
                Conversation.unread_count > 0,
            )
            .order_by(Conversation.unread_count.desc(), Conversation.last_message_at.desc())
            .limit(limit)
        )
        if user_id:
            stmt = stmt.where(Conversation.user_id == user_id)
        for conv_id, unread, last_at, _archived, phone, gw_id, gw_status in (
            await db.execute(stmt)
        ).all():
            rows.append(
                {
                    "conversation_id": conv_id,
                    "unread_count": unread,
                    "last_message_at": last_at.isoformat() if last_at else None,
                    "phone": _mask(phone, show_phones),
                    "gateway_id": gw_id,
                    "session_status": getattr(gw_status, "value", gw_status),
                    "measurable": bool(
                        phone
                        and not str(phone).startswith(UNSAFE_PHONE_PREFIX)
                        and gw_id
                        and getattr(gw_status, "value", gw_status) == "CONNECTED"
                    ),
                }
            )
    return rows


async def snapshot(
    *,
    conversation_id: int,
    gateway_cache: bool,
    measurement: str = "badge",
    logs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Bir sohbetin ölçüm öncesi/sonrası durumu (salt okuma)."""
    from sqlalchemy import select

    from backend.app.models.contact import Contact
    from backend.app.models.conversation import Conversation
    from backend.app.models.message import Message
    from backend.app.models.whatsapp_session import WhatsAppSession

    AsyncSessionLocal = _db()
    async with AsyncSessionLocal() as db:
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == conversation_id))
        ).scalar_one_or_none()
        if conv is None:
            return {
                "mode": "snapshot",
                "measurement": measurement,
                "conversation_id": conversation_id,
                "exists": False,
                "captured_at": datetime.utcnow().isoformat(),
                "logs": logs,
            }
        contact = (
            await db.execute(select(Contact).where(Contact.id == conv.contact_id))
        ).scalar_one_or_none()
        session = (
            await db.execute(select(WhatsAppSession).where(WhatsAppSession.id == conv.session_id))
        ).scalar_one_or_none()
        messages = (
            await db.execute(
                select(Message.id, Message.wa_message_id, Message.direction, Message.created_at)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.id.desc())
                .limit(5)
            )
        ).all()
        message_count = len(
            (await db.execute(select(Message.id).where(Message.conversation_id == conversation_id))).all()
        )

    data: Dict[str, Any] = {
        "mode": "snapshot",
        "measurement": measurement,
        "conversation_id": conversation_id,
        "exists": True,
        "captured_at": datetime.utcnow().isoformat(),
        "user_id": str(conv.user_id),
        "unread_count": conv.unread_count,
        "last_message_at": conv.last_message_at.isoformat() if conv.last_message_at else None,
        "last_message_preview": conv.last_message_preview,
        "is_archived": bool(conv.is_archived),
        "status": getattr(conv.status, "value", conv.status),
        "contact_phone": contact.phone_e164 if contact else None,
        "contact_is_ghost_lid": bool(
            contact and str(contact.phone_e164).startswith(UNSAFE_PHONE_PREFIX)
        ),
        "session_id": conv.session_id,
        "gateway_id": session.gateway_id if session else None,
        "session_status": getattr(session.status, "value", session.status) if session else None,
        "message_count": message_count,
        "newest_messages": [
            {
                "id": mid,
                "wa_message_id": wa_id,
                "direction": getattr(direction, "value", direction),
                "created_at": created.isoformat() if created else None,
            }
            for mid, wa_id, direction, created in messages
        ],
        "logs": logs,
    }

    if gateway_cache and data["gateway_id"]:
        # Gateway'in KENDİ sayacı ile DB'yi yan yana koymak, "kim haklı"
        # sorusunu log okumadan cevaplar (Faz 6'da tam bu fark yakalanmıştı).
        try:
            from backend.app.services import whatsapp_gateway as gw

            payload = await gw.list_conversations(data["gateway_id"])
            items = payload if isinstance(payload, list) else (payload or {}).get("conversations", [])
            match = None
            for item in items or []:
                if not isinstance(item, dict):
                    continue
                jid = item.get("jid") or item.get("id")
                phone = data["contact_phone"]
                if jid and phone and (jid == phone or jid.split("@")[0] in str(phone)):
                    match = {
                        "jid": jid,
                        "unread_count": item.get("unread_count"),
                        "last_message_at": item.get("last_message_at"),
                    }
                    break
            data["gateway_cache"] = match or {"error": "sohbet gateway onbelleginde yok"}
        except Exception as exc:  # noqa: BLE001 - kanıt toplarken hata ölçümü durdurmaz
            data["gateway_cache"] = {"error": str(exc)[:200]}
    return data


# ---------------------------------------------------------------------------
# Hüküm
# ---------------------------------------------------------------------------


def diff_snapshots(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    """Beklenen geçişleri tek tek söyler; sessiz kalan bir geçiş yoktur."""
    checks: List[Dict[str, Any]] = []
    measurement = str(before.get("measurement") or after.get("measurement") or "badge")

    def _check(name: str, passed: Optional[bool], detail: str) -> None:
        checks.append({"check": name, "passed": passed, "detail": detail})

    if not before.get("exists"):
        return {"verdict": "KANIT-EKSIK", "checks": [], "reason": "before snapshot yok"}

    logs = before.get("logs") or after.get("logs")

    if not after.get("exists"):
        # Silme ölçümünün beklenen sonucu: sohbet ARTIK YOK.
        _check("conversation_removed", True, "sohbet yerel olarak silinmiş")
        _apply_log_checks(checks, logs, measurement)
        verdict = _verdict(checks)
        return {"verdict": verdict, "checks": checks}

    before_unread = before.get("unread_count")
    after_unread = after.get("unread_count")
    if before_unread is None or after_unread is None:
        _check("db_unread_dropped", None, "okunmamış değeri okunamadı")
    elif after_unread < before_unread:
        _check(
            "db_unread_dropped",
            True,
            f"{before_unread} → {after_unread} (düştü; hedef 0)",
        )
    elif after_unread == before_unread:
        _check(
            "db_unread_dropped",
            False,
            f"{before_unread} → {after_unread} (değişmedi — olay ya gelmedi ya reddedildi)",
        )
    else:
        _check(
            "db_unread_dropped",
            False,
            f"{before_unread} → {after_unread} (ARTTI — bu bir yeniden okuma değil)",
        )
    _check(
        "db_unread_reached_zero",
        bool(after_unread == 0),
        f"son değer {after_unread} (rozet sıfırlanmış olmalı)",
    )
    _check(
        "message_count_unchanged",
        before.get("message_count") == after.get("message_count"),
        f"{before.get('message_count')} → {after.get('message_count')}",
    )
    gw_before = (before.get("gateway_cache") or {}).get("unread_count")
    gw_after = (after.get("gateway_cache") or {}).get("unread_count")
    if gw_before is None or gw_after is None:
        _check("gateway_cache_unread", None, "gateway önbelleği okunamadı (kanıt eksik)")
    else:
        _check(
            "gateway_cache_unread",
            int(gw_after) <= int(gw_before),
            f"gateway sayacı {gw_before} → {gw_after}",
        )

    _apply_log_checks(checks, logs, measurement)
    return {"verdict": _verdict(checks), "checks": checks}


def _verdict(checks: Iterable[Dict[str, Any]]) -> str:
    checks = list(checks)
    hard = [c for c in checks if c["passed"] is False]
    missing = [c for c in checks if c["passed"] is None]
    if hard:
        return "KALDI"
    return "KANIT-EKSIK" if missing else "GECTI"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-candidates", action="store_true")
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("--capture-logs", action="store_true")
    parser.add_argument("--diff", nargs=2, metavar=("BEFORE", "AFTER"))
    parser.add_argument("--logs", action="store_true")
    parser.add_argument("--conversation", type=int, default=None)
    parser.add_argument("--measurement", choices=["badge", "delete"], default="badge")
    parser.add_argument("--since", default="15m")
    parser.add_argument("--out", default=None)
    parser.add_argument("--logs-json", default=None)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--show-phones", action="store_true")
    parser.add_argument("--no-gateway-cache", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    def _write(payload: Any, out: Optional[str]) -> None:
        text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        if out:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(f"[handset-measure] yazildi: {out}")
        else:
            print(text)

    if args.logs:
        for line in LOG_COMMANDS:
            print(line)
        return 0

    if args.capture_logs:
        payload = capture_logs(since=args.since, conversation_id=args.conversation)
        _write(payload, args.out)
        for source, entry in payload["sources"].items():
            if not entry.get("available"):
                print(
                    f"[handset-measure] {source}: log alinamadi ({entry.get('error') or entry.get('exit_code')})",
                    file=sys.stderr,
                )
        return 0

    if args.list_candidates:
        rows = asyncio.run(
            list_candidates(limit=args.limit, show_phones=args.show_phones, user_id=args.user_id)
        )
        for row in rows:
            print(json.dumps(row, ensure_ascii=False, default=str))
        measurable = sum(1 for r in rows if r["measurable"])
        print(
            f"[handset-measure] {len(rows)} okunmamış sohbet, ölçülebilir={measurable} "
            f"(limit={args.limit})"
        )
        return 0

    if args.snapshot:
        if not args.conversation:
            print("[handset-measure] --snapshot icin --conversation gerekli", file=sys.stderr)
            return 2
        logs = None
        if args.logs_json:
            try:
                with open(args.logs_json, encoding="utf-8") as fh:
                    logs = json.load(fh)
            except Exception as exc:  # noqa: BLE001 - kanıt okunamazsa açıkça söylenir
                print(f"[handset-measure] log kaniti okunamadi: {exc}", file=sys.stderr)
                return 2
        data = asyncio.run(
            snapshot(
                conversation_id=args.conversation,
                gateway_cache=not args.no_gateway_cache,
                measurement=args.measurement,
                logs=logs,
            )
        )
        _write(data, args.out)
        return 0

    if args.diff:
        try:
            with open(args.diff[0], encoding="utf-8") as fh:
                before = json.load(fh)
            with open(args.diff[1], encoding="utf-8") as fh:
                after = json.load(fh)
        except Exception as exc:  # noqa: BLE001 - kanıt okunamazsa hüküm verilmez
            print(f"[handset-measure] kanit okunamadi: {exc}", file=sys.stderr)
            return 2
        result = diff_snapshots(before, after)
        for check in result["checks"]:
            mark = {True: "GECTI", False: "KALDI", None: "KANIT-EKSIK"}[check["passed"]]
            print(f"[{mark}] {check['check']}: {check['detail']}")
        print(f"[handset-measure] HUKUM: {result['verdict']}")
        if result["verdict"] == "GECTI":
            return 0
        return 1 if result["verdict"] == "KALDI" else 2

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
