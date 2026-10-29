"""`ram_snapshot.py` — RAM mesajlarini disa aktarma/geri yukleme testleri.

Neden bu testler var: Asama 3.8.2'nin tek amaci "mesaji kaybetmeden korumak".
Bir yedek araci, geri yuklenemedigini fark etmeden "basarili" gorunebilir;
bu yuzden burada yedegin KENDISI kadar reddetme davranisi da test edilir:

* kimlik korunuyor mu,
* sohbet/tenant eslesmesi korunuyor mu,
* yinelenen kayit yakalaniyor mu,
* eksik payload / bozuk snapshot REDDEDILIYOR mu,
* butunluk checksum'i tutuyor mu,
* export uretim DB'sine YAZMIYOR mu,
* snapshot ve test verisi Git'e girmiyor mu.

Testler sentetiktir: gercek mesaj govdesi, gercek telefon, ag veya DB yok.
"""

import asyncio
import importlib.util
import json
import pathlib
import sqlite3

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "scripts" / "diagnostics" / "ram_snapshot.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("diagnostics_ram_snapshot", _TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()

CHAT = "905551110001@s.whatsapp.net"
CHAT2 = "905551110002@s.whatsapp.net"


def rec(conv, wa_id, *, body="sentetik", ts="2026-10-01T10:00:00Z", **extra):
    r = {
        "conversation_id": conv,
        "wa_message_id": wa_id,
        "body": body,
        "created_at": ts,
        "direction": "INBOUND",
        "message_type": "TEXT",
        "status": "DELIVERED",
        "sender_phone": "+905551112233",
        "recipient_phone": "ME",
    }
    r.update(extra)
    return r


def good_payload(records=None):
    records = records if records is not None else [rec(CHAT, "A1"), rec(CHAT, "A2")]
    per_chat = [
        {
            "jid": CHAT,
            "reported_total": len(records),
            "collected": len(records),
            "stable": True,
            "shortfall": 0,
            "rounds": 1,
        }
    ]
    manifest = tool.build_manifest(
        session_id=201,
        gateway_id="1bd78836-c084-4cbf-b333-9386d44b7bd7",
        source_container_id="deadbeef",
        started_at="2026-10-29T09:00:00Z",
        ended_at="2026-10-29T09:01:00Z",
        per_chat=per_chat,
        records=records,
        duplicates=0,
        rejected_missing_identity=0,
        rejected_incomplete=0,
    )
    return {
        "kind": tool.SNAPSHOT_KIND,
        "schema": tool.SNAPSHOT_SCHEMA,
        "header": {"session_id": 201},
        "records": records,
        "manifest": manifest,
    }


# ---------------------------------------------------------------- kimlik
def test_identity_is_conversation_plus_wa_id():
    assert tool.identity_of(rec(CHAT, "A1")) == (CHAT, "A1")


def test_identity_missing_when_wa_id_absent_or_blank():
    assert tool.identity_of(rec(CHAT, None)) is None
    assert tool.identity_of({"conversation_id": CHAT, "wa_message_id": "   "}) is None
    assert tool.identity_of({"wa_message_id": "A1"}) is None


def test_identity_token_is_stable_and_hides_raw_ids():
    tok = tool.identity_token((CHAT, "A1"))
    assert tok == tool.identity_token((CHAT, "A1"))
    assert tok != tool.identity_token((CHAT, "A2"))
    assert CHAT not in tok and "A1" not in tok
    assert len(tok) == 32


# ------------------------------------------------------------ tamlik
def test_empty_body_is_complete_but_missing_body_is_not():
    # Medya mesaji kupursuz olabilir: body:"" MESRU.
    assert tool.is_complete(rec(CHAT, "A1", body=""))
    broken = rec(CHAT, "A2")
    broken.pop("body")
    assert not tool.is_complete(broken)


def test_bad_timestamp_is_rejected():
    assert not tool.is_complete(rec(CHAT, "A1", ts="dun aksam"))
    assert not tool.is_complete(rec(CHAT, "A1", ts=""))


# ------------------------------------------------------- yinelenen kayit
def test_duplicates_are_counted_not_silently_dropped():
    out = tool.dedupe([rec(CHAT, "A1"), rec(CHAT, "A1"), rec(CHAT, "A2")])
    assert len(out["records"]) == 2
    assert out["duplicates"] == 1


def test_same_wa_id_in_two_conversations_is_not_a_duplicate():
    out = tool.dedupe([rec(CHAT, "A1"), rec(CHAT2, "A1")])
    assert len(out["records"]) == 2
    assert out["duplicates"] == 0


def test_records_without_identity_are_counted_separately():
    out = tool.dedupe([rec(CHAT, "A1"), rec(CHAT, None)])
    assert len(out["records"]) == 1
    assert out["rejected_missing_identity"] == 1


# ------------------------------------------------ sayfalama / tutarlilik
def _fake_fetch_factory(store):
    """`store` listesinden sayfa dondurur; cagrilar arasinda mesaj eklenebilir."""

    async def fetch(*, jid, limit, offset):
        rows = [r for r in store if r["conversation_id"] == jid]
        return {"messages": rows[offset: offset + limit], "total": len(rows)}

    return fetch


def test_collect_chat_collects_every_identity():
    store = [rec(CHAT, f"A{i}") for i in range(5)]
    got = asyncio.run(tool.collect_chat(_fake_fetch_factory(store), CHAT, page_size=2))
    assert got["collected"] == 5
    assert got["stable"] is True
    assert got["shortfall"] == 0
    assert {tool.identity_of(r)[1] for r in got["records"]} == {f"A{i}" for i in range(5)}


def test_collect_chat_survives_offset_drift_when_messages_arrive_midway():
    """Canli trafik: sayfa cekilirken listenin basina yeni mesaj girer.

    Naif offset aritmetigi bu durumda bir kaydi ATLAR. Kimlik kumesi
    uzerinden toplama, ikinci turda eksigi tamamlar.
    """
    store = [rec(CHAT, f"A{i}") for i in range(4)]

    async def drifting_fetch(*, jid, limit, offset):
        rows = [r for r in store if r["conversation_id"] == jid]
        page = rows[offset: offset + limit]
        if offset == 0 and not getattr(drifting_fetch, "_injected", False):
            # Sayfa alindiktan SONRA en basa yeni bir mesaj gelir: tum
            # offset'ler bir kayar.
            store.insert(0, rec(CHAT, "NEW"))
            drifting_fetch._injected = True
        return {"messages": page, "total": len(rows)}

    got = asyncio.run(tool.collect_chat(drifting_fetch, CHAT, page_size=2))
    ids = {tool.identity_of(r)[1] for r in got["records"]}
    assert {"A0", "A1", "A2", "A3", "NEW"} <= ids


def test_collect_chat_reports_shortfall_instead_of_claiming_success():
    async def lying_fetch(*, jid, limit, offset):
        # total 10 diyor ama her zaman bos donuyor.
        return {"messages": [], "total": 10}

    got = asyncio.run(tool.collect_chat(lying_fetch, CHAT, page_size=5))
    assert got["collected"] == 0
    assert got["stable"] is False
    assert got["shortfall"] == 10


# ------------------------------------------------------------ manifest
def test_manifest_carries_no_message_content():
    payload = good_payload([rec(CHAT, "A1", body="COK-GIZLI-GOVDE")])
    manifest = json.dumps(payload["manifest"], ensure_ascii=False)
    assert "COK-GIZLI-GOVDE" not in manifest
    assert CHAT not in manifest
    assert "+905551112233" not in manifest
    assert payload["manifest"]["record_count"] == 1
    assert len(payload["manifest"]["records_sha256"]) == 64


def test_manifest_marks_unstable_chats():
    per_chat = [
        {
            "jid": CHAT,
            "reported_total": 2000,
            "collected": 1998,
            "stable": False,
            "shortfall": 2,
            "rounds": 40,
        }
    ]
    m = tool.build_manifest(
        session_id=201,
        gateway_id="1bd78836-c084",
        source_container_id="x",
        started_at="a",
        ended_at="b",
        per_chat=per_chat,
        records=[rec(CHAT, "A1")],
        duplicates=0,
        rejected_missing_identity=0,
        rejected_incomplete=0,
    )
    assert m["unstable_chats"] == [CHAT]
    assert m["chats"][0]["shortfall"] == 2


# ------------------------------------------------------- butunluk kapisi
def test_verify_accepts_good_snapshot():
    assert tool.verify_snapshot(good_payload())["ok"] is True


def test_verify_rejects_tampered_content():
    payload = good_payload()
    payload["records"][0]["body"] = "degistirildi"
    res = tool.verify_snapshot(payload)
    assert res["ok"] is False
    assert any("records_sha256" in p for p in res["problems"])


def test_verify_rejects_missing_manifest_and_wrong_kind():
    payload = good_payload()
    payload.pop("manifest")
    assert tool.verify_snapshot(payload)["ok"] is False

    payload2 = good_payload()
    payload2["kind"] = "baska-bir-sey"
    assert tool.verify_snapshot(payload2)["ok"] is False


def test_verify_rejects_incomplete_record():
    payload = good_payload()
    payload["records"][0].pop("created_at")
    # manifest de ayni kayitlardan uretildigi icin yalnizca kayit kurali yakalar
    assert tool.verify_snapshot(payload)["ok"] is False


def test_verify_rejects_duplicate_identity_in_snapshot():
    payload = good_payload([rec(CHAT, "A1"), rec(CHAT, "A1")])
    res = tool.verify_snapshot(payload)
    assert res["ok"] is False
    assert any("yinelenen kimlik" in p for p in res["problems"])


# ------------------------------------------------------------ sifreleme
def test_encryption_round_trip():
    secret = "x" * 40
    blob = tool.encrypt_bytes(b'{"a":1}', secret)
    assert blob.startswith(tool.MAGIC)
    assert tool.decrypt_bytes(blob, secret) == b'{"a":1}'


def test_wrong_key_is_rejected():
    blob = tool.encrypt_bytes(b"gizli", "a" * 40)
    with pytest.raises(Exception):
        tool.decrypt_bytes(blob, "b" * 40)


def test_short_key_is_refused():
    with pytest.raises(ValueError):
        tool.derive_key("kisa")


def test_plaintext_is_not_accepted_as_ciphertext():
    with pytest.raises(ValueError):
        tool.decrypt_bytes(b'{"records":[]}', "x" * 40)


# ------------------------------------------------------- geri yukleme
def test_restore_conserves_identities(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db = tmp_path / "restore.db"
    payload = good_payload([rec(CHAT, "A1"), rec(CHAT, "A2"), rec(CHAT2, "B1")])
    res = tool.restore_to_sqlite(str(db), payload)
    assert res["restored_rows"] == 3
    assert res["identity_conserved"] is True
    rows = sqlite3.connect(db).execute(
        "SELECT conversation_id, wa_message_id FROM snapshot_messages ORDER BY 1,2"
    ).fetchall()
    assert rows == [(CHAT, "A1"), (CHAT, "A2"), (CHAT2, "B1")]


def test_restore_preserves_tenant_mapping(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db = tmp_path / "restore2.db"
    payload = good_payload([rec(CHAT, "A1"), rec(CHAT2, "B1")])
    tool.restore_to_sqlite(str(db), payload)
    by_conv = dict(
        sqlite3.connect(db)
        .execute("SELECT conversation_id, count(*) FROM snapshot_messages GROUP BY 1")
        .fetchall()
    )
    assert by_conv == {CHAT: 1, CHAT2: 1}


def test_restore_rejects_corrupt_snapshot(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    payload = good_payload()
    payload["records"][0]["body"] = "bozuldu"
    with pytest.raises(ValueError):
        tool.restore_to_sqlite(str(tmp_path / "x.db"), payload)


def test_restore_refuses_production_database(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db:5432/tezlify")
    with pytest.raises(PermissionError):
        tool.assert_restore_target_is_safe(str(tmp_path / "x.db"))


def test_restore_refuses_target_inside_repo():
    with pytest.raises(PermissionError):
        tool.assert_restore_target_is_safe(str(_REPO_ROOT / "tezlify.db"))


# ------------------------------------------- export uretim DB'sine yazmaz
def test_export_source_contains_no_write_sql():
    """Yapisal pin: betikte yazma SQL'i OLMAMALI."""
    src = _TOOL_PATH.read_text(encoding="utf-8")
    # Yorumlardaki kelimeler degil, gercek SQL literalleri aranir.
    sql_literals = [
        line for line in src.splitlines()
        if "text(" in line or "execute(" in line or "SELECT " in line
    ]
    joined = "\n".join(sql_literals)
    assert "INSERT " not in joined.upper()
    assert "UPDATE " not in joined.upper()
    assert "DELETE " not in joined.upper()
    assert "DROP " not in joined.upper()
    # Tek yazma noktasi gecici SQLite geri yukleme fonksiyonudur.
    assert "INSERT OR IGNORE INTO snapshot_messages" in src


def test_restore_sqlite_is_the_only_writer():
    src = _TOOL_PATH.read_text(encoding="utf-8")
    body = src.split("def restore_to_sqlite", 1)[1]
    # sqlite3 baglantisi yalnizca bu fonksiyonun govdesinde acilir.
    assert src.count("sqlite3.connect(") == 1
    assert "sqlite3.connect(" in body


# --------------------------------------------- Git'e girmeme garantisi
def test_artifacts_dir_is_gitignored():
    gitignore = (_REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert ".workbuddy-ai/artifacts/" in gitignore


def test_tool_never_writes_inside_repo_by_default():
    src = _TOOL_PATH.read_text(encoding="utf-8")
    # Depo icindeki hedefe yazim acikca reddedilir.
    assert "_is_inside_repo" in src
    assert "hedef depo icinde" in src


def test_cli_refuses_plaintext_without_flag(tmp_path, monkeypatch, capsys):
    """--allow-plaintext ve anahtar yoksa CLI yazmayi REDDEDER."""
    monkeypatch.setattr(tool, "collect_all", _fake_collect)
    out = tmp_path / "snapshot.json"
    code = tool.main(["--out", str(out)])
    assert code == 1
    assert not out.exists()
    assert "REDDEDILDI" in capsys.readouterr().err


def test_cli_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool, "collect_all", _fake_collect)
    out = tmp_path / "snapshot.json"
    code = tool.main(["--out", str(out), "--dry-run"])
    assert code == 0
    assert not out.exists()
    printed = capsys.readouterr().out
    assert json.loads(printed)["record_count"] == 2


async def _fake_collect(*, page_size=2000, jids=None):
    return {
        "session_id": 201,
        "gateway_id": "1bd78836-c084-4cbf-b333-9386d44b7bd7",
        "ram_total_reported": 2,
        "per_chat": [
            {
                "jid": CHAT,
                "reported_total": 2,
                "collected": 2,
                "stable": True,
                "shortfall": 0,
                "rounds": 1,
            }
        ],
        "records": [rec(CHAT, "A1"), rec(CHAT, "A2")],
        "duplicates": 0,
        "rejected_missing_identity": 0,
        "rejected_incomplete": 0,
        "unmapped_conversations": [],
        "conv_ids": [1],
    }


def test_cli_encrypts_when_key_env_given(tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "collect_all", _fake_collect)
    monkeypatch.setenv("RAM_SNAPSHOT_KEY", "k" * 40)
    out = tmp_path / "snapshot.enc"
    code = tool.main(["--out", str(out), "--encrypt-key-env", "RAM_SNAPSHOT_KEY"])
    assert code == 0
    blob = out.read_bytes()
    assert blob.startswith(tool.MAGIC)
    # Cozulunce gecerli snapshot olmali
    payload = json.loads(tool.decrypt_bytes(blob, "k" * 40).decode("utf-8"))
    assert tool.verify_snapshot(payload)["ok"] is True


# ------------------------------------------- butun ama EKSIK ayrimi (3.8.3)
def _payload_with_chat(shortfall, stable, collected=None, records=None):
    records = records if records is not None else [rec(CHAT, "A1"), rec(CHAT, "A2")]
    per_chat = [
        {
            "jid": CHAT,
            "reported_total": 10,
            "collected": collected if collected is not None else len(records),
            "stable": stable,
            "shortfall": shortfall,
            "rounds": 3,
        }
    ]
    manifest = tool.build_manifest(
        session_id=201,
        gateway_id="1bd78836-c084",
        source_container_id="x",
        started_at="a",
        ended_at="b",
        per_chat=per_chat,
        records=records,
        duplicates=0,
        rejected_missing_identity=0,
        rejected_incomplete=0,
    )
    return {
        "kind": tool.SNAPSHOT_KIND,
        "schema": tool.SNAPSHOT_SCHEMA,
        "header": {"session_id": 201},
        "records": records,
        "manifest": manifest,
    }


def test_verify_separates_integrity_from_completeness():
    """Butunluk saglam ama yakalama eksik: `ok` FALSE olmali.

    Checksum tutuyor diye "yedek basarili" demek, 3.8.2'de kapattigimiz
    "sayilar yakinsiyor" yanilgisinin aynisidir.
    """
    res = tool.verify_snapshot(_payload_with_chat(shortfall=8, stable=False))
    assert res["ok"] is False
    assert res["integrity_problems"] == []
    assert res["completeness_problems"]
    assert any("shortfall" in p for p in res["problems"])


def test_verify_rejects_header_manifest_session_mismatch():
    payload = good_payload()
    payload["header"]["session_id"] = 999
    res = tool.verify_snapshot(payload)
    assert res["ok"] is False
    assert any("session_id" in p for p in res["problems"])


def test_verify_rejects_manifest_claiming_more_than_serialized():
    payload = good_payload()
    payload["manifest"]["chats"][0]["collected"] = 5  # 2 kayit var
    res = tool.verify_snapshot(payload)
    assert res["ok"] is False
    assert any("record_count" in p for p in res["problems"])


# ------------------------------------------------- geri yukleme: kume esitligi
def test_restore_in_memory_conserves_identity_set():
    payload = good_payload([rec(CHAT, "A1"), rec(CHAT2, "B1")])
    res = tool.restore_to_sqlite(":memory:", payload)
    assert res["restored_rows"] == 2
    assert res["distinct_conversations"] == 2
    assert res["identity_set_equal"] is True
    assert res["identity_conserved"] is True
    assert res["identity_root_matches"] is True
    assert res["restored_identity_root_sha256"] == payload["manifest"]["identity_root_sha256"]


def test_restore_compares_identity_sets_not_just_counts(tmp_path, monkeypatch):
    """Hedefte FAZLA satir varsa satir sayisi tutsa bile kabul edilmez."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db = tmp_path / "dolu.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE snapshot_messages (conversation_id TEXT NOT NULL,"
        " wa_message_id TEXT NOT NULL, direction TEXT, message_type TEXT,"
        " status TEXT, body TEXT, created_at TEXT, media_id TEXT,"
        " sender_phone TEXT, recipient_phone TEXT,"
        " PRIMARY KEY (conversation_id, wa_message_id))"
    )
    conn.execute("INSERT INTO snapshot_messages (conversation_id, wa_message_id) VALUES (?,?)",
                 ("yabanci-sohbet", "X1"))
    conn.commit()
    conn.close()

    res = tool.restore_to_sqlite(str(db), good_payload([rec(CHAT, "A1"), rec(CHAT, "A2")]))
    assert res["restored_rows"] == 3  # 2 yeni + 1 yabanci
    assert res["source_identity_count"] == 2
    assert res["restored_identity_count"] == 3
    assert res["identity_set_equal"] is False
    assert res["identity_conserved"] is False


def test_restore_normalises_integer_conversation_ids():
    """Gateway `conversation_id`'yi sayi dondurebilir; kimlik metne cevrilir."""
    payload = good_payload([rec(38289, "A1"), rec("38289", "A2")])
    res = tool.restore_to_sqlite(":memory:", payload)
    assert res["restored_rows"] == 2
    assert res["distinct_conversations"] == 1
    assert res["identity_conserved"] is True


# ------------------------------------------------------- stdin (3.8.3)
class _FakeStdin:
    def __init__(self, data: bytes):
        import io

        self.buffer = io.BytesIO(data)


def test_cli_verify_reads_stdin(tmp_path, monkeypatch):
    monkeypatch.setenv("RAM_SNAPSHOT_KEY", "k" * 40)
    blob = tool.encrypt_bytes(
        json.dumps(good_payload(), ensure_ascii=False).encode("utf-8"), "k" * 40
    )
    monkeypatch.setattr(tool.sys, "stdin", _FakeStdin(blob))
    code = tool.main(["--verify", "-", "--encrypt-key-env", "RAM_SNAPSHOT_KEY"])
    assert code == 0


def test_cli_verify_rejects_tampered_ciphertext(tmp_path, monkeypatch):
    """Sifreli dosyada tek bayt degisirse AES-GCM REDDETMELI."""
    monkeypatch.setenv("RAM_SNAPSHOT_KEY", "k" * 40)
    blob = bytearray(
        tool.encrypt_bytes(json.dumps(good_payload(), ensure_ascii=False).encode("utf-8"), "k" * 40)
    )
    blob[-1] ^= 0xFF
    path = tmp_path / "bozuk.enc"
    path.write_bytes(bytes(blob))
    code = tool.main(["--verify", str(path), "--encrypt-key-env", "RAM_SNAPSHOT_KEY"])
    assert code == 3


def test_cli_restore_from_stdin(tmp_path, monkeypatch):
    monkeypatch.setenv("RAM_SNAPSHOT_KEY", "k" * 40)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    blob = tool.encrypt_bytes(
        json.dumps(good_payload(), ensure_ascii=False).encode("utf-8"), "k" * 40
    )
    monkeypatch.setattr(tool.sys, "stdin", _FakeStdin(blob))
    code = tool.main(
        [
            "--restore-from", "-",
            "--restore-to", ":memory:",
            "--encrypt-key-env", "RAM_SNAPSHOT_KEY",
        ]
    )
    assert code == 0


def test_late_arrival_is_computed_not_assumed_zero():
    """Hesaplanmayan bir alani 0 diye raporlamak yalandir."""
    started = "2026-10-01T10:00:00Z"
    records = [
        rec(CHAT, "A1", ts="2026-10-01T09:59:00Z"),
        rec(CHAT, "A2", ts="2026-10-01T10:00:00Z"),  # tam sinirda: gec degil
        rec(CHAT, "A3", ts="2026-10-01T10:00:05Z"),
        rec(CHAT, "A4", ts="bozuk-tarih"),  # cozulemez: sayilmaz
    ]
    assert tool.count_late_arrivals(records, started) == 1
    # Pencere bilinmiyorsa 0 degil None doner.
    assert tool.count_late_arrivals(records, "bozuk-tarih") is None


def test_cli_dry_run_reports_real_late_arrival_count(tmp_path, monkeypatch, capsys):
    async def fake(*, page_size=2000, jids=None):
        data = await _fake_collect(page_size=page_size, jids=jids)
        data["records"] = [rec(CHAT, "A1"), rec(CHAT, "A2", ts="2099-01-01T00:00:00Z")]
        data["per_chat"][0]["collected"] = 2
        data["per_chat"][0]["reported_total"] = 2
        return data

    monkeypatch.setattr(tool, "collect_all", fake)
    code = tool.main(["--out", str(tmp_path / "x.json"), "--dry-run"])
    assert code == 0
    manifest = json.loads(capsys.readouterr().out)
    assert manifest["late_arrival_count"] == 1


def test_cli_verify_refuses_encrypted_without_key(tmp_path, monkeypatch):
    monkeypatch.delenv("RAM_SNAPSHOT_KEY", raising=False)
    blob = tool.encrypt_bytes(b'{"x":1}', "k" * 40)
    path = tmp_path / "k.enc"
    path.write_bytes(blob)
    assert tool.main(["--verify", str(path)]) == 1
