#!/usr/bin/env python3
"""Saatlik sifreli RAM snapshot orkestratoru (SALT OKUNUR).

## Neden bu betik var

Gateway `messagesByChat` deposu yalnizca RAM'de durur ve restart'ta geri
yuklenmez (A6). Sohbet basina 2.000 siniri olan sohbetlerde her yeni mesaj bir
eskiyi sessizce atar; 3.9.16'da bu kayip **olculdu** (~1,7 mesaj/saat) ve
RAM'den dusen 20 mesajin **0'i** DB'de bulundu. Yani beklemenin maliyeti
gercek. Bu betik, var olan araclari saatlik bir donguye baglar:

* `scripts/diagnostics/ram_snapshot.py` — toplama, sifreleme, dogrulama
* `scripts/backup/offsite_oci.py`       — upload, indirme, uzak dogrulama

**Yeni bir yedekleme bicimi IHDAS ETMEZ.** Ayni `.rsnap` semasi, ayni
AES-256-GCM zarf, ayni manifest, ayni object key duzeni kullanilir. Buradaki
tek yeni sey orkestrasyon, kilit ve hata korumasidir.

## Neden anahtar HOST'a hic gelmiyor

Sifreleme backend konteynerinin icinde yapilir ve anahtar oradan
`GATEWAY_ENCRYPTION_KEY` ortam degiskeniyle okunur. Betik anahtari **hicbir
zaman** okumaz, arguman olarak almaz, log'a yazmaz. Host'ta anahtar diye bir
sey yoktur; bu yuzden "anahtar sizdi mi" sorusu bu bilesende olusamaz.

## Neden `docker exec` + `python -c`

Konteynere dosya yazmak yasak ve imajda `ram_snapshot.py` YOK (olculdu:
`/app/scripts/...` bos). Betik kaynagi `python -c` ile argv'den verilir, boylece
**stdin serbest kalir**:

* toplama: stdin kullanilmaz, sifreli blob stdout'a akar;
* dogrulama: stdin'e blob akitilir (`--verify -`), sonuc stdout'tan JSON okunur.

`python -` (stdin'den betik) kullanilsaydi dogrulamada betik ile blob ayni
stdin'i ister ve biri bos okurdu. `-c` bu cakismayi ortadan kaldirir. Kaynak
argv'de gorunur ama icinde sir YOKTUR (anahtar yalnizca konteyner ortaminda,
adindan ibarettir).

## Degismez kurallar (kodda zorlanir)

1. **Tek eşzamanlı gorev** — `flock(LOCK_EX|LOCK_NB)`; kilit alinamazsa is
   YAPILMAZ (exit 5). Kilit `flock` oldugu icin surec olse bile cekirdek
   birakir; bayat kilit dosyasi kilitlemez.
2. **Once yerel, sonra uzak** — snapshot once yerelde yayinlanir, sonra
   yuklenir. Uzak taraf patlasa bile yerel kopya kalir.
3. **Eksik sayfalama basari degildir** — `verify_snapshot` `ok=False` derse
   snapshot yayinlanmaz, yuklenmez (exit 3). `.partial` dosyasi teshis icin
   saklanir.
4. **Uzerine yazma yok** — hedef ad varsa `ObjectConflict` (exit 6). Onceki
   basarili snapshot asla silinmez, degistirilmez.
5. **Yukleme sonrasi geri indirme** — `--download-check` ile uzaktan indirilip
   SHA-256 karsilastirilir; tutmazsa basarili sayilmaz (exit 4).
6. **Kontrollu retry** — yalnizca yukleme/dogrulama adimi denenir. Toplama
   ASLA tekrarlanmaz: ikinci toplama farkli bir anin goruntusudur ve "ayni
   snapshot" diye etiketlenemez.
7. **Log'a icerik girmez** — yalnizca sayilar, hash'ler, durum ve siniflandirilmis
   hata metni. `scrub()` uzun hex/base64 ve `Bearer`/`Signature` kaliplarini
   maskeler.

## Retention

**Otomatik silme YOKTUR.** Bu betik hicbir dosyayi silmez. Depolama
projeksiyonu icin `estimate` alt komutu vardir; silme politikasi ayri bir
tasarim ve ayri onay ister.

## Kullanim

    # yerel snapshot al, yukleme (plan asamasinda kal)
    hourly_snapshot.py run

    # gercek yukleme (TEZLIFY_OFFSITE_APPROVED=1 ayrica gerekir)
    hourly_snapshot.py run --execute --bucket <bucket>

    # depolama projeksiyonu
    hourly_snapshot.py estimate --source /var/backups/tezlify-ram

Cikis kodlari:
    0 = basarili (veya bilincli DRY_RUN)
    1 = kullanim/yapilandirma hatasi
    2 = toplama basarisiz (gateway/oturum) — guvenli durdu
    3 = snapshot REDDEDILDI (butunluk/tamlik) — yayinlanmadi
    4 = yukleme/uzak dogrulama basarisiz — yerel kopya korundu
    5 = zaten calisan bir gorev var
    6 = uzakta ayni anahtar farkli icerikle var (CONFLICT)
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_COLLECT_FAILED = 2
EXIT_REJECTED = 3
EXIT_DEGRADED = 4
EXIT_ALREADY_RUNNING = 5
EXIT_CONFLICT = 6

MAGIC = b"RSNAP1"
SNAPSHOT_KIND = "tezlify.ram_snapshot"
NAME_RE = re.compile(r"^tezlify-ram-\d{8}T\d{6}Z$")
LOCK_NAME = ".snapshot.lock"
INCOMING_DIR = ".incoming"

#: Log'a yazilabilecek alanlar. Beyaz liste: yeni bir alan kazara PII tasimasin.
LOG_FIELDS = (
    "ts",
    "status",
    "exit_code",
    "name",
    "record_count",
    "chat_count",
    "ram_total_reported",
    "rsnap_bytes",
    "manifest_bytes",
    "rsnap_sha256",
    "upload_status",
    "remote_verified",
    "attempts",
    "seconds",
    "error",
)

_HEX64 = re.compile(r"\b[0-9a-fA-F]{32,}\b")
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}")
_SIGNATURE = re.compile(r"(?i)signature=[^,\s]+")
_B64 = re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b")


# --------------------------------------------------------------------------
# Hatalar
# --------------------------------------------------------------------------
class SnapshotError(Exception):
    """Siniflandirilmis hata; `exit_code` tasir."""

    exit_code = EXIT_USAGE

    def __init__(self, message: str) -> None:
        super().__init__(message)


class AlreadyRunning(SnapshotError):
    exit_code = EXIT_ALREADY_RUNNING


class CollectFailed(SnapshotError):
    exit_code = EXIT_COLLECT_FAILED


class SnapshotRejected(SnapshotError):
    exit_code = EXIT_REJECTED


class UploadFailed(SnapshotError):
    exit_code = EXIT_DEGRADED


class ObjectConflict(SnapshotError):
    exit_code = EXIT_CONFLICT


# --------------------------------------------------------------------------
# Gizlilik
# --------------------------------------------------------------------------
def scrub(text: str, limit: int = 300) -> str:
    """Hata metnini log'a yazilabilir hale getirir.

    Mesaj govdesi, anahtar, token veya imza log'a girmemeli. Uzun hex/base64
    dizileri (anahtar/hash/token olabilir) ve `Bearer`/`Signature` kaliplari
    maskelenir. Metin kirpilir: bir istisna mesaji butun bir snapshot'i
    tasimasin.
    """
    if text is None:
        return ""
    out = str(text)
    out = _BEARER.sub(r"\1 <redacted>", out)
    out = _SIGNATURE.sub("signature=<redacted>", out)
    out = _HEX64.sub("<hex>", out)
    out = _B64.sub("<b64>", out)
    out = " ".join(out.split())
    return out[:limit]


def log_line(path: Optional[Path], record: Mapping[str, Any]) -> None:
    """JSON satiri yazar; yalnizca beyaz listedeki alanlar."""
    if path is None:
        return
    clean = {k: record[k] for k in LOG_FIELDS if k in record}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(clean, ensure_ascii=False, sort_keys=True) + "\n")
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Kilit
# --------------------------------------------------------------------------
class JobLock:
    """Sureçler arasi tekil calisma kilidi.

    `flock` kullanilir: kilit dosyanin kendisinde degil, acik dosya
    tanimlayicisindadir. Surec olurse cekirdek kilidi birakir; yani "bayat
    kilit" diye bir durum olusmaz ve elle silme gerekmez.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._fh = None

    def __enter__(self) -> "JobLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        fh = os.fdopen(fd, "r+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            fh.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise AlreadyRunning(
                    "baska bir snapshot gorevi calisiyor (kilit dolu)"
                ) from exc
            raise
        fh.seek(0)
        fh.truncate()
        fh.write(f"{os.getpid()} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
        fh.flush()
        self._fh = fh
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._fh is not None:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
                self._fh = None


# --------------------------------------------------------------------------
# Adlandirma
# --------------------------------------------------------------------------
def snapshot_name(now: Optional[float] = None) -> str:
    """`tezlify-ram-YYYYMMDDTHHMMSSZ` — saniye cozunurluklu, benzersiz."""
    ts = time.gmtime(time.time() if now is None else now)
    return "tezlify-ram-" + time.strftime("%Y%m%dT%H%M%SZ", ts)


def _is_inside_repo(path: Path) -> bool:
    try:
        here = Path(__file__).resolve()
        root = here.parents[2]
        return os.path.commonpath([str(Path(path).resolve()), str(root)]) == str(root)
    except (ValueError, IndexError):
        return False


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Toplama (host tarafi: konteyner icindeki araci calistirir)
# --------------------------------------------------------------------------
@dataclass
class Collected:
    blob: bytes
    manifest: Dict[str, Any]


def _docker(args: Sequence[str], *, stdin: bytes, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(args),
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def _last_manifest(stderr_text: str) -> Dict[str, Any]:
    """stderr'in son gecerli manifest JSON satirini bulur.

    `ram_snapshot.py` manifesti stderr'e tek satir JSON olarak basar; arada
    kutuphane loglari olabilir. Bu yuzden sondan geriye dogru, `kind` alani
    tutan ilk JSON nesnesi alinir.
    """
    for line in reversed(stderr_text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, Mapping) and obj.get("kind") == SNAPSHOT_KIND:
            return dict(obj)
    raise CollectFailed("manifest bulunamadi (toplayici beklenen ciktiyi vermedi)")


def _collector_cmd(container: str, script_source: str, extra: Sequence[str]) -> List[str]:
    """`python -c <kaynak> <bayraklar>` — stdin serbest kalir."""
    return ["docker", "exec", "-i", container, "python", "-c", script_source, *extra]


def docker_collect(
    *,
    container: str,
    script_path: Path,
    key_env: str,
    timeout: int = 900,
) -> Collected:
    """Konteynerde SALT OKUNUR toplama; sifreli blob + manifest dondurur."""
    source = Path(script_path).read_text(encoding="utf-8")
    cmd = _collector_cmd(
        container, source,
        ["--out", "-", "--encrypt-key-env", key_env],
    )
    try:
        proc = _docker(cmd, stdin=b"", timeout=timeout)
    except FileNotFoundError as exc:
        raise CollectFailed("docker bulunamadi") from exc
    except subprocess.TimeoutExpired as exc:
        raise CollectFailed(f"toplama zaman asimi ({timeout}s)") from exc

    if proc.returncode != 0:
        raise CollectFailed(
            f"toplayici cikis={proc.returncode}: {scrub(proc.stderr.decode('utf-8', 'replace'))}"
        )
    blob = proc.stdout
    if not blob.startswith(MAGIC):
        raise CollectFailed("toplayici sifreli blob dondurmedi (magic yok)")
    manifest = _last_manifest(proc.stderr.decode("utf-8", "replace"))
    return Collected(blob=blob, manifest=manifest)


def verify_blob(
    *,
    container: str,
    script_path: Path,
    key_env: str,
    blob: bytes,
    timeout: int = 900,
) -> Dict[str, Any]:
    """Blobu konteynerde dogrular (butunluk + tamlik).

    Blob stdin'e akitilir; konteynerde ne dosya ne de gecici dizin olusur.
    `ok=False` donduren ya da sifre cozemeyen her sonuc `SnapshotRejected`'tir:
    "kismen iyi" diye bir durum yok.
    """
    source = Path(script_path).read_text(encoding="utf-8")
    cmd = _collector_cmd(
        container, source,
        ["--verify", "-", "--encrypt-key-env", key_env],
    )
    try:
        proc = _docker(cmd, stdin=blob, timeout=timeout)
    except FileNotFoundError as exc:
        raise CollectFailed("docker bulunamadi") from exc
    except subprocess.TimeoutExpired as exc:
        raise SnapshotRejected(f"dogrulama zaman asimi ({timeout}s)") from exc

    if proc.returncode != 0:
        raise SnapshotRejected(
            f"dogrulama reddetti (cikis={proc.returncode}): "
            f"{scrub(proc.stderr.decode('utf-8', 'replace'))}"
        )
    try:
        result = json.loads(proc.stdout.decode("utf-8", "replace"))
    except ValueError as exc:
        raise SnapshotRejected("dogrulama ciktisi JSON degil") from exc
    if not isinstance(result, Mapping) or not result.get("ok"):
        problems = (result or {}).get("problems") or []
        raise SnapshotRejected(
            "snapshot butun/tam degil: " + scrub("; ".join(map(str, problems[:5])))
        )
    return dict(result)


def _iter_json_objects(text: str) -> Iterable[Dict[str, Any]]:
    """Metindeki TUM ust duzey JSON nesnelerini sirayla dondurur.

    `json.loads` butun metnin tek JSON olmasini ister; `raw_decode` yalnizca ilk
    degeri alir. Ikisi de "iki JSON nesnesi + arada serbest metin" bicimini
    cozemez — `offsite_oci.py upload` tam olarak boyle yazar. Bu yardimci metni
    tarar, her `{` konumundan bir nesne cozmeyi dener, basarisizsa bir karakter
    ilerler.
    """
    decoder = json.JSONDecoder()
    idx, n = 0, len(text)
    while idx < n:
        start = text.find("{", idx)
        if start < 0:
            return
        try:
            obj, end = decoder.raw_decode(text, start)
        except ValueError:
            idx = start + 1
            continue
        if isinstance(obj, Mapping):
            yield dict(obj)
        idx = end


# --------------------------------------------------------------------------
# Off-site (mevcut araca ince sarmalayici)
# --------------------------------------------------------------------------
class OffsiteUploader:
    """`offsite_oci.py` CLI'sini cagirir; ciktiyi ayristirir.

    Ikinci bir yukleme implementasyonu yazmamak icin bilincli olarak CLI
    uzerinden gidilir: imzalama, `If-None-Match`, CONFLICT ve TLS kurallari
    tek bir yerde kalsin.
    """

    def __init__(self, script: Path, *, python: str = sys.executable) -> None:
        self.script = Path(script)
        self.python = python

    def _run(self, argv: Sequence[str], timeout: int = 900) -> Mapping[str, Any]:
        proc = subprocess.run(
            [self.python, str(self.script), *argv],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        text = proc.stdout.decode("utf-8", "replace")
        docs = list(_iter_json_objects(text))
        if not docs:
            raise UploadFailed(
                f"offsite cikis={proc.returncode}: {scrub(proc.stderr.decode('utf-8', 'replace'))}"
            )
        # SON JSON nesnesi alinir. `offsite_oci.py upload` stdout'a IKI JSON
        # basar: once plan (`{"bucket":..,"plan":..}`), sonra sonuc
        # (`{"results":[..]}`); aralarda "[DRY-RUN] ..." gibi metin olabilir.
        # Ilk nesne alinirsa `results` hep bos gorunur ve basarili yukleme
        # "UNKNOWN" diye raporlanir — 3.9.18'de canli kosumda tam bu oldu.
        return docs[-1]

    def upload(
        self,
        *,
        source: Path,
        bucket: str,
        prefix: str,
        files: Sequence[str],
        execute: bool,
    ) -> Mapping[str, Any]:
        argv: List[str] = [
            "upload",
            "--source", str(source),
            "--bucket", bucket,
            "--prefix", prefix,
        ]
        for f in files:
            argv += ["--only", f]
        if execute:
            argv.append("--execute")
        return self._run(argv)

    def download_check(
        self,
        *,
        source: Path,
        bucket: str,
        prefix: str,
        files: Sequence[str],
    ) -> Mapping[str, Any]:
        argv: List[str] = [
            "verify",
            "--source", str(source),
            "--bucket", bucket,
            "--prefix", prefix,
            "--download-check",
        ]
        for f in files:
            argv += ["--only", f]
        return self._run(argv)


# --------------------------------------------------------------------------
# Sonuc
# --------------------------------------------------------------------------
@dataclass
class JobResult:
    status: str
    exit_code: int
    name: str
    detail: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def as_log(self, *, ts: str, seconds: float) -> Dict[str, Any]:
        rec: Dict[str, Any] = {
            "ts": ts,
            "status": self.status,
            "exit_code": self.exit_code,
            "name": self.name,
            "seconds": round(seconds, 2),
        }
        rec.update({k: v for k, v in self.detail.items() if k in LOG_FIELDS})
        if self.error:
            rec["error"] = self.error
        return rec


def _publish(
    *,
    source: Path,
    name: str,
    blob: bytes,
    manifest: Mapping[str, Any],
) -> Dict[str, Any]:
    """Atomik yayin: once `.partial`, dogrulama sonrasi `os.replace`.

    Var olan bir snapshot'in uzerine YAZILMAZ: hedef ad doluysa `ObjectConflict`.
    """
    incoming = source / INCOMING_DIR
    incoming.mkdir(parents=True, exist_ok=True)
    final_rsnap = source / f"{name}.rsnap"
    final_manifest = source / f"{name}.manifest.json"
    if final_rsnap.exists() or final_manifest.exists():
        raise ObjectConflict(f"{name} zaten var; uzerine yazilmadi")

    part_rsnap = incoming / f"{name}.rsnap.partial"
    part_manifest = incoming / f"{name}.manifest.json.partial"
    fd = os.open(part_rsnap, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(blob)
        fh.flush()
        os.fsync(fh.fileno())
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    fd = os.open(part_manifest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(manifest_bytes)
        fh.flush()
        os.fsync(fh.fileno())

    local_sha = sha256_bytes(blob)
    on_disk = hashlib.sha256(Path(part_rsnap).read_bytes()).hexdigest()
    if on_disk != local_sha:
        raise SnapshotRejected("yerel SHA-256 uyusmuyor (disk yazimi bozuk)")

    os.replace(part_rsnap, final_rsnap)
    os.replace(part_manifest, final_manifest)
    os.chmod(final_rsnap, 0o600)
    os.chmod(final_manifest, 0o600)
    return {
        "rsnap_bytes": len(blob),
        "manifest_bytes": len(manifest_bytes),
        "rsnap_sha256": local_sha,
        "path": str(final_rsnap),
    }


def _with_retry(
    fn: Callable[[], Any],
    *,
    attempts: int,
    backoff: Sequence[float],
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """Kontrollu retry. CONFLICT asla tekrarlanmaz (tekrar denemek zararli)."""
    last: Optional[Exception] = None
    for i in range(max(1, attempts)):
        try:
            return fn()
        except ObjectConflict:
            raise
        except (UploadFailed, OSError, subprocess.TimeoutExpired) as exc:
            last = exc
            if i + 1 >= attempts:
                break
            sleep(backoff[min(i, len(backoff) - 1)] if backoff else 0)
    assert last is not None
    raise last


def _upload_verdict(plan: Mapping[str, Any], *, execute: bool) -> Dict[str, Any]:
    """`offsite_oci.py upload` ciktisini tek bir yargiya indirger."""
    if not execute:
        return {"upload_status": "DRY_RUN_PLANNED", "conflict": False, "failed": False}
    results = plan.get("results") or []
    statuses = [str(r.get("status")) for r in results if isinstance(r, Mapping)]
    if any(s == "CONFLICT" for s in statuses):
        return {"upload_status": "CONFLICT", "conflict": True, "failed": True}
    if any(s in ("FAILED", "LOCAL_CHANGED") for s in statuses):
        return {"upload_status": "FAILED", "conflict": False, "failed": True}
    if statuses and all(s in ("UPLOADED", "ALREADY_PRESENT") for s in statuses):
        return {
            "upload_status": "ALREADY_PRESENT" if all(s == "ALREADY_PRESENT" for s in statuses) else "UPLOADED",
            "conflict": False,
            "failed": False,
        }
    return {"upload_status": "UNKNOWN", "conflict": False, "failed": True}


def run_job(
    *,
    source: Path,
    bucket: Optional[str],
    prefix: str,
    execute: bool,
    collect: Callable[[], Collected],
    verify: Callable[[bytes], Mapping[str, Any]],
    uploader: Optional[OffsiteUploader],
    log_path: Optional[Path] = None,
    now: Optional[float] = None,
    attempts: int = 2,
    backoff: Sequence[float] = (5.0, 15.0),
    sleep: Callable[[float], None] = time.sleep,
    lock: Optional[JobLock] = None,
) -> JobResult:
    """Tek bir snapshot turunu calistirir.

    Tum yan etkiler enjekte edilebilir (`collect`, `verify`, `uploader`), boylece
    testler uretim gateway'ine, aga veya konteynere dokunmadan ayni kod yolunu
    kosar.
    """
    t0 = time.monotonic()
    name = snapshot_name(now)
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))
    source = Path(source)

    if _is_inside_repo(source):
        res = JobResult("USAGE_ERROR", EXIT_USAGE, name,
                        error="hedef depo icinde; PII Git'e girmemeli")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    lock = lock or JobLock(source / LOCK_NAME)
    try:
        with lock:
            return _run_locked(
                source=source, name=name, ts=ts, bucket=bucket, prefix=prefix,
                execute=execute, collect=collect, verify=verify, uploader=uploader,
                log_path=log_path, attempts=attempts, backoff=backoff, sleep=sleep,
                t0=t0,
            )
    except AlreadyRunning as exc:
        res = JobResult("ALREADY_RUNNING", EXIT_ALREADY_RUNNING, name, error=scrub(str(exc)))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res


def _run_locked(
    *,
    source: Path,
    name: str,
    ts: str,
    bucket: Optional[str],
    prefix: str,
    execute: bool,
    collect: Callable[[], Collected],
    verify: Callable[[bytes], Mapping[str, Any]],
    uploader: Optional[OffsiteUploader],
    log_path: Optional[Path],
    attempts: int,
    backoff: Sequence[float],
    sleep: Callable[[float], None],
    t0: float,
) -> JobResult:
    # --- 1) toplama (SALT OKUNUR, tek deneme) ---
    try:
        got = collect()
    except SnapshotError as exc:
        res = JobResult("COLLECT_FAILED", exc.exit_code, name, error=scrub(str(exc)))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    except Exception as exc:  # noqa: BLE001
        res = JobResult("COLLECT_FAILED", EXIT_COLLECT_FAILED, name,
                        error=f"{type(exc).__name__}: {scrub(str(exc))}")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    manifest = got.manifest
    # `ram_total_reported` BILEREK yok: `build_manifest()` bu alani uretmiyor
    # (yalnizca snapshot header'inda var), dolayisiyla buradan okumak her zaman
    # `null` yazardi — kalici olarak bos bir alan log'a koymak yaniltici olur.
    detail: Dict[str, Any] = {
        "record_count": manifest.get("record_count"),
        "chat_count": manifest.get("chat_count"),
    }

    # --- 2) butunluk + tamlik (eksik sayfalama basari DEGILDIR) ---
    try:
        check = verify(got.blob)
    except SnapshotError as exc:
        res = JobResult("REJECTED", EXIT_REJECTED, name, detail, error=scrub(str(exc)))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    except Exception as exc:  # noqa: BLE001
        res = JobResult("REJECTED", EXIT_REJECTED, name, detail,
                        error=f"{type(exc).__name__}: {scrub(str(exc))}")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    if not check.get("ok"):
        problems = check.get("problems") or []
        res = JobResult("REJECTED", EXIT_REJECTED, name, detail,
                        error=scrub("; ".join(map(str, problems[:5]))))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    # --- 3) yerel atomik yayin (uzak patlasa bile kopya kalir) ---
    try:
        published = _publish(source=source, name=name, blob=got.blob, manifest=manifest)
    except SnapshotError as exc:
        res = JobResult("CONFLICT" if isinstance(exc, ObjectConflict) else "REJECTED",
                        exc.exit_code, name, detail, error=scrub(str(exc)))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    detail.update({k: published[k] for k in ("rsnap_bytes", "manifest_bytes", "rsnap_sha256")})

    files = [f"{name}.rsnap", f"{name}.manifest.json"]

    # --- 4) yukleme yok / plan asamasinda kal ---
    if not execute or uploader is None or not bucket:
        res = JobResult("DRY_RUN", EXIT_OK, name, detail)
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    # --- 5) once dry-run plan, sonra gercek yukleme ---
    try:
        uploader.upload(source=source, bucket=bucket, prefix=prefix,
                        files=files, execute=False)
    except Exception as exc:  # noqa: BLE001
        res = JobResult("DEGRADED_LOCAL_ONLY", EXIT_DEGRADED, name, detail,
                        error=f"dry-run: {type(exc).__name__}: {scrub(str(exc))}")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    try:
        plan = _with_retry(
            lambda: uploader.upload(source=source, bucket=bucket, prefix=prefix,
                                    files=files, execute=True),
            attempts=attempts, backoff=backoff, sleep=sleep,
        )
    except ObjectConflict as exc:
        res = JobResult("CONFLICT", EXIT_CONFLICT, name, detail, error=scrub(str(exc)))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    except Exception as exc:  # noqa: BLE001
        res = JobResult("DEGRADED_LOCAL_ONLY", EXIT_DEGRADED, name, detail,
                        error=f"upload: {type(exc).__name__}: {scrub(str(exc))}")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    verdict = _upload_verdict(plan, execute=True)
    detail["upload_status"] = verdict["upload_status"]
    if verdict["conflict"]:
        res = JobResult("CONFLICT", EXIT_CONFLICT, name, detail,
                        error="uzakta ayni anahtar farkli icerikle var")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res
    if verdict["failed"]:
        res = JobResult("DEGRADED_LOCAL_ONLY", EXIT_DEGRADED, name, detail,
                        error="yukleme basarisiz; yerel kopya korundu")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    # --- 6) uzaktan geri indir + SHA karsilastir ---
    try:
        checked = _with_retry(
            lambda: uploader.download_check(source=source, bucket=bucket,
                                            prefix=prefix, files=files),
            attempts=attempts, backoff=backoff, sleep=sleep,
        )
    except Exception as exc:  # noqa: BLE001
        detail["remote_verified"] = False
        res = JobResult("DEGRADED_LOCAL_ONLY", EXIT_DEGRADED, name, detail,
                        error=f"download-check: {type(exc).__name__}: {scrub(str(exc))}")
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    verified = bool(checked.get("all_verified"))
    detail["remote_verified"] = verified
    if not verified:
        bad = [r.get("file") for r in (checked.get("rows") or [])
               if isinstance(r, Mapping) and r.get("status") != "VERIFIED"]
        res = JobResult("DEGRADED_LOCAL_ONLY", EXIT_DEGRADED, name, detail,
                        error="uzak SHA dogrulanmadi: " + scrub(", ".join(map(str, bad[:3]))))
        log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
        return res

    res = JobResult("OK", EXIT_OK, name, detail)
    log_line(log_path, res.as_log(ts=ts, seconds=time.monotonic() - t0))
    return res


# --------------------------------------------------------------------------
# Depolama projeksiyonu (silme YOK, yalnizca hesap)
# --------------------------------------------------------------------------
GIB = 1024 ** 3
MIB = 1024 ** 2


def estimate_storage(
    *,
    rsnap_bytes: int,
    manifest_bytes: int,
    windows: Sequence[int] = (24, 24 * 7, 24 * 30),
) -> Dict[str, Any]:
    """Saatlik snapshot'in pencere basina depolama ihtiyaci.

    Hesap DUZ toplamadir: her snapshot tam bir kopya. Artimli/dedupe
    varsayimi YAPILMAZ — olsaydi rakam yalan olurdu.
    """
    per_run = int(rsnap_bytes) + int(manifest_bytes)
    out: Dict[str, Any] = {"per_run_bytes": per_run, "windows": {}}
    for hours in windows:
        total = per_run * int(hours)
        out["windows"][f"{hours}h"] = {
            "snapshots": int(hours),
            "bytes": total,
            "MiB": round(total / MIB, 1),
            "GiB": round(total / GIB, 3),
        }
    return out


def measure_source(source: Path) -> Dict[str, Any]:
    """Var olan snapshot'lardan gercek boyutlari olcer (salt okunur)."""
    rsnaps = sorted(Path(source).glob("tezlify-ram-*.rsnap"))
    manifests = sorted(Path(source).glob("tezlify-ram-*.manifest.json"))
    if not rsnaps:
        return {"snapshots": 0}
    sizes = [p.stat().st_size for p in rsnaps]
    m_sizes = [p.stat().st_size for p in manifests] or [0]
    return {
        "snapshots": len(rsnaps),
        "rsnap_min_bytes": min(sizes),
        "rsnap_max_bytes": max(sizes),
        "rsnap_mean_bytes": int(sum(sizes) / len(sizes)),
        "rsnap_total_bytes": sum(sizes),
        "manifest_mean_bytes": int(sum(m_sizes) / len(m_sizes)),
        "manifest_total_bytes": sum(m_sizes),
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _default_script_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def cmd_run(args: argparse.Namespace) -> int:
    src = Path(args.source)
    script_dir = _default_script_dir()
    collector = script_dir / "diagnostics" / "ram_snapshot.py"
    offsite = script_dir / "backup" / "offsite_oci.py"

    if args.execute:
        if args.no_upload:
            print(
                "REDDEDILDI: --execute ile --no-upload birlikte kullanilamaz "
                "(celiskili niyet).",
                file=sys.stderr,
            )
            return EXIT_USAGE
        if os.environ.get("TEZLIFY_OFFSITE_APPROVED") != "1":
            print(
                "REDDEDILDI: --execute icin TEZLIFY_OFFSITE_APPROVED=1 gerekir. "
                "Bu bayragi betik kendisi AYARLAMAZ.",
                file=sys.stderr,
            )
            return EXIT_USAGE
        if not args.bucket:
            print("REDDEDILDI: --execute icin --bucket gerekir", file=sys.stderr)
            return EXIT_USAGE

    def collect() -> Collected:
        return docker_collect(
            container=args.container, script_path=collector, key_env=args.key_env,
            timeout=args.timeout,
        )

    def verify(blob: bytes) -> Mapping[str, Any]:
        return verify_blob(
            container=args.container, script_path=collector, key_env=args.key_env,
            blob=blob, timeout=args.timeout,
        )

    uploader = OffsiteUploader(offsite) if (args.bucket and not args.no_upload) else None
    result = run_job(
        source=src,
        bucket=args.bucket,
        prefix=args.prefix,
        execute=bool(args.execute),
        collect=collect,
        verify=verify,
        uploader=uploader,
        log_path=Path(args.log) if args.log else None,
        attempts=args.retries,
        backoff=(5.0, 15.0),
    )
    print(json.dumps(
        {"status": result.status, "name": result.name, "exit_code": result.exit_code,
         "detail": result.detail, "error": result.error},
        ensure_ascii=False, indent=2,
    ))
    return result.exit_code


def cmd_estimate(args: argparse.Namespace) -> int:
    if args.rsnap_bytes is not None:
        rsnap = int(args.rsnap_bytes)
        manifest = int(args.manifest_bytes or 0)
        measured = {"source": "explicit"}
    else:
        measured = measure_source(Path(args.source))
        if not measured.get("snapshots"):
            print(json.dumps({"error": "olculecek snapshot yok", **measured}, indent=2))
            return EXIT_USAGE
        rsnap = measured["rsnap_mean_bytes"]
        manifest = measured["manifest_mean_bytes"]
    est = estimate_storage(rsnap_bytes=rsnap, manifest_bytes=manifest)
    print(json.dumps({"measured": measured, "estimate": est}, indent=2))
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Saatlik sifreli RAM snapshot orkestratoru (SALT OKUNUR)"
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="tek bir snapshot turu calistir")
    r.add_argument("--source", default="/var/backups/tezlify-ram")
    r.add_argument("--container", default="tezlify-backend")
    r.add_argument("--key-env", default="GATEWAY_ENCRYPTION_KEY",
                   help="anahtarin konteyner icindeki ortam degiskeni adi")
    r.add_argument("--bucket", default=os.environ.get("TEZLIFY_OFFSITE_BUCKET"))
    r.add_argument("--prefix", default="tezlify/whatsapp/ram-snapshots")
    r.add_argument("--execute", action="store_true",
                   help="gercek yukleme (TEZLIFY_OFFSITE_APPROVED=1 ayrica gerekir)")
    r.add_argument("--no-upload", action="store_true", help="yalnizca yerel snapshot")
    r.add_argument("--retries", type=int, default=2)
    r.add_argument("--timeout", type=int, default=900)
    r.add_argument("--log", default=None, help="JSON satir log dosyasi")
    r.set_defaults(func=cmd_run)

    e = sub.add_parser("estimate", help="depolama projeksiyonu (silme yok)")
    e.add_argument("--source", default="/var/backups/tezlify-ram")
    e.add_argument("--rsnap-bytes", type=int, default=None)
    e.add_argument("--manifest-bytes", type=int, default=None)
    e.set_defaults(func=cmd_estimate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
