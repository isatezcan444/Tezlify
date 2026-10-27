#!/usr/bin/env python3
"""Yikici migration muhafizi — `scripts/deploy/host-release.sh` icin.

NEDEN VAR
---------
Adacik (candidate) container, cutover'dan ONCE, **uretim veritabanina** karsi
tum startup migration setini calistiriyor. Bu setin icinde satir silen
fonksiyonlar var (`purge_empty_ghost_conversations`, `purge_raw_jid_identity_data`,
`purge_degenerate_phone_contacts`, `ensure_contacts_unique_phone`'un birlestirme
dali). 2026-10-27'de bir sohbet tam olarak bu pencerede kayboldu ve hangi
migration'in sildigi **kanitlanamadi**, cunku adacigin logu container'la
birlikte silinmisti.

Bu betik iki sey yapar, ikisi de veritabani olmadan:

1. `diff` — deploy araliginda migration dosyalarina EKLENEN satirlarda yikici SQL
   var mi? Varsa exit 3. Boylece yikici bir migration, acik onay
   (`--allow-migrations`) verilmeden **hicbir container calismadan** durdurulur.
2. `log` — adacik logunda gerceklesmis silme/birlestirme izlerini isimlendirir.
   Sayim dususu tespit edildiginde "kim sildi" sorusunun cevabini verir.

Siniflandirma
-------------
`delete`    : satir/tablo/kolon kaybi  -> ENGELLER (onay ister)
`transform` : yerinde veri degisimi (UPDATE ... SET) -> yalnizca RAPORLANIR

`UPDATE` neden engellemiyor: `backfill_*` fonksiyonlari her acilista calisan,
idempotent onarimlardir. Her UPDATE'i engellemek muhafizi kullanilamaz hale
getirir ve operatoru surekli `--allow-migrations` vermeye alistirip asil
uyariyi degersizlestirirdi. `DROP INDEX` de veri kaybi degildir (bkz.
`ensure_phase_10_7_indexes`), bu yuzden kapsam disi.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any, Dict, Iterable, List

# Migration kodunun yasadigi dosyalar. Degismediyse tarama bos doner.
MIGRATION_PATHS = (
    "backend/app/core/migrations.py",
    "backend/app/main.py",
)

# (regex, etiket, agirlik)
PATTERNS = (
    (re.compile(r"\bDELETE\s+FROM\b", re.IGNORECASE), "DELETE FROM", "delete"),
    (re.compile(r"\bTRUNCATE\b", re.IGNORECASE), "TRUNCATE", "delete"),
    (re.compile(r"\bDROP\s+TABLE\b", re.IGNORECASE), "DROP TABLE", "delete"),
    (re.compile(r"\bDROP\s+COLUMN\b", re.IGNORECASE), "DROP COLUMN", "delete"),
    (
        re.compile(r"\bUPDATE\s+[A-Za-z_][\w.\"]*\s+SET\b", re.IGNORECASE),
        "UPDATE ... SET",
        "transform",
    ),
)

# Adacik logunda GERCEKLESMIS bir silme/birlestirme izi. Yalnizca kanit olarak
# kullanilir; karar sayimlardan verilir (log metni degiskendir, sayim degildir).
LOG_PATTERNS = (
    (re.compile(r"purge_empty_ghost_conversations:\s*(\d+)", re.IGNORECASE), "ghost_purge"),
    (re.compile(r"purge_degenerate_phone_contacts[^\n]*?(\d+)", re.IGNORECASE), "degenerate_contact_purge"),
    (re.compile(r"contacts tekillestirme:\s*(\d+)", re.IGNORECASE), "contact_merge"),
    (re.compile(r"\b(\d+)\b[^\n]*\b(temizlendi|silindi|birlestirildi)\b", re.IGNORECASE), "row_removal"),
    (re.compile(r"\bdeleted\b|\bmerged\b", re.IGNORECASE), "row_removal"),
)

_EXIT_CLEAN = 0
_EXIT_FINDINGS = 3


def scan_diff(diff_text: str) -> List[Dict[str, Any]]:
    """Yalnizca EKLENEN satirlari tarar.

    Silinen bir satirdaki `DELETE FROM` yikicilik EKLEMEZ — tam tersi. Baglam
    satirlari (` context`) da atlanir; aksi hâlde degismemis bir fonksiyonun
    govdesi her deploy'da alarm uretirdi.
    """
    findings: List[Dict[str, Any]] = []
    current_file = ""
    for raw in diff_text.splitlines():
        if raw.startswith("+++ b/"):
            current_file = raw[len("+++ b/") :].strip()
            continue
        if raw.startswith("+++") or raw.startswith("---"):
            continue
        if not raw.startswith("+"):
            continue
        line = raw[1:]
        for pattern, label, severity in PATTERNS:
            if pattern.search(line):
                findings.append(
                    {
                        "file": current_file,
                        "label": label,
                        "severity": severity,
                        "line": line.strip()[:200],
                    }
                )
                break
    return findings


def scan_log(log_text: str) -> List[Dict[str, Any]]:
    """Adacik logunda gerceklesmis silme/birlestirme izlerini toplar.

    Satir basina EN FAZLA bir bulgu: desenler ozelden genele siralidir, yani
    `purge_empty_ghost_conversations: 1 ... temizlendi` satiri hem "ghost_purge"
    hem "row_removal" ile eslesir; ikincisi bilgi eklemez, yalnizca gurultu olur.
    """
    findings: List[Dict[str, Any]] = []
    seen = set()
    for raw in log_text.splitlines():
        for pattern, kind in LOG_PATTERNS:
            if not pattern.search(raw):
                continue
            key = (kind, raw.strip()[:200])
            if key not in seen:
                seen.add(key)
                findings.append({"kind": kind, "line": raw.strip()[:200]})
            break
    return findings


def has_blocking(findings: Iterable[Dict[str, Any]]) -> bool:
    return any(f.get("severity") == "delete" for f in findings)


def _git_diff(repo: str, base: str, target: str) -> str:
    result = subprocess.run(
        ["git", "-C", repo, "diff", base, target, "--", *MIGRATION_PATHS],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"[migration-guard] git diff basarisiz ({result.returncode}): "
            f"{result.stderr.strip()[:200]}"
        )
    return result.stdout


def _emit(payload: Dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    findings = payload.get("findings") or []
    if not findings:
        print("[migration-guard] temiz: yikici migration satiri yok")
        return
    print(f"[migration-guard] {len(findings)} bulgu:")
    for finding in findings:
        where = finding.get("file") or "log"
        print(f"    [{finding.get('severity', finding.get('kind'))}] {where}: {finding['line']}")


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Yikici migration muhafizi")
    sub = parser.add_subparsers(dest="command", required=True)

    diff_cmd = sub.add_parser("diff", help="deploy araligindaki eklenen satirlari tara")
    diff_cmd.add_argument("--repo", required=True)
    diff_cmd.add_argument("--base", required=True)
    diff_cmd.add_argument("--target", required=True)
    diff_cmd.add_argument("--json", action="store_true")

    log_cmd = sub.add_parser("log", help="adacik logunda gerceklesmis silmeleri bul")
    log_cmd.add_argument("--file", required=True)
    log_cmd.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)

    if args.command == "diff":
        findings = scan_diff(_git_diff(args.repo, args.base, args.target))
        _emit({"mode": "diff", "findings": findings}, args.json)
        return _EXIT_FINDINGS if has_blocking(findings) else _EXIT_CLEAN

    try:
        with open(args.file, "r", encoding="utf-8", errors="replace") as handle:
            log_text = handle.read()
    except OSError as exc:
        print(f"[migration-guard] log okunamadi: {exc}", file=sys.stderr)
        return _EXIT_CLEAN

    findings = scan_log(log_text)
    _emit({"mode": "log", "findings": findings}, args.json)
    return _EXIT_FINDINGS if findings else _EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
