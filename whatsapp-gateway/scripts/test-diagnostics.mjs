import assert from 'node:assert/strict';
import { sessionRef } from '../src/observability.js';
import { createBaileysLogger } from '../src/session-manager.js';

const rawSessionId = '4d53bdda-99e9-4a56-a6d0-388b92423715';
const first = sessionRef(rawSessionId);

assert.equal(first, sessionRef(rawSessionId), 'session correlation must be stable');
assert.equal(first.length, 12, 'session correlation must stay compact');
assert.equal(first.includes(rawSessionId), false, 'session UUID must not be exposed');
assert.notEqual(first, sessionRef('another-session'), 'different sessions must not share a correlation key');

// Test Baileys error logger proxy for transient pre-key upload timeouts & notifications
const debugLogs = [];
const errorLogs = [];
const mockBaseLogger = {
  debug: (obj, msg) => debugLogs.push({ obj, msg }),
  error: (obj, msg) => errorLogs.push({ obj, msg }),
  info: () => {},
  warn: () => {},
  child: () => mockBaseLogger,
};

const proxyLogger = createBaileysLogger(mockBaseLogger);

// Scenario 1: Pre-key initialization upload timeout (from Render logs)
proxyLogger.error(
  {
    error: {
      data: null,
      isBoom: true,
      isServer: false,
      output: { statusCode: 408, payload: { statusCode: 408, error: 'Request Time-out', message: 'Pre-key upload timeout' } },
    },
    msg: 'Failed to check/upload pre-keys during initialization',
  },
  'Failed to check/upload pre-keys during initialization'
);

assert.equal(errorLogs.length, 0, 'Pre-key init timeout must NOT be logged as error');
assert.equal(debugLogs.length, 1, 'Pre-key init timeout must be demoted to debug');
assert.ok(debugLogs[0].msg.includes('[baileys-handshake]'), 'Must include [baileys-handshake] tag');

// Scenario 2: Notification handling error with Pre-key upload timeout
proxyLogger.error(
  {
    err: new Error('Pre-key upload timeout'),
    msg: "unexpected error in 'handling notification'",
  },
  "unexpected error in 'handling notification'"
);

assert.equal(errorLogs.length, 0, 'Notification pre-key timeout must NOT be logged as error');
assert.equal(debugLogs.length, 2, 'Notification pre-key timeout must be demoted to debug');

// Scenario 3: Real, non-transient error must stay at level 50 error
proxyLogger.error(
  { err: new Error('Database pool exhausted') },
  'Fatal database connection pool error'
);

assert.equal(errorLogs.length, 1, 'Real non-handshake errors must stay as error');
assert.ok(errorLogs[0].msg.includes('Fatal database connection pool error'));

console.log('[test-diagnostics] all sessionRef and createBaileysLogger assertions passed');
