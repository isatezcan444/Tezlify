/**
 * Regression test: reportOrphanedSession must never take the process down.
 *
 * The live symptom was a 502 on the pairing QR followed by a wall of 404s. The
 * gateway log showed why: this function fell back to a bare `console.error`
 * when the logger was unavailable, and the Pino plumbing in tools.js then read
 * `this[Symbol(pino.msgPrefix)]` off `undefined`. That TypeError escaped from
 * an async catch block, so it became an unhandled rejection and the whole
 * gateway process exited. The restart policy brought it back, but by then the
 * in-memory session was gone — which is exactly the 404 flood the user saw.
 *
 * A reporting function that can crash the reporter is a production outage, so
 * every branch here is asserted to return normally, including with a logger
 * that throws, is missing, or has a detached method.
 */
import assert from 'node:assert/strict';
import { reportOrphanedSession, resetOrphanReports } from '../src/outbox/postgres-event-outbox.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const silent = () => {};
const noop = () => {};

const originalError = console.error;
const originalWarn = console.warn;
console.error = () => {};
console.warn = () => {};

try {
  check('reports through the injected logger', () => {
    resetOrphanReports();
    const seen = [];
    const logger = { error: (payload, msg) => seen.push({ payload, msg }) };
    assert.equal(reportOrphanedSession('outbox', 's1', 'detail', logger), true);
    assert.equal(seen.length, 1, 'the diagnosis must be emitted exactly once');
    assert.equal(seen[0].payload.code, '23503', 'the FK violation code identifies the cause');
  });

  check('a missing logger does not throw', () => {
    resetOrphanReports();
    assert.equal(reportOrphanedSession('outbox', 's2', 'detail', undefined), true);
    assert.equal(reportOrphanedSession('outbox', 's3', 'detail', null), true);
  });

  check('a logger whose .error throws does not propagate', () => {
    resetOrphanReports();
    const hostile = {
      error() {
        // Exactly what pino does when `this` is lost: read a symbol off
        // undefined and throw.
        throw new TypeError("Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)'");
      },
    };
    // This is the assertion that failed in production: it used to throw out of
    // an async catch and take the gateway with it.
    assert.equal(reportOrphanedSession('outbox', 's4', 'detail', hostile), true);
  });

  check('a detached logger method is not invoked with a lost `this`', () => {
    resetOrphanReports();
    const logger = { error: function error() { if (!this) throw new TypeError('lost this'); } };
    assert.equal(reportOrphanedSession('outbox', 's5', 'detail', logger), true);
  });

  check('a non-function .error is ignored rather than called', () => {
    resetOrphanReports();
    assert.equal(reportOrphanedSession('outbox', 's6', 'detail', { error: 'not-a-function' }), true);
  });

  check('the same orphan is reported only once', () => {
    resetOrphanReports();
    const seen = [];
    const logger = { error: (p, m) => seen.push(m) };
    reportOrphanedSession('outbox', 'dup', 'detail', logger);
    reportOrphanedSession('outbox', 'dup', 'detail', logger);
    reportOrphanedSession('outbox', 'dup', 'detail', logger);
    assert.equal(seen.length, 1, 'a repeating foreign-key error is one problem, not thousands');
  });

  check('a different session is reported separately', () => {
    resetOrphanReports();
    const seen = [];
    const logger = { error: (p, m) => seen.push(p.session_id) };
    reportOrphanedSession('outbox', 'a', null, logger);
    reportOrphanedSession('outbox', 'b', null, logger);
    assert.deepEqual(seen, ['a', 'b'], 'each session needs its own diagnosis');
  });

  check('resetOrphanReports re-arms the reporter', () => {
    resetOrphanReports();
    const seen = [];
    const logger = { error: (p, m) => seen.push(m) };
    reportOrphanedSession('outbox', 'again', null, logger);
    resetOrphanReports();
    reportOrphanedSession('outbox', 'again', null, logger);
    assert.equal(seen.length, 2, 'a test reset must clear the dedupe set');
  });
} finally {
  console.error = originalError;
  console.warn = originalWarn;
}

console.log(`\n${passed}/8 checks passed`);
process.exit(passed === 8 ? 0 : 1);
