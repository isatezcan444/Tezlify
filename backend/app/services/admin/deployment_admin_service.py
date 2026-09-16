"""Deployment & local environment status service for Admin Center.

Invariants:
- Read-only local Oracle host state.
- Zero network git comparisons, zero git mutations (no pull, checkout, deploy, rollback).
- Safe fallback if .git directory or git CLI is not present.
"""

import logging
import os
import platform
import subprocess
from datetime import datetime, timezone
from typing import Optional, Tuple

from backend.app.schemas.admin import AdminDeploymentResponse

logger = logging.getLogger(__name__)


def _run_git_cmd(args: list, cwd: str = "/opt/tezlify") -> Optional[str]:
    try:
        res = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return None


def _get_git_info(repo_dir: str = "/opt/tezlify") -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[bool]]:
    branch = None
    commit_hash = None
    commit_msg = None
    commit_ts = None
    clean = None

    # Try git CLI
    if os.path.exists(os.path.join(repo_dir, ".git")):
        branch = _run_git_cmd(["branch", "--show-current"], repo_dir)
        commit_hash = _run_git_cmd(["rev-parse", "HEAD"], repo_dir)
        commit_msg = _run_git_cmd(["log", "-1", "--format=%s"], repo_dir)
        commit_ts = _run_git_cmd(["log", "-1", "--format=%cI"], repo_dir)
        status_out = _run_git_cmd(["status", "--porcelain"], repo_dir)
        if status_out is not None:
            clean = len(status_out.strip()) == 0

    # Fallback to direct .git parsing if git CLI failed but .git directory exists
    if not commit_hash:
        head_file = os.path.join(repo_dir, ".git", "HEAD")
        if os.path.exists(head_file):
            try:
                with open(head_file, "r") as f:
                    content = f.read().strip()
                if content.startswith("ref: "):
                    ref_path = content[5:].strip()
                    branch = ref_path.split("/")[-1]
                    ref_file = os.path.join(repo_dir, ".git", ref_path)
                    if os.path.exists(ref_file):
                        with open(ref_file, "r") as rf:
                            commit_hash = rf.read().strip()
                else:
                    commit_hash = content
            except Exception as e:
                logger.debug("Failed reading .git/HEAD directly: %s", e)

    return branch, commit_hash, commit_msg, commit_ts, clean


def _get_distro_info() -> str:
    if os.path.exists("/etc/os-release"):
        try:
            with open("/etc/os-release", "r") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        return line.split("=", 1)[1].strip().strip('"')
        except Exception:
            pass
    return platform.platform()


def get_deployment_metadata() -> AdminDeploymentResponse:
    now_iso = datetime.now(timezone.utc).isoformat()
    repo_dir = os.environ.get("TEZLIFY_REPO_DIR", "/opt/tezlify")
    if not os.path.exists(repo_dir):
        repo_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))

    branch, commit_hash, commit_msg, commit_ts, clean = _get_git_info(repo_dir)

    reboot_required = False
    for path in [
        "/var/run/reboot-required",
        "/run/reboot-required",
        "/host/run/reboot-required",
        "/host/var/run/reboot-required",
    ]:
        if os.path.exists(path):
            reboot_required = True
            break

    kernel = platform.uname().release or "unknown"
    distro = _get_distro_info()

    return AdminDeploymentResponse(
        timestamp=now_iso,
        environment=os.environ.get("ENVIRONMENT", "production"),
        branch=branch,
        commit_hash=commit_hash,
        commit_message=commit_msg,
        commit_timestamp=commit_ts,
        working_tree_clean=clean,
        deployment_directory=repo_dir,
        kernel=kernel,
        distro=distro,
        reboot_required=reboot_required,
    )
