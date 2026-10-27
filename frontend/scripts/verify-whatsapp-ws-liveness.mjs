/**
 * REGRESSION TEST — the realtime socket must DETECT a dead connection.
 *
 * `start.py` disables the protocol-level keepalive (`ws_ping_interval=None`,
 * `ws_ping_timeout=None`), so the browser's only proof of life is the
 * application-level `{"type":"ping"}` / `{"type":"pong"}` exchange. The client
 * used to SEND the ping and then throw the pong away: nothing recorded when the
 * last one arrived, so nothing could ever conclude the link was gone.
 *
 * A half-open socket (laptop sleep, Wi-Fi switch, NAT rebind, proxy restart
 * without a FIN) keeps `readyState === OPEN` forever. `send()` succeeds into a
 * black hole, `onclose` never fires, no reconnect is scheduled and no
 * reconciliation runs — the UI sits there looking connected while no message
 * ever arrives again. That is the exact "UI lies about being connected" defect
 * this suite pins.
 *
 * Drives the REAL `createWebSocket` from `src/api/client.ts` against a fake
 * `WebSocket` and a virtual clock, so the assertions are about the client's
 * behaviour rather than about how long the test was willing to sleep.
 *
 * Run: node scripts/verify-whatsapp-ws-liveness.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    console.log(`  FAIL - ${label}${detail ? ` :: ${detail}` : ''}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------- virtual clock
// Installed BEFORE the bundle is imported: the client resolves setTimeout /
// setInterval / Date.now from the global object at call time.
let now = 0;
let seq = 0;
const timers = new Map();

function installClock() {
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = ++seq;
    timers.set(id, { id, due: now + ms, fn, every: null });
    return id;
  };
  globalThis.setInterval = (fn, ms = 0) => {
    const id = ++seq;
    timers.set(id, { id, due: now + ms, fn, every: Math.max(1, ms) });
    return id;
  };
  const clear = (id) => { timers.delete(id); };
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  const realNow = Date.now;
  Date.now = () => now;
  return () => { Date.now = realNow; };
}

/** Run every timer due within `ms`, in chronological order. */
function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null;
    for (const t of timers.values()) {
      if (t.due <= target && (!next || t.due < next.due)) next = t;
    }
    if (!next) break;
    now = next.due;
    if (next.every) next.due = now + next.every;
    else timers.delete(next.id);
    next.fn();
  }
  now = target;
}

// ------------------------------------------------------------- fake WebSocket
const sockets = [];
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    sockets.push(this);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket not open');
    this.sent.push(data);
  }

  /** Client-initiated close: mirrors the browser (onclose follows close()). */
  close() {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: 1006, reason: 'client close' });
  }

  /** Test helper: handshake completes. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  /** Test helper: the server answers a keepalive. */
  deliverPong() {
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  }

  pings() {
    return this.sent.filter((raw) => {
      try { return JSON.parse(raw)?.type === 'ping'; } catch { return false; }
    });
  }
}

async function main() {
  const restoreClock = installClock();
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // The client derives its base URL from `window.location` at import time.
    location: {
      protocol: 'http:',
      host: 'localhost:5173',
      hostname: 'localhost',
      port: '5173',
      origin: 'http://localhost:5173',
      href: 'http://localhost:5173/',
      pathname: '/',
    },
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  globalThis.document = undefined; // no visibility API in this harness

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tz-ws-liveness-'));
  const out = path.join(tmp, 'client.mjs');
  try {
    await build({
      entryPoints: [path.join(frontendRoot, 'src/api/client.ts')],
      bundle: true,
      outfile: out,
      format: 'esm',
      platform: 'browser',
      absWorkingDir: frontendRoot,
      nodePaths: [path.join(frontendRoot, 'node_modules')],
      define: {
        'import.meta.env.VITE_API_URL': '"/api/v1"',
        'import.meta.env': '{"VITE_API_URL":"/api/v1","DEV":false,"PROD":false,"MODE":"test"}',
        'process.env.NODE_ENV': '"development"',
      },
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'text' },
      logLevel: 'error',
    });

    const { createWebSocket } = await import(`file://${out}`);

    // ---------------------------------------------------------------- case 1
    // Silent peer: the socket stays OPEN but no pong ever comes back.
    console.log('[case 1] silent peer — the client must give up and reconnect');
    sockets.length = 0;
    const statuses = [];
    const events = [];
    const handle = createWebSocket(
      (data) => events.push(data),
      (connected) => statuses.push(connected),
    );

    check('a socket was created', sockets.length === 1, `count=${sockets.length}`);
    const first = sockets[0];
    first.open();
    check('open reported to the app', statuses[0] === true, JSON.stringify(statuses));

    // Two heartbeat intervals: pings go out, nothing comes back.
    advance(25_000);
    check('a keepalive ping was sent', first.pings().length === 1, `pings=${first.pings().length}`);
    check('a healthy-looking socket is not closed early', first.closeCalls === 0);

    advance(25_000);
    advance(25_000);

    check(
      'the silent socket was force-closed by the client',
      first.closeCalls > 0,
      `closeCalls=${first.closeCalls}, pings=${first.pings().length}`,
    );
    check(
      'the app was told the connection is gone',
      statuses.includes(false),
      JSON.stringify(statuses),
    );

    // And a reconnect must actually be scheduled, not just the status flipped.
    advance(31_000);
    check(
      'a replacement socket was opened',
      sockets.length >= 2,
      `sockets=${sockets.length}`,
    );

    handle.close();

    // ---------------------------------------------------------------- case 2
    // Healthy peer: every ping is answered, so nothing may be torn down.
    console.log('[case 2] answering peer — the client must keep the socket');
    sockets.length = 0;
    const healthyStatuses = [];
    const healthy = createWebSocket(() => {}, (c) => healthyStatuses.push(c));
    const live = sockets[0];
    live.open();

    for (let i = 0; i < 8; i += 1) {
      advance(25_000);
      // The pong for the ping that was just sent.
      live.deliverPong();
    }

    check('pings kept flowing', live.pings().length >= 8, `pings=${live.pings().length}`);
    check(
      'an answering socket was never closed',
      live.closeCalls === 0,
      `closeCalls=${live.closeCalls}`,
    );
    check(
      'no spurious disconnect was reported',
      !healthyStatuses.includes(false),
      JSON.stringify(healthyStatuses),
    );
    healthy.close();

    // ---------------------------------------------------------------- case 3
    // A late pong must revive the deadline rather than be ignored.
    console.log('[case 3] a single late pong must postpone the deadline');
    sockets.length = 0;
    const revived = createWebSocket(() => {});
    const s3 = sockets[0];
    s3.open();
    advance(25_000);          // ping #1 (silence 25s)
    advance(25_000);          // ping #2 (silence 50s) — at the edge
    s3.deliverPong();         // peer answers: deadline restarts here
    advance(25_000);          // silence 25s again — well inside the deadline
    check(
      'the answered socket survived the next interval',
      s3.closeCalls === 0,
      `closeCalls=${s3.closeCalls}`,
    );
    revived.close();
  } finally {
    restoreClock();
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length) {
    console.log(`[verify-whatsapp-ws-liveness] ${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('[verify-whatsapp-ws-liveness] All assertions passed.');
}

main().catch((err) => {
  console.error('[verify-whatsapp-ws-liveness] crashed:', err);
  process.exit(1);
});
