"""`hourly_snapshot.py` — saatlik snapshot orkestratoru testleri.

Neden bu testler var: bu betigin isi "her saat calisip veriyi korumak". Bir
zamanlanmis gorev icin en tehlikeli hata **sessiz basari**dir: eksik sayfayla
alınmis bir snapshot'i "tamam" diye yuklemek, hic yedek almamaktan kotudur
cunku insani yaniltir. Bu yuzden burada mutlu yol kadar **reddetme** de test
edilir:

* eksik sayfalama / butunluk hatasi snapshot'i YAYINLAMAZ ve YUKLEMEZ,
* gateway hatasi guvenli durur ve toplamayi TEKRARLAMAZ,
* OCI hatasi yerel kopyayi SILMEZ (degraded),
* iki gorev ayni anda calismaz (flock),
* yarim kalan upload ve SHA uyusmazligi basari sayilmaz,
* ayni object key ile tekrar yukleme idempotenttir, CONFLICT ise durur,
* var olan snapshot'in uzerine YAZILMAZ,
* log'a mesaj icerigi / anahtar / token girmez,
* sifreleme-cozme ve restore kimlik kumesini korur.

Testler tamamen sentetiktir: gercek gateway, gercek mesaj, ag veya konteyner
YOK. `collect`, `verify` ve `uploader` enjekte edilir; `docker`/`offsite_oci`
cagrilari da taklit edilir.
"""
import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_JOB_PATH = _REPO_ROOT / "scripts" / "backup" / "hourly_snapshot.py"
_SNAP_PATH = _REPO_ROOT / "scripts" / "diagnostics" / "ram_snapshot.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # `@dataclass` alan cozumlemesi `sys.modules[cls.__module__]` uzerinden
    # calisir; kayit yapilmazsa "NoneType has no __dict__" ile patlar.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


tool = _load("backup_hourly_snapshot", _JOB_PATH)
snap = _load("diagnostics_ram_snapshot_for_job", _SNAP_PATH)

# Sentetik anahtar: gercek escrow ile ilgisi yok, yalnizca >=32 karakter.
KEY = "test-only-key-" + "a" * 40
NOW = 1_700_000_000.0  # 2023-11-14T22:13:20Z
NAME = "tezlify-ram-20231114T221320Z"


# --------------------------------------------------------------------------
# Yardimcilar
# --------------------------------------------------------------------------
def manifest(records=3, chats=1, *, stable=True, shortfall=0):
    """Tutarli manifest: sohbet basina `collected` toplami `record_count`e esit.

    Bu esitlik kasitli: `verify_snapshot` tam olarak bunu denetler, dolayisiyla
    fixture'in kendisi de tutarli olmak zorunda.
    """
    base, extra = divmod(records, chats)
    per_chat = [
        {
            "jid": f"90555111{i:04d}@s.whatsapp.net",
            "reported_total": base + (1 if i < extra else 0),
            "collected": base + (1 if i < extra else 0),
            "rounds": 1,
            "stable": stable,
            "shortfall": shortfall,
        }
        for i in range(chats)
    ]
    recs = [
        {
            "conversation_id": str(100 + (i % chats)),
            "wa_message_id": f"wamid-{i}",
            "body": "sentetik",
            "created_at": "2026-10-30T09:00:00Z",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "status": "DELIVERED",
        }
        for i in range(records)
    ]
    m = snap.build_manifest(
        session_id=201,
        gateway_id="1bd78836-c084-4cbf-b333-9386d44b7bd7",
        source_container_id="test",
        started_at="2026-10-30T09:00:00Z",
        ended_at="2026-10-30T09:00:05Z",
        per_chat=per_chat,
        records=recs,
        duplicates=0,
        rejected_missing_identity=0,
        rejected_incomplete=0,
        late_arrival=0,
    )
    m["ram_total_reported"] = records * chats
    return m, recs


class Collector:
    def __init__(self, *, blob=None, man=None, error=None):
        self.blob = blob
        self.man = man
        self.error = error
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return tool.Collected(blob=self.blob, manifest=self.man)


class Verifier:
    def __init__(self, *, ok=True, problems=(), error=None):
        self.ok = ok
        self.problems = list(problems)
        self.error = error
        self.calls = 0

    def __call__(self, blob):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return {"ok": self.ok, "problems": self.problems}


class Uploader:
    """`offsite_oci.py` CLI'sini taklit eder; cagrilari kaydeder."""

    def __init__(self, *, upload_results=None, upload_error=None,
                 check_verified=True, check_error=None):
        self.upload_results = upload_results
        self.upload_error = upload_error
        self.check_verified = check_verified
        self.check_error = check_error
        self.uploads = []
        self.checks = []

    def upload(self, *, source, bucket, prefix, files, execute):
        self.uploads.append({"files": list(files), "execute": execute})
        if self.upload_error is not None:
            raise self.upload_error
        if not execute:
            return {"plan": []}
        if self.upload_results is not None:
            return {"results": self.upload_results}
        return {"results": [{"file": f, "status": "UPLOADED"} for f in files]}

    def download_check(self, *, source, bucket, prefix, files):
        self.checks.append({"files": list(files)})
        if self.check_error is not None:
            raise self.check_error
        return {
            "all_verified": self.check_verified,
            "rows": [{"file": f, "status": "VERIFIED" if self.check_verified else "HASH_MISMATCH"}
                     for f in files],
        }


def payload_bytes(records=3):
    man, recs = manifest(records=records)
    body = {
        "kind": snap.SNAPSHOT_KIND,
        "schema": snap.SNAPSHOT_SCHEMA,
        "header": {"session_id": 201},
        "records": recs,
        "manifest": man,
    }
    return json.dumps(body, ensure_ascii=False).encode("utf-8"), man


def run(tmp_path, *, collector=None, verifier=None, uploader=None, **kw):
    blob, man = payload_bytes()
    collector = collector or Collector(blob=blob, man=man)
    verifier = verifier or Verifier()
    params = dict(
        source=tmp_path,
        bucket="b",
        prefix="tezlify/whatsapp/ram-snapshots",
        execute=True,
        collect=collector,
        verify=verifier,
        uploader=uploader or Uploader(),
        log_path=tmp_path / "snapshot.jsonl",
        now=NOW,
        attempts=2,
        backoff=(0.0, 0.0),
        sleep=lambda _s: None,
    )
    params.update(kw)
    return tool.run_job(**params), collector, verifier


def read_log(path):
    lines = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    return lines


# --------------------------------------------------------------------------
# 1) Mutlu yol
# --------------------------------------------------------------------------
def test_normal_snapshot_publishes_encrypted_files(tmp_path):
    res, collector, verifier = run(tmp_path)

    assert res.status == "OK"
    assert res.exit_code == tool.EXIT_OK
    assert collector.calls == 1 and verifier.calls == 1

    rsnap = tmp_path / f"{NAME}.rsnap"
    man = tmp_path / f"{NAME}.manifest.json"
    assert rsnap.exists() and man.exists()
    # PII iceren dosya yalnizca sahibine acik olmali.
    assert stat.S_IMODE(rsnap.stat().st_mode) == 0o600
    assert stat.S_IMODE(man.stat().st_mode) == 0o600
    assert res.detail["rsnap_sha256"] == hashlib.sha256(rsnap.read_bytes()).hexdigest()
    assert res.detail["remote_verified"] is True


def test_normal_snapshot_uploads_both_files_and_verifies_remotely(tmp_path):
    up = Uploader()
    res, _, _ = run(tmp_path, uploader=up)

    assert res.status == "OK"
    # once dry-run plan, sonra gercek yukleme
    assert [u["execute"] for u in up.uploads] == [False, True]
    assert up.uploads[1]["files"] == [f"{NAME}.rsnap", f"{NAME}.manifest.json"]
    assert len(up.checks) == 1


def test_no_partial_files_remain_after_success(tmp_path):
    run(tmp_path)
    incoming = tmp_path / tool.INCOMING_DIR
    leftovers = list(incoming.glob("*.partial")) if incoming.exists() else []
    assert leftovers == []


def test_lock_is_released_after_job(tmp_path):
    first, _, _ = run(tmp_path)
    assert first.status == "OK"
    # kilit birakilmis olmali; ayni dizinde ikinci tur calisabilir
    second, _, _ = run(tmp_path, now=NOW + 3600)
    assert second.status == "OK"
    assert second.name != first.name


# --------------------------------------------------------------------------
# 2) Eksik sayfalama / butunluk -> RED
# --------------------------------------------------------------------------
def test_missing_page_is_rejected_and_never_uploaded(tmp_path):
    up = Uploader()
    verifier = Verifier(ok=False, problems=["shortfall>0 olan sohbet var"])
    res, _, _ = run(tmp_path, verifier=verifier, uploader=up)

    assert res.status == "REJECTED"
    assert res.exit_code == tool.EXIT_REJECTED
    assert "shortfall" in (res.error or "")
    # Ne yayinlandi ne yuklendi.
    assert not (tmp_path / f"{NAME}.rsnap").exists()
    assert up.uploads == [] and up.checks == []


def test_verifier_exception_is_a_rejection_not_a_crash(tmp_path):
    verifier = Verifier(error=tool.SnapshotRejected("checksum tutmuyor"))
    res, _, _ = run(tmp_path, verifier=verifier)
    assert res.status == "REJECTED"
    assert res.exit_code == tool.EXIT_REJECTED


def test_rejected_snapshot_keeps_previous_snapshot_intact(tmp_path):
    # Onceki basarili snapshot
    run(tmp_path)
    old = tmp_path / f"{NAME}.rsnap"
    before = old.read_bytes()

    verifier = Verifier(ok=False, problems=["kararsiz sohbet"])
    res, _, _ = run(tmp_path, verifier=verifier, now=NOW + 3600)

    assert res.status == "REJECTED"
    assert old.read_bytes() == before  # dokunulmadi
    assert not (tmp_path / "tezlify-ram-20231114T231320Z.rsnap").exists()


# --------------------------------------------------------------------------
# 3) Gateway hatasi -> guvenli durus, RETRY YOK
# --------------------------------------------------------------------------
def test_gateway_error_stops_safely_and_is_not_retried(tmp_path):
    collector = Collector(error=tool.CollectFailed("gateway yanit vermiyor"))
    up = Uploader()
    res, _, _ = run(tmp_path, collector=collector, uploader=up)

    assert res.status == "COLLECT_FAILED"
    assert res.exit_code == tool.EXIT_COLLECT_FAILED
    # Ikinci toplama farkli bir anin goruntusu olurdu: ASLA tekrarlanmaz.
    assert collector.calls == 1
    assert up.uploads == []
    assert not (tmp_path / f"{NAME}.rsnap").exists()


def test_unexpected_collect_exception_is_classified(tmp_path):
    class Boom(Exception):
        pass

    collector = Collector(error=Boom("beklenmeyen"))
    res, _, _ = run(tmp_path, collector=collector)
    assert res.status == "COLLECT_FAILED"
    assert "Boom" in (res.error or "")


# --------------------------------------------------------------------------
# 4) OCI hatasi -> yerel kopya korunur
# --------------------------------------------------------------------------
def test_oci_error_keeps_local_encrypted_snapshot(tmp_path):
    up = Uploader(upload_error=tool.UploadFailed("OCI erisilemedi"))
    res, _, _ = run(tmp_path, uploader=up)

    assert res.status == "DEGRADED_LOCAL_ONLY"
    assert res.exit_code == tool.EXIT_DEGRADED
    rsnap = tmp_path / f"{NAME}.rsnap"
    assert rsnap.exists(), "uzak hata yerel kopyayi silmemeli"
    assert rsnap.stat().st_size > 0


def test_partial_upload_is_degraded(tmp_path):
    up = Uploader(upload_results=[
        {"file": f"{NAME}.rsnap", "status": "UPLOADED"},
        {"file": f"{NAME}.manifest.json", "status": "FAILED"},
    ])
    res, _, _ = run(tmp_path, uploader=up)
    assert res.status == "DEGRADED_LOCAL_ONLY"
    assert res.detail["upload_status"] == "FAILED"
    assert (tmp_path / f"{NAME}.rsnap").exists()


def test_sha_mismatch_on_download_check_is_degraded(tmp_path):
    up = Uploader(check_verified=False)
    res, _, _ = run(tmp_path, uploader=up)
    assert res.status == "DEGRADED_LOCAL_ONLY"
    assert res.detail["remote_verified"] is False
    assert (tmp_path / f"{NAME}.rsnap").exists()


# --------------------------------------------------------------------------
# 5) Eszamanli calisma
# --------------------------------------------------------------------------
def test_second_job_is_refused_while_lock_is_held(tmp_path):
    up = Uploader()
    with tool.JobLock(tmp_path / tool.LOCK_NAME):
        res, collector, _ = run(tmp_path, uploader=up)

    assert res.status == "ALREADY_RUNNING"
    assert res.exit_code == tool.EXIT_ALREADY_RUNNING
    # Reddedilen gorev hic toplamadi, hic yuklemedi.
    assert collector.calls == 0
    assert up.uploads == []
    assert not (tmp_path / f"{NAME}.rsnap").exists()


def test_lock_file_is_0600_and_does_not_block_after_release(tmp_path):
    lock_path = tmp_path / tool.LOCK_NAME
    with tool.JobLock(lock_path):
        assert stat.S_IMODE(lock_path.stat().st_mode) == 0o600
    # serbest birakildiktan sonra yeniden alinabilir
    with tool.JobLock(lock_path):
        pass


# --------------------------------------------------------------------------
# 6) Ayni object key / CONFLICT
# --------------------------------------------------------------------------
def test_same_object_key_upload_is_idempotent(tmp_path):
    up = Uploader(upload_results=[
        {"file": f"{NAME}.rsnap", "status": "ALREADY_PRESENT"},
        {"file": f"{NAME}.manifest.json", "status": "ALREADY_PRESENT"},
    ])
    res, _, _ = run(tmp_path, uploader=up)
    assert res.status == "OK"
    assert res.detail["upload_status"] == "ALREADY_PRESENT"


def test_conflict_is_not_retried(tmp_path):
    up = Uploader(upload_results=[{"file": f"{NAME}.rsnap", "status": "CONFLICT"}])
    res, _, _ = run(tmp_path, uploader=up, attempts=3)

    assert res.status == "CONFLICT"
    assert res.exit_code == tool.EXIT_CONFLICT
    # CONFLICT'te tekrar denemek zararli: tam olarak bir gercek yukleme denemesi.
    real = [u for u in up.uploads if u["execute"]]
    assert len(real) == 1


def test_existing_snapshot_file_is_never_overwritten(tmp_path):
    existing = tmp_path / f"{NAME}.rsnap"
    existing.write_bytes(b"ONCEKI-KOPYA")
    os.chmod(existing, 0o600)

    res, collector, _ = run(tmp_path)

    assert res.status == "CONFLICT"
    assert res.exit_code == tool.EXIT_CONFLICT
    assert existing.read_bytes() == b"ONCEKI-KOPYA"
    # Uzerine yazma denemesi yayindan once durur: toplama yapilmis olabilir
    # ama yukleme yapilmaz.
    assert collector.calls == 1


# --------------------------------------------------------------------------
# 7) Sifreleme / cozme
# --------------------------------------------------------------------------
def test_encrypt_decrypt_roundtrip_preserves_bytes():
    data, _ = payload_bytes()
    blob = snap.encrypt_bytes(data, KEY)

    assert blob.startswith(snap.MAGIC)
    assert blob != data
    assert snap.decrypt_bytes(blob, KEY) == data


def test_wrong_key_cannot_decrypt():
    data, _ = payload_bytes()
    blob = snap.encrypt_bytes(data, KEY)
    with pytest.raises(Exception):
        snap.decrypt_bytes(blob, "another-key-" + "b" * 40)


def test_encrypted_blob_does_not_leak_plaintext():
    data, _ = payload_bytes()
    blob = snap.encrypt_bytes(data, KEY)
    assert b"wamid-0" not in blob
    assert b"90555111" not in blob


# --------------------------------------------------------------------------
# 8) Restore + identity root
# --------------------------------------------------------------------------
def test_restore_preserves_identity_root(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    data, man = payload_bytes(records=5)
    payload = json.loads(data.decode("utf-8"))

    res = snap.restore_to_sqlite(":memory:", payload)

    assert res["restored_rows"] == 5
    assert res["identity_set_equal"] is True
    assert res["identity_root_matches"] is True
    assert res["restored_identity_root_sha256"] == man["identity_root_sha256"]


def test_published_snapshot_is_restorable_end_to_end(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    blob, man = payload_bytes(records=4)
    res, _, _ = run(tmp_path, collector=Collector(blob=blob, man=man))
    assert res.status == "OK"

    on_disk = (tmp_path / f"{NAME}.rsnap").read_bytes()
    payload = json.loads(on_disk.decode("utf-8"))
    restored = snap.restore_to_sqlite(":memory:", payload)

    assert restored["identity_conserved"] is True
    assert restored["restored_identity_root_sha256"] == man["identity_root_sha256"]


# --------------------------------------------------------------------------
# 9) Log ve gizlilik
# --------------------------------------------------------------------------
def test_log_line_contains_only_whitelisted_fields(tmp_path):
    run(tmp_path)
    rec = read_log(tmp_path / "snapshot.jsonl")[-1]

    assert rec["status"] == "OK"
    assert set(rec) <= set(tool.LOG_FIELDS)
    assert "body" not in rec and "records" not in rec
    text = json.dumps(rec, ensure_ascii=False)
    assert "sentetik" not in text
    assert "wamid-" not in text


def test_log_never_contains_key_or_token(tmp_path):
    leaky = tool.UploadFailed(
        f"auth failed bearer {base64.b64encode(b'secret-token').decode()} "
        f"key={KEY} signature=abc123"
    )
    run(tmp_path, uploader=Uploader(upload_error=leaky))
    text = (tmp_path / "snapshot.jsonl").read_text(encoding="utf-8")

    assert KEY not in text
    assert "secret-token" not in text
    assert "signature=abc123" not in text
    assert "<redacted>" in text


@pytest.mark.parametrize("raw", [
    "a" * 64,
    "Bearer abcdefghijklmnop",
    "signature=AAAA1111BBBB2222",
    base64.b64encode(b"x" * 60).decode(),
])
def test_scrub_masks_secret_shapes(raw):
    out = tool.scrub(raw)
    assert raw not in out


def test_scrub_truncates_long_messages():
    assert len(tool.scrub("x" * 5000)) <= 300


# --------------------------------------------------------------------------
# 10) Depolama projeksiyonu
# --------------------------------------------------------------------------
def test_estimate_is_linear_and_matches_windows():
    est = tool.estimate_storage(rsnap_bytes=1_000_000, manifest_bytes=10_000)
    per = 1_010_000

    assert est["per_run_bytes"] == per
    assert est["windows"]["24h"]["bytes"] == per * 24
    assert est["windows"]["168h"]["bytes"] == per * 168
    assert est["windows"]["720h"]["bytes"] == per * 720


def test_estimate_reports_gib():
    est = tool.estimate_storage(rsnap_bytes=7_181_099, manifest_bytes=16_957)
    assert est["windows"]["720h"]["GiB"] > 4.0


# --------------------------------------------------------------------------
# 11) Guvenlik kapilari / CLI
# --------------------------------------------------------------------------
def test_refuses_source_inside_repo():
    res = tool.run_job(
        source=_REPO_ROOT / "scripts",
        bucket="b",
        prefix="p",
        execute=False,
        collect=lambda: None,
        verify=lambda _b: {"ok": True},
        uploader=None,
        now=NOW,
    )
    assert res.exit_code == tool.EXIT_USAGE
    assert "depo icinde" in (res.error or "")


def test_dry_run_does_not_upload(tmp_path):
    up = Uploader()
    res, _, _ = run(tmp_path, uploader=up, execute=False)
    assert res.status == "DRY_RUN"
    assert res.exit_code == tool.EXIT_OK
    assert up.uploads == []
    assert (tmp_path / f"{NAME}.rsnap").exists()


def test_cli_execute_requires_approval_env(monkeypatch, capsys):
    monkeypatch.delenv("TEZLIFY_OFFSITE_APPROVED", raising=False)
    rc = tool.main(["run", "--execute", "--bucket", "b", "--source", "/tmp/x"])
    assert rc == tool.EXIT_USAGE
    assert "TEZLIFY_OFFSITE_APPROVED" in capsys.readouterr().err


def test_cli_execute_requires_bucket(monkeypatch, capsys):
    monkeypatch.setenv("TEZLIFY_OFFSITE_APPROVED", "1")
    rc = tool.main(["run", "--execute", "--source", "/tmp/x"])
    assert rc == tool.EXIT_USAGE
    assert "bucket" in capsys.readouterr().err


def test_cli_refuses_conflicting_execute_and_no_upload(monkeypatch, capsys):
    monkeypatch.setenv("TEZLIFY_OFFSITE_APPROVED", "1")
    rc = tool.main(["run", "--execute", "--no-upload", "--bucket", "b",
                    "--source", "/tmp/x"])
    assert rc == tool.EXIT_USAGE
    assert "celiskili" in capsys.readouterr().err


# --------------------------------------------------------------------------
# 12) Konteyner cagrisi: stdin cakismasi yok
# --------------------------------------------------------------------------
def test_collect_uses_python_c_so_stdin_stays_free(monkeypatch, tmp_path):
    script = tmp_path / "ram_snapshot.py"
    script.write_text("# sentetik kaynak\n", encoding="utf-8")
    captured = {}

    class Proc:
        returncode = 0
        stdout = tool.MAGIC + b"cipher"
        stderr = ('log satiri\n{"kind": "tezlify.ram_snapshot", "record_count": 7}\n'
                  ).encode()

    def fake_docker(args, *, stdin, timeout):
        captured["args"] = list(args)
        captured["stdin"] = stdin
        return Proc()

    monkeypatch.setattr(tool, "_docker", fake_docker)
    got = tool.docker_collect(container="c", script_path=script, key_env="K")

    assert captured["args"][:5] == ["docker", "exec", "-i", "c", "python"]
    assert captured["args"][5] == "-c"
    assert captured["args"][6] == "# sentetik kaynak\n"
    # Toplamada stdin BOS: betik argv'de.
    assert captured["stdin"] == b""
    assert got.blob == tool.MAGIC + b"cipher"
    assert got.manifest["record_count"] == 7


def test_verify_pipes_blob_to_stdin(monkeypatch, tmp_path):
    script = tmp_path / "ram_snapshot.py"
    script.write_text("# sentetik kaynak\n", encoding="utf-8")
    captured = {}
    blob = tool.MAGIC + b"cipher"

    class Proc:
        returncode = 0
        stdout = b'{"ok": true, "problems": []}'
        stderr = b""

    def fake_docker(args, *, stdin, timeout):
        captured["args"] = list(args)
        captured["stdin"] = stdin
        return Proc()

    monkeypatch.setattr(tool, "_docker", fake_docker)
    res = tool.verify_blob(container="c", script_path=script, key_env="K", blob=blob)

    assert res["ok"] is True
    assert captured["args"][5] == "-c"
    assert "--verify" in captured["args"]
    assert captured["stdin"] == blob, "blob stdin ile gitmeli"


def test_collect_rejects_blob_without_magic(monkeypatch, tmp_path):
    script = tmp_path / "ram_snapshot.py"
    script.write_text("# x\n", encoding="utf-8")

    class Proc:
        returncode = 0
        stdout = b"NOT-A-SNAPSHOT"
        stderr = b""

    monkeypatch.setattr(tool, "_docker", lambda a, *, stdin, timeout: Proc())
    with pytest.raises(tool.CollectFailed):
        tool.docker_collect(container="c", script_path=script, key_env="K")


def test_collect_reports_nonzero_exit(monkeypatch, tmp_path):
    script = tmp_path / "ram_snapshot.py"
    script.write_text("# x\n", encoding="utf-8")

    class Proc:
        returncode = 2
        stdout = b""
        stderr = b"CONNECTED oturum yok"

    monkeypatch.setattr(tool, "_docker", lambda a, *, stdin, timeout: Proc())
    with pytest.raises(tool.CollectFailed) as exc:
        tool.docker_collect(container="c", script_path=script, key_env="K")
    assert "CONNECTED oturum yok" in str(exc.value)


def test_missing_manifest_in_stderr_is_an_error(monkeypatch, tmp_path):
    script = tmp_path / "ram_snapshot.py"
    script.write_text("# x\n", encoding="utf-8")

    class Proc:
        returncode = 0
        stdout = tool.MAGIC + b"cipher"
        stderr = b"sadece log, manifest yok"

    monkeypatch.setattr(tool, "_docker", lambda a, *, stdin, timeout: Proc())
    with pytest.raises(tool.CollectFailed):
        tool.docker_collect(container="c", script_path=script, key_env="K")


def test_manifest_is_taken_from_last_valid_json_line():
    stderr = "\n".join([
        '{"kind": "other", "record_count": 1}',
        '{"kind": "tezlify.ram_snapshot", "record_count": 9}',
        "WARNING: bir sey",
        "",
    ])
    assert tool._last_manifest(stderr)["record_count"] == 9


def test_upload_verdict_maps_statuses():
    assert tool._upload_verdict({"results": []}, execute=False)["upload_status"] == "DRY_RUN_PLANNED"
    assert tool._upload_verdict(
        {"results": [{"status": "CONFLICT"}]}, execute=True)["conflict"] is True
    assert tool._upload_verdict(
        {"results": [{"status": "FAILED"}]}, execute=True)["failed"] is True
    ok = tool._upload_verdict(
        {"results": [{"status": "UPLOADED"}, {"status": "ALREADY_PRESENT"}]}, execute=True)
    assert ok["failed"] is False and ok["upload_status"] == "UPLOADED"


# --------------------------------------------------------------------------
# 13) offsite_oci cikti bicimi — 3.9.18'de canli kosumda yakalanan hata
# --------------------------------------------------------------------------
class _Proc:
    def __init__(self, stdout="", stderr="", rc=0):
        self.stdout = stdout.encode() if isinstance(stdout, str) else stdout
        self.stderr = stderr.encode() if isinstance(stderr, str) else stderr
        self.returncode = rc


def _patch_run(monkeypatch, proc):
    calls = []

    def fake_run(argv, **kw):
        calls.append(list(argv))
        return proc

    monkeypatch.setattr(tool.subprocess, "run", fake_run)
    return calls


def test_offsite_run_parses_json_followed_by_dry_run_banner(monkeypatch, tmp_path):
    """GERCEK cikti bicimi: plan JSON'u + ardindan "[DRY-RUN] ..." satiri.

    `json.loads` bu ciktiyi yutamaz; 3.9.18'de ilk canli kosumda upload tam
    olarak bu yuzden dustu. `raw_decode` ilk JSON degerini alip gerisini yok sayar.
    """
    out = (
        '{\n  "bucket": "b",\n  "prefix": "p",\n  "escrow_blocked": [],\n'
        '  "plan": [{"file": "x.rsnap", "bytes": 1}]\n}\n'
        '\n[DRY-RUN] Ag yazimi yapilmadi. Gercek aktarim icin --execute '
        '+ TEZLIFY_OFFSITE_APPROVED=1 gerekir.\n'
    )
    _patch_run(monkeypatch, _Proc(stdout=out))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py")
    got = up.upload(source=tmp_path, bucket="b", prefix="p",
                    files=["x.rsnap"], execute=False)
    assert got["bucket"] == "b"
    assert got["plan"][0]["file"] == "x.rsnap"


def test_offsite_run_takes_last_json_when_upload_prints_plan_and_results(monkeypatch, tmp_path):
    """GERCEK `--execute` cikti bicimi: plan JSON'u + sonuc JSON'u.

    `offsite_oci.py upload --execute` once plani, sonra sonucu basar. Ilk nesne
    alinirsa `results` bos gorunur ve BASARILI yukleme "UNKNOWN" diye raporlanir.
    3.9.18'de canli kosumda tam bu oldu: iki nesne bucket'a gitti ama gorev
    DEGRADED dedi.
    """
    out = (
        '{\n  "bucket": "b",\n  "prefix": "p",\n  "escrow_blocked": [],\n'
        '  "plan": [{"file": "x.rsnap", "bytes": 1}]\n}\n'
        '{\n  "results": [\n'
        '    {"file": "x.rsnap", "status": "UPLOADED", "http": 200},\n'
        '    {"file": "x.manifest.json", "status": "UPLOADED", "http": 200}\n'
        '  ]\n}\n'
    )
    _patch_run(monkeypatch, _Proc(stdout=out))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py")
    got = up.upload(source=tmp_path, bucket="b", prefix="p",
                    files=["x.rsnap", "x.manifest.json"], execute=True)
    assert "results" in got, "sonuc nesnesi (plan degil) alinmali"
    assert [r["status"] for r in got["results"]] == ["UPLOADED", "UPLOADED"]
    assert tool._upload_verdict(got, execute=True)["failed"] is False


def test_iter_json_objects_skips_junk_and_finds_all():
    text = 'log satiri\n{"a": 1}\n[DRY-RUN] ara metin\n{bozuk\n{"b": 2}\n'
    docs = list(tool._iter_json_objects(text))
    assert docs == [{"a": 1}, {"b": 2}]


def test_iter_json_objects_returns_empty_for_plain_text():
    assert list(tool._iter_json_objects("LIST FAILED HTTP 500")) == []


def test_offsite_run_parses_pure_json(monkeypatch, tmp_path):
    _patch_run(monkeypatch, _Proc(stdout='{"results": [{"status": "UPLOADED"}]}'))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py")
    got = up.upload(source=tmp_path, bucket="b", prefix="p",
                    files=["x.rsnap"], execute=True)
    assert got["results"][0]["status"] == "UPLOADED"


def test_offsite_run_rejects_output_without_json(monkeypatch, tmp_path):
    _patch_run(monkeypatch, _Proc(stdout="LIST FAILED HTTP 500", stderr="boom", rc=3))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py")
    with pytest.raises(tool.UploadFailed):
        up.upload(source=tmp_path, bucket="b", prefix="p", files=["x.rsnap"], execute=False)


def test_offsite_run_rejects_non_object_json(monkeypatch, tmp_path):
    _patch_run(monkeypatch, _Proc(stdout="[1, 2, 3]"))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py")
    with pytest.raises(tool.UploadFailed):
        up.upload(source=tmp_path, bucket="b", prefix="p", files=["x.rsnap"], execute=False)


def test_offsite_upload_builds_expected_argv(monkeypatch, tmp_path):
    calls = _patch_run(monkeypatch, _Proc(stdout='{"plan": []}'))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py", python="py")
    up.upload(source=tmp_path, bucket="bk", prefix="pf",
              files=["a.rsnap", "b.manifest.json"], execute=True)
    argv = calls[0]
    assert argv[:3] == ["py", str(tmp_path / "offsite_oci.py"), "upload"]
    assert argv.count("--only") == 2
    assert "--execute" in argv
    # sirasi onemli: --only <dosya> ciftleri
    assert "a.rsnap" in argv and "b.manifest.json" in argv


def test_offsite_upload_omits_execute_in_dry_run(monkeypatch, tmp_path):
    calls = _patch_run(monkeypatch, _Proc(stdout='{"plan": []}'))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py", python="py")
    up.upload(source=tmp_path, bucket="bk", prefix="pf", files=["a.rsnap"], execute=False)
    assert "--execute" not in calls[0]


def test_offsite_download_check_uses_download_check_flag(monkeypatch, tmp_path):
    calls = _patch_run(monkeypatch, _Proc(stdout='{"all_verified": true, "rows": []}'))
    up = tool.OffsiteUploader(tmp_path / "offsite_oci.py", python="py")
    got = up.download_check(source=tmp_path, bucket="bk", prefix="pf", files=["a.rsnap"])
    assert got["all_verified"] is True
    assert "--download-check" in calls[0]


def test_job_survives_real_dry_run_banner_shape(tmp_path, monkeypatch):
    """Orkestratorun tamami: gercek ciktilar artik akisi bozmuyor."""
    real_uploader = tool.OffsiteUploader(tmp_path / "offsite_oci.py", python="py")

    outputs = [
        # 1) dry-run: plan + "[DRY-RUN]" banner
        _Proc(stdout='{"plan": []}\n\n[DRY-RUN] yazilmadi\n'),
        # 2) gercek yukleme: plan + sonuc (IKI JSON)
        _Proc(stdout='{"plan": []}\n{"results": ['
                     '{"file": "a", "status": "UPLOADED"}, '
                     '{"file": "b", "status": "UPLOADED"}]}\n'),
        # 3) download-check
        _Proc(stdout='{"all_verified": true, "rows": []}'),
    ]
    seq = iter(outputs)
    monkeypatch.setattr(tool.subprocess, "run", lambda argv, **kw: next(seq))

    res, _, _ = run(tmp_path, uploader=real_uploader)
    assert res.status == "OK"
    assert res.detail["remote_verified"] is True
    assert res.detail["upload_status"] == "UPLOADED"
