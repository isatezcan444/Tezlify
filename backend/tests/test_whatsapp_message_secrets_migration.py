"""Isolated PostgreSQL migration & end-to-end encrypted storage tests (Stage 1.6).

Tests the real `ensure_whatsapp_message_secrets_table` /
`rollback_whatsapp_message_secrets_table` migrations, fail-closed prod/staging
guards, CLI validation, Postgres schema/FK/index/PUBLIC-revocation contracts,
and real Node `message-secret-store.js` encryption/decryption/isolation/cascade/TTL
behaviour against an ephemeral local PostgreSQL database.

Never touches production, staging, or shared Tezlify databases.
"""
from __future__ import annotations

import getpass
import json
import os
import pathlib
import subprocess
import uuid

import asyncpg
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.migrations import (
    ensure_whatsapp_gateway_private_schema,
    ensure_whatsapp_message_secrets_table,
    rollback_whatsapp_message_secrets_table,
)
from backend.scripts.migrate_isolated_message_secrets import _validate_isolated_target


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
GW_DIR = REPO_ROOT / "whatsapp-gateway"


def _local_pg_user() -> str:
    return os.environ.get("PGUSER") or getpass.getuser()


async def _create_ephemeral_db() -> tuple[str, str, str]:
    user = _local_pg_user()
    db_name = f"tezlify_wa_msg_secrets_test_{os.getpid()}_{uuid.uuid4().hex[:6]}"
    admin_dsn = f"postgresql://{user}@127.0.0.1:5432/postgres"
    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await conn.close()
    async_url = f"postgresql+asyncpg://{user}@127.0.0.1:5432/{db_name}"
    node_url = f"postgresql://{user}@127.0.0.1:5432/{db_name}"
    return admin_dsn, db_name, f"{async_url}|||{node_url}"


async def _drop_ephemeral_db(admin_dsn: str, db_name: str) -> None:
    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute(
            """
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
            """,
            db_name,
        )
        await conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
    finally:
        await conn.close()


def test_cli_target_validation_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION", "true")
    ok, _ = _validate_isolated_target("postgresql://user@127.0.0.1:5432/tezlify_wa_isolated")
    assert ok is False

    monkeypatch.setenv("ENVIRONMENT", "staging")
    ok, _ = _validate_isolated_target("postgresql://user@127.0.0.1:5432/tezlify_wa_isolated")
    assert ok is False

    monkeypatch.setenv("ENVIRONMENT", "")
    ok, _ = _validate_isolated_target("postgresql://user@127.0.0.1:5432/tezlify_wa_isolated")
    assert ok is False

    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION", "false")
    ok, _ = _validate_isolated_target("postgresql://user@127.0.0.1:5432/tezlify_wa_isolated")
    assert ok is False

    monkeypatch.setenv("ALLOW_ISOLATED_MESSAGE_SECRETS_MIGRATION", "true")
    for unsafe_db in (
        "postgresql://user@127.0.0.1:5432/tezlify",
        "postgresql://user@127.0.0.1:5432/tezlify_prod",
        "postgresql://user@127.0.0.1:5432/tezlify_staging",
        "postgresql://user@prod-host.internal:5432/tezlify_wa_isolated",
    ):
        ok, _ = _validate_isolated_target(unsafe_db)
        assert ok is False, f"expected refusal for {unsafe_db}"

    ok, _ = _validate_isolated_target("postgresql://user@wa-isolated-db:5432/tezlify_wa_isolated")
    assert ok is True


@pytest.mark.asyncio
async def test_isolated_message_secrets_migration_and_gateway_store() -> None:
    try:
        admin_dsn, db_name, urls = await _create_ephemeral_db()
    except Exception as exc:  # pragma: no cover - fail clearly if local PG down
        pytest.fail(f"Local PostgreSQL ephemeral test database unavailable: {exc}")

    async_url, node_url = urls.split("|||", 1)
    engine = create_async_engine(async_url, echo=False)

    try:
        # 0. Guardrails: blocked on production, staging, unset env, or missing flag
        for bad_env in ("production", "staging", ""):
            res = await ensure_whatsapp_message_secrets_table(
                engine, allow_migration=True, environment=bad_env
            )
            assert res == "BLOCKED"
            rb = await rollback_whatsapp_message_secrets_table(
                engine, allow_rollback=True, environment=bad_env
            )
            assert rb == "BLOCKED"
        assert (
            await ensure_whatsapp_message_secrets_table(
                engine, allow_migration=False, environment="test"
            )
            == "BLOCKED"
        )

        # 1. Create whatsapp_private base schema + message_secrets table
        await ensure_whatsapp_gateway_private_schema(engine)
        res = await ensure_whatsapp_message_secrets_table(
            engine, allow_migration=True, environment="test"
        )
        assert res == "OK"

        async with engine.connect() as conn:
            # Verify table + exact columns
            cols_rows = (
                await conn.execute(
                    text(
                        """
                        SELECT column_name, data_type, is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = 'whatsapp_private' AND table_name = 'message_secrets'
                        """
                    )
                )
            ).fetchall()
            cols = {r[0]: (r[1], r[2]) for r in cols_rows}
            expected_cols = {
                "session_id": ("text", "NO"),
                "chat_jid": ("text", "NO"),
                "wa_message_id": ("text", "NO"),
                "ciphertext": ("bytea", "NO"),
                "nonce": ("bytea", "NO"),
                "auth_tag": ("bytea", "NO"),
                "key_version": ("smallint", "NO"),
                "expires_at": ("timestamp with time zone", "YES"),
                "created_at": ("timestamp with time zone", "NO"),
                "updated_at": ("timestamp with time zone", "NO"),
            }
            assert cols == expected_cols

            # Verify PUBLIC has NO privileges on table or schema
            for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                has_priv = (
                    await conn.execute(
                        text(
                            "SELECT has_table_privilege('public', 'whatsapp_private.message_secrets', :priv)"
                        ),
                        {"priv": priv},
                    )
                ).scalar_one()
                assert has_priv is False, f"PUBLIC must not have {priv} on message_secrets"

            # Verify partial expiry index and CASCADE FK exist
            idx_row = (
                await conn.execute(
                    text(
                        """
                        SELECT indexdef FROM pg_indexes
                        WHERE schemaname = 'whatsapp_private'
                          AND tablename = 'message_secrets'
                          AND indexname = 'ix_wa_message_secrets_expires_at'
                        """
                    )
                )
            ).scalar_one_or_none()
            assert idx_row is not None and "expires_at IS NOT NULL" in idx_row

            fk_delete_rule = (
                await conn.execute(
                    text(
                        """
                        SELECT rc.delete_rule
                        FROM information_schema.referential_constraints rc
                        JOIN information_schema.table_constraints tc
                          ON tc.constraint_name = rc.constraint_name
                         AND tc.constraint_schema = rc.constraint_schema
                        WHERE tc.table_schema = 'whatsapp_private'
                          AND tc.table_name = 'message_secrets'
                        """
                    )
                )
            ).scalar_one()
            assert fk_delete_rule == "CASCADE"

        # 2-9. Exercise REAL Node message-secret-store.js against real migrated Postgres
        node_script = """
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createGatewayPostgresPool } from './src/database/postgres-pool.js';
import { createMessageSecretStore } from './src/crypto/message-secret-store.js';

const dbUrl = process.env.TEST_PG_URL;
const pool = createGatewayPostgresPool(dbUrl);

const keyV1 = randomBytes(32);
const keyV2 = randomBytes(32);
const chatA = '905551112233@s.whatsapp.net';
const chatB = '905559998877@s.whatsapp.net';
const msgId = 'WA-MSG-REAL-PG-1';
const plainMarker = Buffer.from('REAL_PG_PLAINTEXT_MARKER_SECRET!');
assert.equal(plainMarker.length, 32);

try {
  await pool.query(
    `INSERT INTO whatsapp_private.gateway_sessions (session_id, session_name, is_active)
     VALUES ('sess-1', 'isolated-1', true), ('sess-2', 'isolated-2', true)`
  );

  // Save with v1 store
  const storeV1 = createMessageSecretStore({
    rootKeyMaterial: keyV1,
    activeKeyVersion: 1,
    pool,
  });
  const saved = await storeV1.saveSecret({
    sessionId: 'sess-1',
    chatJid: chatA,
    waMessageId: msgId,
    secret: plainMarker,
  });
  assert.deepEqual(saved, {
    ok: true,
    persisted: true,
    cachedInRam: true,
    storage: 'postgres_and_ram',
    reason: 'persisted',
    keyVersion: 1,
  });

  // Assert Postgres stores ciphertext ONLY (zero plaintext secret bytes in DB)
  const rawRow = await pool.query(
    `SELECT ciphertext, nonce, auth_tag, key_version, expires_at
     FROM whatsapp_private.message_secrets
     WHERE session_id = 'sess-1' AND chat_jid = $1 AND wa_message_id = $2`,
    [chatA, msgId]
  );
  assert.equal(rawRow.rows.length, 1);
  const rec = rawRow.rows[0];
  assert.equal(rec.nonce.length, 12);
  assert.equal(rec.auth_tag.length, 16);
  assert.equal(rec.key_version, 1);
  assert.equal(rec.expires_at, null);
  assert.equal(Buffer.from(rec.ciphertext).includes(plainMarker), false);
  assert.equal(Buffer.compare(Buffer.from(rec.ciphertext), plainMarker) === 0, false);

  // Fresh store with empty RAM decrypts from real Postgres
  const freshV1 = createMessageSecretStore({
    rootKeyMaterial: keyV1,
    activeKeyVersion: 1,
    pool,
  });
  assert.equal(freshV1.getStats().ramSize, 0);
  const decrypted = await freshV1.getSecret({
    sessionId: 'sess-1',
    chatJid: chatA,
    waMessageId: msgId,
  });
  assert.equal(Buffer.compare(decrypted, plainMarker), 0);

  // Different session or different chat/message cannot access
  assert.equal(await freshV1.getSecret({ sessionId: 'sess-2', chatJid: chatA, waMessageId: msgId }), null);
  assert.equal(await freshV1.getSecret({ sessionId: 'sess-1', chatJid: chatB, waMessageId: msgId }), null);
  assert.equal(await freshV1.getSecret({ sessionId: 'sess-1', chatJid: chatA, waMessageId: 'OTHER' }), null);

  // Copy ciphertext under sess-2 -> AAD mismatch blocks decryption
  await pool.query(
    `INSERT INTO whatsapp_private.message_secrets
       (session_id, chat_jid, wa_message_id, ciphertext, nonce, auth_tag, key_version)
     VALUES ('sess-2', $1, $2, $3, $4, $5, $6)`,
    [chatA, msgId, rec.ciphertext, rec.nonce, rec.auth_tag, rec.key_version]
  );
  assert.equal(await freshV1.getSecret({ sessionId: 'sess-2', chatJid: chatA, waMessageId: msgId }), null);
  await pool.query(`DELETE FROM whatsapp_private.message_secrets WHERE session_id = 'sess-2'`);

  // Key rotation v2 + keyRing reads legacy v1 DB row and encrypts new writes at v2
  const storeV2 = createMessageSecretStore({
    rootKeyMaterial: keyV2,
    activeKeyVersion: 2,
    keyRing: { 1: keyV1, 2: keyV2 },
    pool,
  });
  const readOldWithV2 = await storeV2.getSecret({
    sessionId: 'sess-1',
    chatJid: chatA,
    waMessageId: msgId,
  });
  assert.equal(Buffer.compare(readOldWithV2, plainMarker), 0);

  const v2Secret = randomBytes(32);
  const resV2 = await storeV2.saveSecret({
    sessionId: 'sess-1',
    chatJid: chatB,
    waMessageId: 'WA-MSG-V2',
    secret: v2Secret,
  });
  assert.equal(resV2.keyVersion, 2);

  // expires_at TTL handling: past row invisible to getSecret & removed by purgeExpired; NULL row stays
  const expSecret = randomBytes(32);
  await storeV2.saveSecret({
    sessionId: 'sess-2',
    chatJid: chatA,
    waMessageId: 'WA-EXP',
    secret: expSecret,
    ttlMs: 30,
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await storeV2.getSecret({ sessionId: 'sess-2', chatJid: chatA, waMessageId: 'WA-EXP' }), null);
  const purged = await storeV2.purgeExpired();
  assert.equal(purged.purgedDb, 1);

  // NULL expires_at record in sess-1 survived purgeExpired
  assert.ok(await storeV2.getSecret({ sessionId: 'sess-1', chatJid: chatA, waMessageId: msgId }));

  // ON DELETE CASCADE when session row deleted in gateway_sessions
  await pool.query(`DELETE FROM whatsapp_private.gateway_sessions WHERE session_id = 'sess-1'`);
  const rem = await pool.query(`SELECT count(*)::int AS cnt FROM whatsapp_private.message_secrets WHERE session_id = 'sess-1'`);
  assert.equal(rem.rows[0].cnt, 0);

  // Insert one sentinel row in sess-2 for Python idempotency & rollback verification
  await storeV2.saveSecret({
    sessionId: 'sess-2',
    chatJid: chatA,
    waMessageId: 'WA-SENTINEL-RETAIN',
    secret: randomBytes(32),
  });
  console.log(JSON.stringify({ ok: true }));
} finally {
  await pool.end();
}
"""
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", node_script],
            cwd=str(GW_DIR),
            env={**os.environ, "TEST_PG_URL": node_url, "NODE_ENV": "development"},
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode == 0, f"Node PG test failed:\nSTDOUT:{proc.stdout}\nSTDERR:{proc.stderr}"
        assert json.loads(proc.stdout.strip().splitlines()[-1])["ok"] is True

        # 10. Idempotent re-run preserves existing encrypted rows
        res_rerun = await ensure_whatsapp_message_secrets_table(
            engine, allow_migration=True, environment="test"
        )
        assert res_rerun == "OK"
        async with engine.connect() as conn:
            cnt = (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM whatsapp_private.message_secrets WHERE session_id = 'sess-2'"
                    )
                )
            ).scalar_one()
            assert cnt == 1

        # Rollback drops ONLY whatsapp_private.message_secrets; gateway_sessions stays intact
        rb = await rollback_whatsapp_message_secrets_table(
            engine, allow_rollback=True, environment="test"
        )
        assert rb == "ROLLED_BACK"
        async with engine.connect() as conn:
            ms_exists = (
                await conn.execute(
                    text(
                        "SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema='whatsapp_private' AND table_name='message_secrets'"
                    )
                )
            ).scalar_one_or_none()
            gs_exists = (
                await conn.execute(
                    text(
                        "SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema='whatsapp_private' AND table_name='gateway_sessions'"
                    )
                )
            ).scalar_one_or_none()
            assert ms_exists is None
            assert gs_exists == 1
    finally:
        await engine.dispose()
        await _drop_ephemeral_db(admin_dsn, db_name)
