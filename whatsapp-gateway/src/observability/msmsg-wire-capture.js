import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sessionRef } from '../observability.js';
import { jidKind } from '../utils/whatsapp-identity.js';
import { decodeMsmsgProtobufPayload } from '../crypto/msmsg-adapter.js';
import { isProductionRuntime } from '../crypto/message-secret-store.js';

const SAFE_ENC_ATTR_KEYS = new Set(['type', 'v', 'count', 'mediatype']);
const DEFAULT_TTL_MINUTES = 30;
const MAX_CAPTURE_FILES = 100;

export function redactIdentifier(value) {
  if (!value) return null;
  const str = String(value);
  const digest = crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
  const prefix = str.length >= 4 ? str.slice(0, 4) : str;
  return `${prefix}...${digest}`;
}

export function sanitizeEncAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object') return {};
  const clean = {};
  for (const key of Object.keys(attrs)) {
    const lower = key.toLowerCase();
    if (SAFE_ENC_ATTR_KEYS.has(lower)) {
      clean[lower] = String(attrs[key]);
    }
  }
  return clean;
}

/**
 * Inspects a Baileys `CB:message` BinaryNode containing `enc type="msmsg"`
 * without touching secrets or plaintext message bodies.
 */
export function buildSafeMsmsgTelemetry({
  sessionId = null,
  node = null,
  secretMatched = null,
  decryptOutcome = 'not_attempted',
} = {}) {
  const contentNodes = Array.isArray(node?.content) ? node.content : [];
  const encNodes = contentNodes.filter((c) => c && c.tag === 'enc');
  const msmsgNodes = encNodes.filter((c) => String(c.attrs?.type || '').toLowerCase() === 'msmsg');
  const firstMsmsg = msmsgNodes[0] || null;

  let parsed = { ok: false, reason: 'no_msmsg_bytes', secEnc: null };
  if (firstMsmsg && (Buffer.isBuffer(firstMsmsg.content) || firstMsmsg.content instanceof Uint8Array)) {
    parsed = decodeMsmsgProtobufPayload(node);
  }

  const targetId = parsed?.secEnc?.targetMessageKey?.id || null;
  const secretEncType = parsed?.secEnc?.secretEncType ?? null;

  return {
    captured_at: new Date().toISOString(),
    session_ref: sessionRef(sessionId),
    node_tag: node?.tag ? String(node.tag) : null,
    stanza_type: String(node?.attrs?.type || ''),
    from_kind: jidKind(node?.attrs?.from),
    to_kind: jidKind(node?.attrs?.to),
    has_edit_attr: Boolean(
      String(node?.attrs?.edit || '') ||
      contentNodes.some((c) => c?.tag === 'meta' && (c.attrs?.edit !== undefined || c.attrs?.polltype !== undefined)),
    ),
    enc_children: encNodes.map((c) => ({
      tag: String(c.tag),
      attrs: sanitizeEncAttrs(c.attrs),
      byte_length: (Buffer.isBuffer(c.content) || c.content instanceof Uint8Array) ? c.content.length : 0,
    })),
    byte_length:
      firstMsmsg && (Buffer.isBuffer(firstMsmsg.content) || firstMsmsg.content instanceof Uint8Array)
        ? firstMsmsg.content.length
        : 0,
    protobuf_decode_outcome: parsed.ok ? 'decoded_sec_enc' : (parsed.reason || 'decode_failed'),
    packet_kind: secretEncType !== null ? `secret_enc_${secretEncType}` : (String(node?.attrs?.type || 'unknown')),
    redacted_target_id: redactIdentifier(targetId),
    secret_matched: secretMatched,
    decrypt_outcome: decryptOutcome,
  };
}

/**
 * Isolated, opt-in wire capture helper for `enc type="msmsg"` stanza debugging.
 * - OFF by default in all configurations.
 * - Hard-blocked from capturing raw bytes in production (`NODE_ENV === 'production'`).
 * - Writes only to restricted local `0o700` directory with `0o600` files & automatic TTL expiry.
 */
export function createMsmsgWireCapture({
  enabled = String(process.env.GATEWAY_MSMSG_WIRE_CAPTURE || 'false').toLowerCase() === 'true',
  includeRawCiphertext = String(process.env.GATEWAY_MSMSG_CAPTURE_INCLUDE_CIPHERTEXT || 'false').toLowerCase() === 'true',
  captureDir = process.env.GATEWAY_WIRE_CAPTURE_DIR || null,
  ttlMinutes = Number(process.env.GATEWAY_WIRE_CAPTURE_TTL_MINUTES || DEFAULT_TTL_MINUTES),
  isProduction = isProductionRuntime(),
  logger = null,
} = {}) {
  const effectiveEnabled = Boolean(enabled) && !isProduction;
  const effectiveIncludeCiphertext = Boolean(includeRawCiphertext) && effectiveEnabled && !isProduction;
  const resolvedTtlMs =
    Number.isFinite(ttlMinutes) && ttlMinutes > 0
      ? ttlMinutes * 60_000
      : DEFAULT_TTL_MINUTES * 60_000;

  if (enabled && isProduction) {
    logger?.warn?.(
      { flag: 'GATEWAY_MSMSG_WIRE_CAPTURE' },
      'Refusing raw msmsg wire capture in production runtime; capture remains disabled fail-closed',
    );
  }

  function purgeExpired() {
    if (!captureDir || !fs.existsSync(captureDir)) return 0;
    let deleted = 0;
    const now = Date.now();
    try {
      for (const name of fs.readdirSync(captureDir)) {
        if (!name.startsWith('msmsg-') || !name.endsWith('.json')) continue;
        const full = path.join(captureDir, name);
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (parsed?.expires_at_ms && Number(parsed.expires_at_ms) <= now) {
            fs.unlinkSync(full);
            deleted += 1;
          }
        } catch {
          // Malformed or stale temporary capture is removed cleanly
          try { fs.unlinkSync(full); deleted += 1; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return deleted;
  }

  function purgeAll() {
    if (!captureDir || !fs.existsSync(captureDir)) return 0;
    let deleted = 0;
    try {
      for (const name of fs.readdirSync(captureDir)) {
        if (!name.startsWith('msmsg-') || !name.endsWith('.json')) continue;
        try {
          fs.unlinkSync(path.join(captureDir, name));
          deleted += 1;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return deleted;
  }

  function record({ sessionId, node, secretMatched = null, decryptOutcome = 'not_attempted' } = {}) {
    if (!effectiveEnabled || !captureDir || !node) {
      return null;
    }
    purgeExpired();

    const telemetry = buildSafeMsmsgTelemetry({
      sessionId,
      node,
      secretMatched,
      decryptOutcome,
    });
    const recordObj = {
      ...telemetry,
      expires_at_ms: Date.now() + resolvedTtlMs,
    };

    if (effectiveIncludeCiphertext) {
      const contentNodes = Array.isArray(node?.content) ? node.content : [];
      const firstMsmsg = contentNodes.find(
        (c) => c && c.tag === 'enc' && String(c.attrs?.type || '').toLowerCase() === 'msmsg',
      );
      if (firstMsmsg && (Buffer.isBuffer(firstMsmsg.content) || firstMsmsg.content instanceof Uint8Array)) {
        recordObj.ciphertext_only_b64 = Buffer.from(firstMsmsg.content).toString('base64');
      }
    }

    try {
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(captureDir, 0o700); } catch { /* best-effort */ }

      const existing = fs
        .readdirSync(captureDir)
        .filter((f) => f.startsWith('msmsg-') && f.endsWith('.json'))
        .sort();
      while (existing.length >= MAX_CAPTURE_FILES) {
        const oldest = existing.shift();
        if (oldest) {
          try { fs.unlinkSync(path.join(captureDir, oldest)); } catch { /* ignore */ }
        }
      }

      const fileName = `msmsg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
      const outPath = path.join(captureDir, fileName);
      fs.writeFileSync(outPath, JSON.stringify(recordObj, null, 2), { encoding: 'utf8', mode: 0o600 });
      return outPath;
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to write isolated msmsg capture artifact');
      return null;
    }
  }

  return {
    enabled: effectiveEnabled,
    includeRawCiphertext: effectiveIncludeCiphertext,
    captureDir,
    record,
    purgeExpired,
    purgeAll,
  };
}

