"""Backend-only release ref'ini DOGRULAR.

## Neden var

`scripts/deploy/host-release.sh --no-gateway`, yayindaki commit ile hedef commit
arasinda `whatsapp-gateway/` veya bir compose dosyasi degismisse komutu
**reddeder**. Bu dogru davranistir: yanlis yonde basarisizlik (deploy "basarili"
gorunurken gateway kodu eski kalir) sessiz ve tehlikelidir.

Ama `main` uzerinde gateway degisikligi oldugunda backend-only bir surum
dagitmak imkansizlasir. Cozum muhafizi kaldirmak DEGIL, muhafizin aradigi
kosulu GERCEKTEN saglayan bir release ref'i uretmektir:

    release ref'in agaci = main'in agaci, `whatsapp-gateway/` yayindaki haliyle

O zaman `base..ref` farki gateway'e hic dokunmaz ve muhafiz kendiliginden gecer.
Bu betik o ref'in gercekten boyle oldugunu **deploy'dan once** dogrular.

## Bu betik bir bypass DEGILDIR

`host-release.sh` hic degistirilmez ve muhafiz deploy sirasinda yeniden calisir.
Betik yalnizca "bu ref muhafizdan GECECEK mi" sorusunu onceden yanitlar; boylece
operator, deploy'un 3. adiminda reddedilmesini beklemez.

## Kullanim

    python scripts/deploy/backend_only_release.py \
        --base "$(cat .deployed-commit)" \
        --target release/backend-only-3.7 \
        --backend-from origin/main

Cikis kodlari: 0 = ref guvenli, 1 = ihlal var, 2 = kullanim hatasi.

Hicbir veritabanina, aga veya container'a dokunmaz: yalnizca `git` okur.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

# `host-release.sh` muhafizinin kapsami — birebir ayni olmali.
GATEWAY_PREFIX = "whatsapp-gateway/"
COMPOSE_FILES = ("docker-compose.prod.yml", "docker-compose.yml")

# Release ref'in tasimasi GEREKEN backend agaci.
BACKEND_PREFIX = "backend/"


class GitError(RuntimeError):
    pass


def gateway_touching(paths: Iterable[str]) -> List[str]:
    """Verilen dosya listesinden gateway'i etkileyenleri dondurur.

    `host-release.sh`'deki `git diff --quiet -- whatsapp-gateway/ <compose>`
    kontrolunun saf karsiligi; boylece ayni kume uzerinde test yazilabilir.
    """
    out = []
    for p in paths:
        p = str(p).strip()
        if not p:
            continue
        if p.startswith(GATEWAY_PREFIX) or p in COMPOSE_FILES:
            out.append(p)
    return sorted(out)


def evaluate(
    *,
    gateway_changes: Sequence[str],
    backend_vs_main: Sequence[str],
    backend_vs_base: Sequence[str],
) -> List[str]:
    """Ref'in guvenli olup olmadigina karar verir; ihlal listesi dondurur.

    Bos liste = guvenli.

    - `gateway_changes`: base..target arasinda gateway/compose'a dokunan dosyalar.
      BOS OLMALI; aksi halde `--no-gateway` reddeder.
    - `backend_vs_main`: target ile `--backend-from` arasindaki backend farki.
      BOS OLMALI; aksi halde release ref'i main'deki duzeltmeyi tasimiyordur
      (eski/eksik backend dagitilir — sessiz gerileme).
    - `backend_vs_base`: base..target arasindaki backend farki. BOS OLMAMALI;
      aksi halde dagitilacak bir sey yoktur (bos release).
    """
    problems: List[str] = []

    gw = gateway_touching(gateway_changes)
    if gw:
        problems.append(
            "--no-gateway muhafizi REDDEDER: gateway/compose degismis "
            f"({len(gw)} dosya): " + ", ".join(gw[:8])
        )

    if backend_vs_main:
        problems.append(
            "release ref'i main'in backend agacini tasimiyor "
            f"({len(backend_vs_main)} dosya farkli): " + ", ".join(list(backend_vs_main)[:8])
        )

    if not backend_vs_base:
        problems.append(
            "dagitilacak backend degisikligi yok (base..target arasinda backend farki bos)"
        )

    return problems


# Hedef commit'in TASIMASI ZORUNLU guvenlik betikleri (3.8.5).
#
# `--no-gateway` muhafizi yalnizca "gateway degismedi" der. Bu liste ise
# "dagitilan surum, deploy'u guvenli kilan araclari ICERIYOR mu" sorusunu
# cevaplar. Eksikse deploy edilmez — cunku eksik bir surum, muhafizin
# calismadigi bir surumdur.
SECURITY_SCRIPTS = (
    "scripts/deploy/host-release.sh",
    "scripts/deploy/persistence_flag_guard.py",
    "scripts/deploy/script_version_guard.py",
    "scripts/deploy/run_release.sh",
)

# `host-release.sh` icinde ARANAN kablolama isaretleri. Tek kaynak
# `script_version_guard.REQUIRED_MARKERS`; kopyalamak iki listenin zamanla
# ayrismasi demek olurdu (bu depoda tam olarak bu hata bir kez yasandi).
EXTRA_MARKERS = ("script_version_guard.py",)


def _load_version_guard():
    import importlib.util

    path = Path(__file__).resolve().parent / "script_version_guard.py"
    spec = importlib.util.spec_from_file_location("deploy_script_version_guard", path)
    if spec is None or spec.loader is None:  # pragma: no cover - bozuk kurulum
        raise GitError("script_version_guard.py yuklenemedi")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def script_contract_problems(
    *,
    missing_paths: Sequence[str],
    missing_markers: Sequence[str],
) -> List[str]:
    """Hedef surumun guvenlik sozlesmesini degerlendirir. Bos liste = uygun."""
    problems: List[str] = []
    for p in missing_paths:
        problems.append(
            f"hedef commit'te {p} yok — deploy guvenlik araclari eksik"
        )
    if missing_markers:
        problems.append(
            "hedef host-release.sh su kontrolleri icermiyor: "
            + ", ".join(missing_markers)
        )
    return problems


def release_command(
    target: str, *, health_timeout: int = 180, self_blob: str | None = None
) -> str:
    """Operatorun calistiracagi komut. Betik bunu CALISTIRMAZ.

    3.8.5: komut artik `run_release.sh` uzerinden gider. Dogrudan
    `host-release.sh` cagirmak da mumkun, ama o zaman `/opt/tezlify` eski
    commit'teyse ESKI betik kosar ve yeni guvenlik kapilarini atlar. Baslatici
    hedef commit'in betigini cikarir, blob'unu dogrular ve onu calistirir;
    `--expected-self-blob` ise baslaticinin KENDISINI pinler.
    """
    pin = f" --expected-self-blob {self_blob}" if self_blob else ""
    return (
        f"bash scripts/deploy/run_release.sh{pin} {target} --no-gateway "
        f"--health-timeout {health_timeout}"
    )


def _git(*args: str, repo: Optional[str] = None) -> str:
    cmd = ["git"]
    if repo:
        cmd += ["-C", repo]
    cmd += list(args)
    try:
        res = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:  # pragma: no cover - git yoksa
        raise GitError("git bulunamadi") from exc
    except subprocess.CalledProcessError as exc:
        raise GitError(
            f"git {' '.join(args)} basarisiz: {exc.stderr.strip() or exc.returncode}"
        ) from exc
    return res.stdout


def _try_git(*args: str, repo: Optional[str] = None) -> Optional[str]:
    """Basarisizsa `None` — "commit'te yok" bir ihlaldir, cokme degil."""
    try:
        return _git(*args, repo=repo).strip()
    except GitError:
        return None


def blob_at(repo: Optional[str], commit: str, path: str) -> Optional[str]:
    """`<commit>:<path>` blob kimligi; dosya o commit'te yoksa `None`."""
    return _try_git("rev-parse", "--verify", f"{commit}:{path}", repo=repo)


def file_text_at(repo: Optional[str], commit: str, path: str) -> Optional[str]:
    return _try_git("show", f"{commit}:{path}", repo=repo)


def _changed(
    base: str, target: str, pathspec: Sequence[str], repo: Optional[str] = None
) -> List[str]:
    out = _git("diff", "--name-only", base, target, "--", *pathspec, repo=repo)
    return [line.strip() for line in out.splitlines() if line.strip()]


def _rev(ref: str, repo: Optional[str] = None) -> str:
    return _git("rev-parse", "--verify", f"{ref}^{{commit}}", repo=repo).strip()


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Backend-only release ref'ini dogrular (deploy YAPMAZ)."
    )
    ap.add_argument("--base", required=True, help="yayindaki commit (.deployed-commit)")
    ap.add_argument("--target", required=True, help="dagitilacak release ref/SHA")
    ap.add_argument(
        "--backend-from",
        default="origin/main",
        help="release ref'in backend agacinin kaynagi (varsayilan: origin/main)",
    )
    ap.add_argument("--health-timeout", type=int, default=180)
    ap.add_argument("--repo", default=".", help="git deposu (varsayilan: .)")
    args = ap.parse_args(argv)

    try:
        base = _rev(args.base, repo=args.repo)
        target = _rev(args.target, repo=args.repo)
        backend_from = _rev(args.backend_from, repo=args.repo)
    except GitError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        return 2

    gateway_changes = _changed(base, target, [GATEWAY_PREFIX, *COMPOSE_FILES], repo=args.repo)
    backend_vs_main = _changed(target, backend_from, [BACKEND_PREFIX], repo=args.repo)
    backend_vs_base = _changed(base, target, [BACKEND_PREFIX], repo=args.repo)

    problems = evaluate(
        gateway_changes=gateway_changes,
        backend_vs_main=backend_vs_main,
        backend_vs_base=backend_vs_base,
    )

    # --- Surum guvenlik sozlesmesi (3.8.5) ---------------------------------
    try:
        guard = _load_version_guard()
    except GitError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        return 2
    required_markers = tuple(guard.REQUIRED_MARKERS) + EXTRA_MARKERS
    blobs = {p: blob_at(args.repo, target, p) for p in SECURITY_SCRIPTS}
    missing_paths = [p for p, b in blobs.items() if not b]
    host_text = file_text_at(args.repo, target, SECURITY_SCRIPTS[0])
    missing_markers = (
        guard.missing_markers(host_text, required_markers) if host_text else ()
    )
    problems += script_contract_problems(
        missing_paths=missing_paths, missing_markers=missing_markers
    )

    print(f"base            : {base[:12]} ({args.base})")
    print(f"target          : {target[:12]} ({args.target})")
    print(f"backend kaynagi : {backend_from[:12]} ({args.backend_from})")
    print(f"gateway/compose : {len(gateway_changes)} dosya degismis (0 olmali)")
    print(f"backend vs main : {len(backend_vs_main)} dosya farkli (0 olmali)")
    print(f"backend vs base : {len(backend_vs_base)} dosya degismis (>0 olmali)")
    print(f"host-release.sh : {(blobs[SECURITY_SCRIPTS[0]] or '-')[:12]} (hedefteki blob)")
    print(f"run_release.sh  : {(blobs['scripts/deploy/run_release.sh'] or '-')[:12]} (hedefteki blob)")
    print("")

    if problems:
        for p in problems:
            print(f"IHLAL: {p}", file=sys.stderr)
        print("\nSONUC: GUVENLI DEGIL — deploy etme.", file=sys.stderr)
        return 1

    print("SONUC: GUVENLI — bu ref `--no-gateway` muhafizindan gececek.")
    print("Calistirilacak komut (bu betik CALISTIRMAZ):")
    print(
        "  "
        + release_command(
            args.target,
            health_timeout=args.health_timeout,
            self_blob=blobs["scripts/deploy/run_release.sh"],
        )
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
