#!/usr/bin/env python3
import os
import subprocess

def main():
    env_path = "/opt/tezlify/.env.production"
    current_secret = ""
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                if line.startswith("WHATSAPP_GATEWAY_SECRET="):
                    current_secret = line.split("=", 1)[1].strip().strip("\"'").strip()

    if not current_secret:
        print("CURRENT_SECRET_MISSING=true")
        return

    backup_found = False
    for root, dirs, files in os.walk("/opt/tezlify"):
        if ".git" in root or "node_modules" in root or "venv" in root:
            continue
        for file in files:
            if "bak" in file or file.endswith(".old") or file.endswith("~") or "backup" in file.lower():
                fp = os.path.join(root, file)
                try:
                    content = open(fp, "r", errors="ignore").read()
                    if current_secret in content or "stage-" in content:
                        backup_found = True
                except Exception:
                    pass

    git_found = False
    try:
        tracked = subprocess.check_output(
            ["git", "-C", "/opt/tezlify", "grep", "-I", current_secret],
            stderr=subprocess.DEVNULL
        )
        if tracked:
            git_found = True
    except subprocess.CalledProcessError:
        pass

    try:
        log_out = subprocess.check_output(
            ["git", "-C", "/opt/tezlify", "log", "-S", current_secret, "--oneline"],
            stderr=subprocess.DEVNULL
        )
        if log_out:
            git_found = True
    except subprocess.CalledProcessError:
        pass

    log_found = False
    for log_dir in ["/opt/tezlify/runtime", "/opt/tezlify/logs", "/opt/tezlify/monitoring"]:
        if os.path.exists(log_dir):
            for root, dirs, files in os.walk(log_dir):
                for file in files:
                    fp = os.path.join(root, file)
                    try:
                        content = open(fp, "r", errors="ignore").read()
                        if current_secret in content:
                            log_found = True
                    except Exception:
                        pass

    for c in ["tezlify-backend", "tezlify-gateway", "tezlify-caddy"]:
        try:
            dlogs = subprocess.check_output(
                ["docker", "logs", "--tail", "500", c],
                stderr=subprocess.STDOUT,
                text=True,
                errors="ignore"
            )
            if current_secret in dlogs:
                log_found = True
        except Exception:
            pass

    shell_history_found = False
    for hf in [os.path.expanduser("~/.bash_history"), os.path.expanduser("~/.zsh_history")]:
        if os.path.exists(hf):
            try:
                content = open(hf, "r", errors="ignore").read()
                if current_secret in content:
                    shell_history_found = True
            except Exception:
                pass

    print(f"SECRET_EXPOSURE_FOUND={str(backup_found or git_found or log_found or shell_history_found).lower()}")
    print(f"BACKUP_SECRET_FOUND={str(backup_found).lower()}")
    print(f"GIT_SECRET_FOUND={str(git_found).lower()}")
    print(f"LOG_SECRET_FOUND={str(log_found).lower()}")
    print(f"SHELL_HISTORY_SECRET_FOUND={str(shell_history_found).lower()}")

if __name__ == "__main__":
    main()
