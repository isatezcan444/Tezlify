"""Explicit isolated migration runner for `whatsapp_private.message_secrets`.

Refuses production, staging, or un-gated invocations fail-closed. Designed
exclusively for the isolated WhatsApp protocol test database.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from urllib.parse import urlparse

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.migrations import (
    ISOLATED_MESSAGE_SECRET_ENVIRONMENTS,
    ensure_whatsapp_gateway_private_schema,
    ensure_whatsapp_message_secrets_table,
    rollback_whatsapp_message_secrets_table,
)


def _normalize_asyncpg_url(raw_url: str) -> str:
    url = raw_url.strip()
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


def _validate_isolated_target(db_url: str, *, allow_custom_test_db: bool = False) -> tuple[bool, str]:
    env = os.environ.get("ENVIRONMENT", "").strip().lower()
    if env not in ISOLATED_MESSAGE_SECRET_ENVIRONMENTS:
        return False, f"Refusing migration: ENVIRONMENT={env!r} must be one of {sorted(ISOLATED_MESSAGE_SECRET_ENVIRONMENTS)}"
    if os.environ.get("ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION", "").strip().lower() != "true":
        return False, "Refusing migration: ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION=true is required"

    if not db_url:
        return False, "Refusing migration: database URL is empty"

    parsed = urlparse(db_url)
    host = (parsed.hostname or "").lower()
    db_name = (parsed.path or "").lstrip("/").lower()
    if "prod" in db_name or "staging" in db_name or db_name == "tezlify":
        return False, f"Refusing migration: unsafe target database name {db_name!r}"

    if not allow_custom_test_db:
        safe_hosts = {"localhost", "127.0.0.1", "wa-isolated-db"}
        if host not in safe_hosts:
            return False, f"Refusing migration: non-isolated database host {host!r}"
        if "isolated" not in db_name and "test" not in db_name:
            return False, f"Refusing migration: database name {db_name!r} must contain 'isolated' or 'test'"

    return True, "ok"


async def _verify_schema(engine) -> bool:
    async with engine.connect() as conn:
        tbl = (
            await conn.execute(
                text(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = 'whatsapp_private' AND table_name = 'message_secrets'"
                )
            )
        ).first()
        if tbl is None:
            return False
        cols = (
            await conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'whatsapp_private' AND table_name = 'message_secrets'"
                )
            )
        ).fetchall()
        col_names = {r[0] for r in cols}
        required = {
            "session_id",
            "chat_jid",
            "wa_message_id",
            "ciphertext",
            "nonce",
            "auth_tag",
            "key_version",
            "expires_at",
            "created_at",
            "updated_at",
        }
        return required.issubset(col_names)


async def _run(args: argparse.Namespace) -> int:
    raw_url = args.database_url or os.environ.get("DATABASE_URL", "")
    ok, reason = _validate_isolated_target(raw_url, allow_custom_test_db=args.allow_custom_test_db)
    if not ok:
        print(reason, file=sys.stderr)
        return 2

    engine = create_async_engine(_normalize_asyncpg_url(raw_url), echo=False)
    try:
        if args.verify_only:
            present = await _verify_schema(engine)
            print(f"verify_only: message_secrets_ready={present}")
            return 0 if present else 1

        if args.rollback_table_only:
            res = await rollback_whatsapp_message_secrets_table(
                engine,
                allow_rollback=True,
                environment=os.environ.get("ENVIRONMENT", ""),
            )
            print(f"rollback_result={res}")
            return 0 if res == "ROLLED_BACK" else 1

        await ensure_whatsapp_gateway_private_schema(engine)
        res = await ensure_whatsapp_message_secrets_table(
            engine,
            allow_migration=True,
            environment=os.environ.get("ENVIRONMENT", ""),
        )
        verified = await _verify_schema(engine)
        print(f"upgrade_result={res} verified={verified}")
        return 0 if (res == "OK" and verified) else 1
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Isolated whatsapp_private.message_secrets migration")
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--rollback-table-only", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--allow-custom-test-db", action="store_true")
    args = parser.parse_args(argv)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())

