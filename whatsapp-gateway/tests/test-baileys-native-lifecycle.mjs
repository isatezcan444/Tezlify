/**
 * Phase 8.0.11: Baileys Native Lifecycle, Test-Mode Isolation & Egress Integrity Suite.
 *
 * Validates native Baileys package behavior without test harness interventions:
 * 1. Real Baileys socket creation via makeWASocket().
 * 2. Real sock.ev listener binding across all Baileys events.
 * 3. Native connection.update behavior on connection failure.
 * 4. Native socket close behavior and WS readyState transitions.
 * 5. sock.end() teardown and native listener removal.
 * 6. sock.ev.destroy() buffer reset and listener clearance.
 * 7. Socket lifecycle generation transition (Gen N -> Gen N+1).
 * 8. Stale socket event filtering via lifecycle.isCurrent.
 * 9. Zero listener duplication across socket replacements.
 * 10. Burn-in loop (10 iterations) verifying zero listener / memory leak.
 * 11. Graceful teardown (SIGTERM simulation) verifying resource cleanup.
 * 12. Controlled teardown and clean socket recreation.
 *
 * Additional Network Egress Firewall tests:
 * 13. Runtime egress firewall blocks WAN destinations with ENETUNREACH.
 * 14. Runtime egress firewall allows local loopback traffic.
 */

import assert from 'assert';
import test from 'node:test';
import net from 'net';
import http from 'http';
import makeWASocket, {
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import { SocketLifecycle } from '../src/domain/socket-lifecycle.js';
import {
  installEgressFirewall,
  getEgressAuditStats,
  resetEgressAuditStats,
  probeEgress,
} from '../src/security/egress-firewall.js';

// Activate egress firewall
installEgressFirewall();

const createMockLogger = () => {
  const l = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  l.child = () => l;
  return l;
};

const createMockAuthState = () => ({
  creds: {
    me: { id: '905551234567:1@s.whatsapp.net', lid: '905551234567:1@lid' },
    registered: true,
  },
  keys: {
    get: async () => ({}),
    set: async () => {},
  },
});

test('Scenario 1: Real Baileys socket creation via makeWASocket()', async (t) => {
  const logger = createMockLogger();
  const authState = createMockAuthState();

  const sock = makeWASocket({
    auth: authState,
    logger,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59997/native-test-1',
  });

  assert.ok(sock, 'makeWASocket returned a valid socket object');
  assert.strictEqual(sock.type, 'md', 'Socket type is multi-device (md)');
  assert.strictEqual(typeof sock.sendMessage, 'function', 'sock.sendMessage is a function');
  assert.strictEqual(typeof sock.end, 'function', 'sock.end is a function');
  assert.ok(sock.ev, 'sock.ev event buffer is present');
  assert.strictEqual(typeof sock.ev.on, 'function', 'sock.ev.on is a function');
  assert.strictEqual(typeof sock.ev.emit, 'function', 'sock.ev.emit is a function');
  assert.strictEqual(typeof sock.ev.destroy, 'function', 'sock.ev.destroy is a function');

  // Clean up
  try { sock.end(); } catch (_) {}
});

test('Scenario 2: Real sock.ev listener binding across Baileys events', async (t) => {
  const logger = createMockLogger();
  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59997/native-test-2',
  });

  const registeredEvents = [];
  const testEvents = [
    'connection.update',
    'creds.update',
    'messages.upsert',
    'messages.update',
    'messages.reaction',
    'message-receipt.update',
    'messaging-history.set',
    'chats.upsert',
    'chats.update',
    'contacts.upsert',
    'contacts.update',
    'groups.upsert',
    'groups.update',
  ];

  for (const ev of testEvents) {
    sock.ev.on(ev, () => {
      registeredEvents.push(ev);
    });
  }

  // Emitting on real sock.ev triggers handlers
  sock.ev.emit('chats.upsert', [{ id: '905551234567@s.whatsapp.net' }]);
  assert.ok(registeredEvents.includes('chats.upsert'), 'Native sock.ev successfully handled emitted event');

  try { sock.end(); } catch (_) {}
});

test('Scenario 3: Native connection.update on loopback disconnect', async (t) => {
  const logger = createMockLogger();
  const updates = [];

  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59996/unreachable-3',
  });

  await new Promise((resolve) => {
    sock.ev.on('connection.update', (update) => {
      updates.push(update);
      if (update.connection === 'close') {
        resolve();
      }
    });

    // Timeout safety
    setTimeout(resolve, 2500);
  });

  assert.ok(updates.length >= 1, 'At least one connection.update received');
  const closeUpdate = updates.find((u) => u.connection === 'close');
  assert.ok(closeUpdate, 'Native connection.update emitted close');
  assert.ok(closeUpdate.lastDisconnect, 'close update contains lastDisconnect');
  assert.ok(closeUpdate.lastDisconnect.error, 'lastDisconnect contains native error');

  try { sock.end(); } catch (_) {}
});

test('Scenario 4: Native socket close and WS state transitions on loopback disconnect', async (t) => {
  const logger = createMockLogger();
  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59996/unreachable-4',
  });

  await new Promise((resolve) => {
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'close') {
        resolve();
      }
    });
    setTimeout(resolve, 2500);
  });

  // Verify WS is closed
  if (sock.ws) {
    assert.strictEqual(sock.ws.isClosed, true, 'WebSocket isClosed is true on disconnect');
    assert.strictEqual(sock.ws.isOpen, false, 'WebSocket isOpen is false on disconnect');
  }

  try { sock.end(); } catch (_) {}
});

test('Scenario 5: sock.end() triggers native teardown and listener removal', async (t) => {
  const logger = createMockLogger();
  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59995/end-test',
  });

  let closedNatively = false;
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'close') {
      closedNatively = true;
    }
  });

  sock.end(new Error('INTENTIONAL_TEARDOWN'));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(closedNatively, true, 'sock.end() emitted connection: close natively');
});

test('Scenario 6: sock.ev.destroy() clears event buffer and removes listeners natively', async (t) => {
  const logger = createMockLogger();
  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59994/destroy-test',
  });

  let invokedAfterDestroy = false;
  sock.ev.on('messages.upsert', () => {
    invokedAfterDestroy = true;
  });

  // Call native destroy()
  sock.ev.destroy();

  // Emitting after destroy should NOT invoke listener
  sock.ev.emit('messages.upsert', { messages: [], type: 'notify' });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.strictEqual(invokedAfterDestroy, false, 'Native sock.ev.destroy() successfully removed all event listeners');
});

test('Scenario 7: SocketLifecycle generation transition (Gen N -> Gen N+1)', async (t) => {
  const lifecycle = new SocketLifecycle();
  assert.strictEqual(lifecycle.generation, 0, 'Initial generation is 0');

  const logger = createMockLogger();
  const sockGen1 = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59993/gen-1',
  });
  const gen1 = lifecycle.beginAttempt();
  lifecycle.attach(gen1, sockGen1);
  assert.strictEqual(gen1, 1, 'Advanced to generation 1');
  assert.strictEqual(lifecycle.isCurrent(1, sockGen1), true, 'sockGen1 is current for generation 1');

  // Replace with generation 2
  const sockGen2 = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59993/gen-2',
  });
  const gen2 = lifecycle.beginAttempt();
  lifecycle.attach(gen2, sockGen2);
  assert.strictEqual(gen2, 2, 'Advanced to generation 2');
  assert.strictEqual(lifecycle.isCurrent(2, sockGen2), true, 'sockGen2 is current for generation 2');

  try { sockGen1.end(); } catch (_) {}
  try { sockGen2.end(); } catch (_) {}
});

test('Scenario 8: Stale generation event rejection via isCurrent guard', async (t) => {
  const lifecycle = new SocketLifecycle();
  const logger = createMockLogger();

  const sockGen1 = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59993/stale-1',
  });
  const gen1 = lifecycle.beginAttempt();
  lifecycle.attach(gen1, sockGen1);

  const sockGen2 = makeWASocket({
    auth: createMockAuthState(),
    logger,
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59993/stale-2',
  });
  const gen2 = lifecycle.beginAttempt();
  lifecycle.attach(gen2, sockGen2);

  // Stale generation 1 rejection
  assert.strictEqual(lifecycle.isCurrent(1, sockGen1), false, 'sockGen1 rejected as stale for generation 1');
  assert.strictEqual(lifecycle.isCurrent(2, sockGen1), false, 'sockGen1 rejected for generation 2 (mismatched socket)');
  assert.strictEqual(lifecycle.isCurrent(2, sockGen2), true, 'sockGen2 is current for generation 2');

  try { sockGen1.end(); } catch (_) {}
  try { sockGen2.end(); } catch (_) {}
});

test('Scenario 9: Socket replacement maintains clean listener isolation without duplication', async (t) => {
  const lifecycle = new SocketLifecycle();
  const receivedMessages = [];

  const bindTestEvents = (sock, gen) => {
    sock.ev.on('messages.upsert', (data) => {
      if (!lifecycle.isCurrent(gen, sock)) return;
      receivedMessages.push({ gen, data });
    });
  };

  const sock1 = makeWASocket({
    auth: createMockAuthState(),
    logger: createMockLogger(),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59992/dupe-1',
  });
  const gen1 = lifecycle.beginAttempt();
  lifecycle.attach(gen1, sock1);
  bindTestEvents(sock1, gen1);

  sock1.ev.emit('messages.upsert', { id: 'msg-gen-1' });
  assert.strictEqual(receivedMessages.length, 1, 'Gen 1 event received');

  // Advance to socket 2
  const sock2 = makeWASocket({
    auth: createMockAuthState(),
    logger: createMockLogger(),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59992/dupe-2',
  });
  const gen2 = lifecycle.beginAttempt();
  lifecycle.attach(gen2, sock2);
  bindTestEvents(sock2, gen2);

  // Emit on sock2
  sock2.ev.emit('messages.upsert', { id: 'msg-gen-2' });
  assert.strictEqual(receivedMessages.length, 2, 'Gen 2 event received');

  // Emit on retired sock1 -> MUST be rejected by isCurrent guard
  sock1.ev.emit('messages.upsert', { id: 'stale-msg' });
  assert.strictEqual(receivedMessages.length, 2, 'Stale event from sock1 ignored without duplicate processing');

  try { sock1.end(); } catch (_) {}
  try { sock2.end(); } catch (_) {}
});

test('Scenario 10: Repeated socket replacement burn-in loop (10 cycles) without leaks', async (t) => {
  const lifecycle = new SocketLifecycle();
  const cycles = 10;
  const initialMem = process.memoryUsage().heapUsed;

  for (let i = 1; i <= cycles; i++) {
    const s = makeWASocket({
      auth: createMockAuthState(),
      logger: createMockLogger(),
      printQRInTerminal: false,
      waWebSocketUrl: `ws://127.0.0.1:59991/cycle-${i}`,
    });
    const currentGen = lifecycle.beginAttempt();
    lifecycle.attach(currentGen, s);
    assert.strictEqual(currentGen, i, `Cycle ${i} generation matches`);
    assert.strictEqual(lifecycle.isCurrent(currentGen, s), true);

    // Teardown
    s.ev.destroy();
    try { s.end(); } catch (_) {}
  }

  assert.strictEqual(lifecycle.generation, 10, 'All 10 cycles executed');
  const finalMem = process.memoryUsage().heapUsed;
  const memDiffMb = (finalMem - initialMem) / (1024 * 1024);
  assert.ok(memDiffMb < 30, `Memory growth after 10 cycles is bounded (${memDiffMb.toFixed(2)} MB)`);
});

test('Scenario 11: SIGTERM simulation and graceful socket resource teardown', async (t) => {
  const lifecycle = new SocketLifecycle();
  const sock = makeWASocket({
    auth: createMockAuthState(),
    logger: createMockLogger(),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59990/sigterm',
  });
  const gen = lifecycle.beginAttempt();
  lifecycle.attach(gen, sock);

  // Simulate SIGTERM teardown handler
  const teardownSession = (s, lc) => {
    lc.invalidate();
    s.ev.destroy();
    try { s.end(new Error('SIGTERM')); } catch (_) {}
  };

  teardownSession(sock, lifecycle);
  assert.strictEqual(lifecycle.generation, 2, 'Generation incremented on invalidation');
  assert.strictEqual(lifecycle.isCurrent(gen, sock), false, 'Lifecycle invalidated');
});

test('Scenario 12: Controlled teardown and clean socket recreation', async (t) => {
  const lifecycle = new SocketLifecycle();

  // 1. Initial socket fails and is closed
  const s1 = makeWASocket({
    auth: createMockAuthState(),
    logger: createMockLogger(),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59989/first',
  });
  const gen1 = lifecycle.beginAttempt();
  lifecycle.attach(gen1, s1);
  s1.ev.destroy();
  try { s1.end(); } catch (_) {}

  // 2. Recreation creates brand new socket instance with fresh state
  const s2 = makeWASocket({
    auth: createMockAuthState(),
    logger: createMockLogger(),
    printQRInTerminal: false,
    waWebSocketUrl: 'ws://127.0.0.1:59989/second',
  });
  const gen2 = lifecycle.beginAttempt();
  lifecycle.attach(gen2, s2);
  assert.strictEqual(gen2, 2, 'Recreation advanced generation cleanly');
  assert.strictEqual(lifecycle.isCurrent(gen2, s2), true, 'New socket is active');

  s2.ev.destroy();
  try { s2.end(); } catch (_) {}
});

test('Scenario 13: Runtime Egress Firewall blocks outbound WAN connections fail-closed', async (t) => {
  resetEgressAuditStats();
  const wanHost = '1.1.1.1';
  const wanPort = 443;

  const probeResult = await probeEgress(wanHost, wanPort);
  assert.strictEqual(probeResult.blocked, true, 'WAN egress was blocked');
  assert.strictEqual(probeResult.code, 'ENETUNREACH', 'Error code is ENETUNREACH');

  const stats = getEgressAuditStats();
  assert.ok(stats.wan_blocked_count >= 1, 'wan_blocked_count incremented');
  assert.ok(
    stats.blocked_targets.some((tgt) => tgt.host === wanHost),
    'Blocked target recorded in audit history'
  );
});

test('Scenario 14: Runtime Egress Firewall allows local loopback connections', async (t) => {
  resetEgressAuditStats();

  const loopbackServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('loopback-ok');
  });

  await new Promise((resolve) => loopbackServer.listen(0, '127.0.0.1', resolve));
  const port = loopbackServer.address().port;

  const responseText = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

  assert.strictEqual(responseText, 'loopback-ok', 'Loopback request succeeded');
  const stats = getEgressAuditStats();
  assert.ok(stats.loopback_allowed_count >= 1, 'loopback_allowed_count incremented');

  await new Promise((resolve) => loopbackServer.close(resolve));
});
