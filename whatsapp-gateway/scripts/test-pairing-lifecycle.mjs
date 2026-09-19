/**
 * Phase 6.4 §11/§12 — pairing single-flight, credential persistence and
 * session isolation, against the REAL session manager.
 *
 * Only `makeWASocket` is faked (the network boundary). Everything else —
 * QR encoding, the auth-state file store, the socket lifecycle/generation
 * guard, credential persistence — is the genuine implementation.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHarness, settle, cleanupHarness } from './pairing-harness.mjs';

const h = await createHarness();
const reg = h.registry;
let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

// ---------------------------------------------------------------- §12 single-flight
{
  const session = await h.manager.createSession('sf-hat', { ephemeral: true });
  const sock = await h.nextSocket('single-flight socket');
  await h.connectionUpdate(sock, { qr: 'QR-1' });
  await settle();

  reg.pairingCalls.length = 0;
  // Three concurrent code requests from the same session.
  const results = await Promise.all([
    h.manager.requestPairingCode(session.id, '905413749073'),
    h.manager.requestPairingCode(session.id, '905413749073'),
    h.manager.requestPairingCode(session.id, '905413749073'),
  ]);
  assert.equal(reg.pairingCalls.length, 1, `one provider request expected, got ${reg.pairingCalls.length}`);
  assert.equal(results.length, 3);
  for (const r of results) assert.equal(r.pairing_code, results[0].pairing_code);
  assert.equal(reg.sockets.length, 1, `no extra socket may be opened, got ${reg.sockets.length}`);
  ok('§12 three concurrent pairing-code requests collapse into one provider call');

  // A deliberate retry AFTER the first settles must still work.
  reg.pairingCalls.length = 0;
  const again = await h.manager.requestPairingCode(session.id, '905413749073');
  assert.equal(reg.pairingCalls.length, 1, 'a later retry must not be blocked');
  assert.ok(again.pairing_code);
  ok('§12 a deliberate retry after settle still issues a fresh code');
}

// ------------------------------------------------- §9 normalization at the boundary
{
  const mod = await import('../src/session-manager.js');
  const { normalizePairingPhone } = mod;
  const cases = [
    ['+905413749073', '905413749073'],
    ['905413749073', '905413749073'],
    ['00905413749073', '905413749073'],
    ['05413749073', '905413749073'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePairingPhone(input), expected, `${input} -> ${expected}`);
  }
  // International numbers must NOT be assumed to be Turkish.
  assert.equal(normalizePairingPhone('+1 512 345 6789'), '15123456789');
  assert.equal(normalizePairingPhone('005512345678'), '5512345678', 'Brazil must not become +90');
  ok('§9 the gateway normalizes every supported form to the canonical provider value');
}

// --------------------------------------------------- §11 credentials survive restart
// The restart reuses the PARENT sessions root, not the per-session dir: the
// manager derives `getSessionDir(sessionsDir, id)` itself.
let restartRoot = null;
let restartId = null;
let restartJid = null;
{
  const session = await h.manager.createSession('restart-hat', { ephemeral: false });
  restartId = session.id;
  const sock = await h.nextSocket('restart socket');
  await h.connectionUpdate(sock, { qr: 'QR-R' });
  await settle();
  const qrBefore = h.manager.getSession(restartId).qr_code;
  assert.ok(qrBefore, 'a fresh session must present a QR');

  // Provider completes the pairing handshake.
  sock.completePairing();
  await h.credsUpdate(sock);
  await h.connectionUpdate(sock, { connection: 'open' });
  await settle(10);
  assert.equal(h.manager.getSession(restartId).status, 'CONNECTED');
  assert.equal(h.manager.getSession(restartId).qr_code, null, 'QR must be cleared on open');
  ok('§11 pairing completes and clears the QR');

  // The credentials must really be on disk — not just in memory.
  restartRoot = h.sessionsDir;
  const credsPath = path.join(h.sessionsDirFor(restartId), 'creds.json');
  const onDisk = JSON.parse(await readFile(credsPath, 'utf8'));
  assert.equal(onDisk.registered, true, 'persisted creds must be marked registered');
  assert.equal(onDisk.me.id, '905413749073@s.whatsapp.net', 'persisted creds must carry me.id');
  restartJid = onDisk.me.id;
  ok('§11 the completed pairing persists registered credentials to the auth store');

  // Close the old socket. The restart's "cold" character comes from manager #2
  // being a brand-new instance with an EMPTY in-memory session map — it must
  // rebuild everything from the disk auth store, exactly like a new process.
  sock.end(undefined);
}

// ------------------------- §11 cold restart over the SAME sessions dir (new process)
{
  const h2 = await createHarness({ sessionsDir: restartRoot });
  h2.clearEvents();
  const recreated = await h2.manager.createSession('restart-hat', { id: restartId, ephemeral: false });
  const sock2 = await h2.nextSocket('cold-restart socket');

  // The whole point: the restarted socket must be handed the REGISTERED creds
  // read back from disk. That auth state is what Baileys uses to skip the QR.
  assert.equal(sock2.options.auth.creds.registered, true, 'restart must load registered creds');
  assert.equal(sock2.options.auth.creds.me.id, restartJid, 'restart must load the same identity');
  ok('§11 a cold restart restores the registered credentials from disk');

  // Connection completes without ever issuing a QR.
  await h2.connectionUpdate(sock2, { connection: 'open' });
  await settle(10);
  assert.equal(h2.manager.getSession(recreated.id).status, 'CONNECTED', 'restart must reconnect');
  assert.equal(
    h2.eventsOfType('session_qr_updated').length, 0,
    'a restart over persisted credentials must never emit a new QR',
  );
  ok('§11 a cold restart reconnects without a second QR');
}

// ------------------------------------------------ §6/§11 session isolation (QR modes)
{
  // Manager #2 created a socket of its own; skip past it so h's cursor is exact.
  h.syncSocketCursor();

  const a = await h.manager.createSession('iso-a', { ephemeral: true });
  const sockA = await h.nextSocket('isolation socket a');
  await h.connectionUpdate(sockA, { qr: 'QR-A' });
  await settle();

  const b = await h.manager.createSession('iso-b', { ephemeral: true });
  const sockB = await h.nextSocket('isolation socket b');
  await h.connectionUpdate(sockB, { qr: 'QR-B' });
  await settle();

  assert.notEqual(h.manager.getSession(a.id).qr_code, h.manager.getSession(b.id).qr_code);
  const qrEvents = h.eventsOfType('session_qr_updated');
  const lastA = qrEvents.filter((e) => e.session_id === a.id).pop();
  const lastB = qrEvents.filter((e) => e.session_id === b.id).pop();
  assert.equal(lastA.qr_code, h.manager.getSession(a.id).qr_code);
  assert.equal(lastB.qr_code, h.manager.getSession(b.id).qr_code);
  ok('§6 two pairings keep independent QR state and events');

  // A stale socket from A must not overwrite B's newer state.
  await h.connectionUpdate(sockA, { qr: 'QR-A-STALE' });
  await settle();
  assert.equal(h.manager.getSession(b.id).qr_code, lastB.qr_code, "A's late QR must not touch B");
  ok('§6 a stale socket cannot overwrite another session state');
}

console.log(`\n[test-pairing-lifecycle] ${checks} checks passed`);
await cleanupHarness();
process.exit(0);
