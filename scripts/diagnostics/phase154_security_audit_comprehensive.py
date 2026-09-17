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

    # Known old secret prefix/markers
    old_secret_markers = ["stage-gateway-secret", "stage-", "old_secret"]

    # 1. Check backups
    backup_files_found = False
    old_secret_found = False
    current_secret_found_in_backup = False
    for root, dirs, files in os.walk("/opt/tezlify"):
        if ".git" in root or "node_modules" in root or "venv" in root:
            continue
        for file in files:
            if "bak" in file or file.endswith(".old") or file.endswith("~") or "backup" in file.lower() or file.startswith(".env."):
                if file == ".env.production":
                    continue
                fp = os.path.join(root, file)
                backup_files_found = True
                try:
                    content = open(fp, "r", errors="ignore").read()
                    if current_secret and current_secret in content:
                        current_secret_found_in_backup = True
                    for m in old_secret_markers:
                        if m in content:
                            old_secret_found = True
                except Exception:
                    pass

    # 2. Git tracked & history
    git_tracked = False
    git_history = False
    if current_secret:
        try:
            out = subprocess.check_output(["git", "-C", "/opt/tezlify", "grep", "-I", current_secret], stderr=subprocess.DEVNULL)
            if out:
                git_tracked = True
        except subprocess.CalledProcessError:
            pass

        try:
            out = subprocess.check_output(["git", "-C", "/opt/tezlify", "log", "-S", current_secret, "--oneline"], stderr=subprocess.DEVNULL)
            if out:
                git_history = True
        except subprocess.CalledProcessError:
            pass

    # 3. Docker layers
    docker_layer_secret = False
    for c in ["tezlify-backend", "tezlify-gateway"]:
        try:
            dh = subprocess.check_output(["docker", "history", "--no-trunc", c], stderr=subprocess.DEVNULL, text=True)
            if current_secret and current_secret in dh:
                docker_layer_secret = True
            for m in old_secret_markers:
                if m in dh:
                    docker_layer_secret = True
        except Exception:
            pass

    # 4. Shell history
    shell_history_secret = False
    for h in [os.path.expanduser("~/.bash_history"), os.path.expanduser("~/.zsh_history")]:
        if os.path.exists(h):
            try:
                c = open(h, "r", errors="ignore").read()
                if current_secret and current_secret in c:
                    shell_history_secret = True
                for m in old_secret_markers:
                    if m in c:
                        old_secret_found = True
            except Exception:
                pass

    # 5. Logs
    log_secret = False
    for c in ["tezlify-backend", "tezlify-gateway", "tezlify-caddy"]:
        try:
            dl = subprocess.check_output(["docker", "logs", "--tail", "1000", c], stderr=subprocess.STDOUT, text=True, errors="ignore")
            if current_secret and current_secret in dl:
                log_secret = True
            for m in old_secret_markers:
                if m in dl:
                    old_secret_found = True
        except Exception:
            pass

    print(f"CURRENT_SECRET_EXPOSURE={str(current_secret_found_in_backup or git_tracked or git_history or docker_layer_secret or shell_history_secret or log_secret).lower()}")
    print(f"KNOWN_OLD_SECRET_EXPOSURE={str(old_secret_found).lower()}")
    print(f"BACKUP_ENV_FILES={str(backup_files_found).lower()}")
    print(f"GIT_TRACKED_SECRET={str(git_tracked).lower()}")
    print(f"GIT_HISTORY_SECRET={str(git_history).lower()}")
    print(f"DOCKER_LAYER_SECRET={str(docker_layer_secret).lower()}")
    print(f"SHELL_HISTORY_SECRET={str(shell_history_secret).lower()}")
    print(f"LOG_SECRET={str(log_secret).lower()}")

if __name__ == "__main__":
    main()
