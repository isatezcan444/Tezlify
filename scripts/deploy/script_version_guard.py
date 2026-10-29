"""Calisan deploy betigi, HEDEF commit'in betigi mi? — fail-closed karar kapisi.

## Neden var

Asama 3.8.4'un en onemli bulgusu bir celiskiydi: kalicilastirma kill-switch
muhafizi (`persistence_flag_guard.py`) HEDEF release'te var, ama deploy'u
calistiran betik ESKI checkout'tan geliyor olabilir. Somut olcum:

    yayindaki commit b5715fe : host-release.sh icinde 0 muhafiz referansi
    hedef   commit 3d3fc79  : ayni dosyada 6 referans

Yani operator `bash scripts/deploy/host-release.sh <yeni-sha>` yazdiginda,
`/opt/tezlify` hala eski commit'teyse ESKI betik kosar; adaciga
`-e WHATSAPP_MEMORY_PERSIST_ENABLED=false` zorlamasi ve cutover sonrasi
`/health` kontrolu HIC CALISMAZ. Deploy "basarili" gorunur, guvenlik kapisi
ise hic var olmamis gibi davranir. Bu, "muhafiz var ama cagrilmiyor" sinifinin
en sinsi hali: muhafiz var, cagrilmiyor, cunku calisan dosya o muhafizi
icermiyor.

## Sozlesme

Betik, kendi dosyasinin git blob kimligini hesaplar ve HEDEF commit'teki
`scripts/deploy/host-release.sh` blob'uyla karsilastirir:

  * ESIT   -> devam (dosya hedef commit'in ta kendisi)
  * FARKLI -> RED (hicbir container kalkmadan, hicbir dosya degismeden)

Bu kontrol iki yonlu calisir ve iki farkli kazayi da kapatir:

  1. eski betik + yeni hedef  -> eski betik yeni guvenlik kapilarini atlardi,
  2. yeni betik + eski hedef  -> hedef commit muhafizi tasimiyor; onu
                                 "duzeltmek" icin calisan betige guvenilmez.

Ayrica `run_release.sh`'in disaridan verdigi iki pin dogrulanir
(`--pin-blob`, `--pin-commit`): dosya hash'i ve kaynak commit. Boylece
`/tmp`'ye cikarilmis bir kopya "rastgele bir script" degil, kimligi kanitlanmis
bir kopya olur.

## Bootstrap (durust sinir)

Bu muhafiz ancak kendisini TASIYAN deploy'dan itibaren kendini uygular: onu
icermeyen eski bir betik, dogal olarak, onu calistiramaz. Ilk gecis bu yuzden
`run_release.sh` ile yapilir — o da hedef commit'ten cikarilir ve kendi
blob'unu `--expected-self-blob` ile dogrular.

## Gizlilik / yan etki

Yalnizca `git hash-object` / `git rev-parse` calistirir; aga cikmaz, dosya
yazmaz, DB'ye dokunmaz. Cikti dosya ICERIGI degil, yalnizca kisaltilmis blob
kimlikleri ve sabit gerekce metnidir.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence, Tuple

# Betigin tasimasi ZORUNLU guvenlik kontrolleri.
#
# Liste "hangi dosya var" sorusunu degil, "hangi kapi CAGRILIYOR" sorusunu
# cevaplar: bir muhafizin en tehlikeli hali var olup cagrilmamasidir. Uc
# isaret, 3.8.1'de eklenen uc ayri kapinin kablo uclaridir:
#   * `persistence_flag_guard.py`   -> karar kapisi cagriliyor mu,
#   * `--require-explicit-false`    -> adacikta "yokluk" yetmiyor mu,
#   * `persist_flag_effective`      -> cutover SONRASI etkin deger okunuyor mu.
REQUIRED_MARKERS: Tuple[str, ...] = (
    "persistence_flag_guard.py",
    "--require-explicit-false",
    "persist_flag_effective",
)

HOST_RELEASE_PATH = "scripts/deploy/host-release.sh"

EXIT_OK = 0
EXIT_DENIED = 1
EXIT_USAGE = 2


def _git(args: Sequence[str], repo: Optional[str] = None) -> Optional[str]:
    """`git` cagir; basarisizsa `None`. Cagiran taraf `None`i RED sayar."""
    cmd = ["git"]
    if repo:
        cmd += ["-C", repo]
    cmd += list(args)
    try:
        res = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return res.stdout.strip()


def blob_of_file(path: str, repo: Optional[str] = None) -> Optional[str]:
    """Dosyanin (commit'lenecek haliyle) blob kimligi.

    `git hash-object` filtreleri uygular; depoda `.gitattributes` filtre
    tanimlamadigi icin bu, dosyanin ham sha1'idir. Depo disindaki bir kopya
    icin de calisir — `/tmp`'ye cikarilmis betik bu yuzden dogrulanabilir.
    """
    out = _git(["hash-object", "--", path], repo=repo)
    return out or None


def target_blob(repo: str, commit: str, path: str = HOST_RELEASE_PATH) -> Optional[str]:
    """`<commit>:<path>` blob kimligi. Dosya o commit'te yoksa `None`."""
    out = _git(["rev-parse", "--verify", f"{commit}:{path}"], repo=repo)
    return out or None


def resolve_commit(repo: str, ref: str) -> Optional[str]:
    out = _git(["rev-parse", "--verify", f"{ref}^{{commit}}"], repo=repo)
    return out or None


def missing_markers(
    text: str, markers: Sequence[str] = REQUIRED_MARKERS
) -> Tuple[str, ...]:
    """Metinde BULUNMAYAN isaretler. Bos demet = hepsi var."""
    return tuple(m for m in markers if m not in text)


def evaluate(
    *,
    self_blob: Optional[str],
    target_blob: Optional[str],
    pinned_blob: Optional[str] = None,
    pinned_commit: Optional[str] = None,
    expected_commit: Optional[str] = None,
    script_text: Optional[str] = None,
    required_markers: Sequence[str] = REQUIRED_MARKERS,
) -> Tuple[bool, str]:
    """(izinli_mi, gerekce). Gerekce sabittir; dosya icerigi sizdirilmaz.

    `script_text` verilirse guvenlik kontrollerinin VARLIGI da aranir: blob
    esitligi "calisan = hedef" der, ama "hedef muhafizi tasiyor" demez. Eski
    bir commit'i hedef gostermek (ve onun betigini calistirmak) blob
    kontrolunden GECER; isaret kontrolu onu reddeder.
    """
    if not self_blob:
        return False, "script_blob_unreadable"
    if not target_blob:
        return False, "script_absent_in_target"

    if pinned_blob and pinned_blob != self_blob:
        return False, "script_pin_mismatch"
    if pinned_commit and expected_commit and pinned_commit != expected_commit:
        return False, "script_pin_commit_mismatch"

    if self_blob != target_blob:
        return False, "script_is_not_target_version"

    if script_text is not None:
        if missing_markers(script_text, required_markers):
            return False, "script_missing_security_checks"

    return True, "script_matches_target"


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Calisan deploy betiginin hedef commit'in betigi oldugunu dogrular. "
            "Dosya ICERIGI yazdirmaz; yalnizca blob kimlikleri ve sabit gerekce."
        )
    )
    ap.add_argument("--repo", required=True, help="git deposu (ornek: /opt/tezlify)")
    ap.add_argument("--self", required=True, help="calisan betigin yolu")
    ap.add_argument("--target-commit", required=True, help="hedef commit/ref")
    ap.add_argument("--path", default=HOST_RELEASE_PATH, help="depo icindeki yol")
    ap.add_argument("--pin-blob", default=None, help="beklenen blob (run_release.sh)")
    ap.add_argument("--pin-commit", default=None, help="kopyanin kaynak commit'i")
    ap.add_argument(
        "--no-marker-check",
        action="store_true",
        help="isaret kontrolunu atla (YALNIZCA teshis icin; deploy akisinda kullanma)",
    )
    args = ap.parse_args(argv)

    commit = resolve_commit(args.repo, args.target_commit)
    if not commit:
        print(f"script-version-guard: RED (target_commit_unresolved)", file=sys.stderr)
        return EXIT_USAGE

    self_blob = blob_of_file(args.self, repo=args.repo)
    tgt_blob = target_blob(args.repo, commit, args.path)
    text: Optional[str] = None
    if not args.no_marker_check:
        try:
            text = Path(args.self).read_text(encoding="utf-8")
        except OSError:
            text = None
            print("script-version-guard: RED (script_unreadable)", file=sys.stderr)
            return EXIT_USAGE

    allowed, reason = evaluate(
        self_blob=self_blob,
        target_blob=tgt_blob,
        pinned_blob=args.pin_blob,
        pinned_commit=args.pin_commit,
        expected_commit=commit,
        script_text=text,
    )
    verdict = "IZINLI" if allowed else "RED"
    print(
        "script-version-guard: "
        f"{verdict} ({reason}) self={(self_blob or '-')[:12]} "
        f"target={(tgt_blob or '-')[:12]} commit={commit[:12]}"
    )
    return EXIT_OK if allowed else EXIT_DENIED


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
