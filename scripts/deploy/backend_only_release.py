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
from typing import Iterable, List, Sequence

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


def release_command(target: str, *, health_timeout: int = 180) -> str:
    """Operatorun calistiracagi komut. Betik bunu CALISTIRMAZ."""
    return (
        f"bash scripts/deploy/host-release.sh {target} --no-gateway "
        f"--health-timeout {health_timeout}"
    )


def _git(*args: str) -> str:
    try:
        res = subprocess.run(
            ["git", *args],
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


def _changed(base: str, target: str, pathspec: Sequence[str]) -> List[str]:
    out = _git("diff", "--name-only", base, target, "--", *pathspec)
    return [line.strip() for line in out.splitlines() if line.strip()]


def _rev(ref: str) -> str:
    return _git("rev-parse", "--verify", f"{ref}^{{commit}}").strip()


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
    args = ap.parse_args(argv)

    try:
        base = _rev(args.base)
        target = _rev(args.target)
        backend_from = _rev(args.backend_from)
    except GitError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        return 2

    gateway_changes = _changed(base, target, [GATEWAY_PREFIX, *COMPOSE_FILES])
    backend_vs_main = _changed(target, backend_from, [BACKEND_PREFIX])
    backend_vs_base = _changed(base, target, [BACKEND_PREFIX])

    problems = evaluate(
        gateway_changes=gateway_changes,
        backend_vs_main=backend_vs_main,
        backend_vs_base=backend_vs_base,
    )

    print(f"base            : {base[:12]} ({args.base})")
    print(f"target          : {target[:12]} ({args.target})")
    print(f"backend kaynagi : {backend_from[:12]} ({args.backend_from})")
    print(f"gateway/compose : {len(gateway_changes)} dosya degismis (0 olmali)")
    print(f"backend vs main : {len(backend_vs_main)} dosya farkli (0 olmali)")
    print(f"backend vs base : {len(backend_vs_base)} dosya degismis (>0 olmali)")
    print("")

    if problems:
        for p in problems:
            print(f"IHLAL: {p}", file=sys.stderr)
        print("\nSONUC: GUVENLI DEGIL — deploy etme.", file=sys.stderr)
        return 1

    print("SONUC: GUVENLI — bu ref `--no-gateway` muhafizindan gececek.")
    print("Calistirilacak komut (bu betik CALISTIRMAZ):")
    print(f"  {release_command(args.target, health_timeout=args.health_timeout)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
