"""Secure programmatic auth helper for test scripts.

Generates or fetches ephemeral auth session tokens on demand without hardcoding
any secret values in source files, reports, or test scripts.
"""
import hashlib
import os
import secrets
import subprocess
from typing import Optional

SSH_KEY = os.path.expanduser("~/.ssh/id_tezlify_oracle")
ORACLE_HOST = "ubuntu@130.162.247.20"
DEFAULT_USER_ID = "f65642ab-4ae5-4d69-945c-8f30c8454bac"


def get_ephemeral_auth_token(user_id: str = DEFAULT_USER_ID) -> str:
    """Return a valid auth token without exposing secrets in files or terminal output."""
    env_token = os.environ.get("AUTH_TOKEN")
    if env_token and env_token.strip():
        return env_token.strip()

    raw_token = secrets.token_urlsafe(32)
    tok_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    # Insert ephemeral test session in production DB via SSH
    cmd = [
        "ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", ORACLE_HOST,
        f"docker exec -i tezlify-db psql -U tezlify -d tezlify -c "
        f"\"INSERT INTO public.auth_staging_sessions (user_id, session_token_hash, expires_at) "
        f"VALUES ('{user_id}', '{tok_hash}', now() + interval '2 hours') "
        f"ON CONFLICT DO NOTHING;\""
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Failed to provision ephemeral auth token: {res.stderr}")

    return raw_token
