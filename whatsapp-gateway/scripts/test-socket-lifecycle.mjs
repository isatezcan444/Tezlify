import assert from 'node:assert/strict';
import { SocketLifecycle } from '../src/domain/socket-lifecycle.js';

const scheduled = [];
const cleared = [];
const lifecycle = new SocketLifecycle({
  setTimer(callback, delay) {
    const handle = { callback, delay };
    scheduled.push(handle);
    return handle;
  },
  clearTimer(handle) { cleared.push(handle); },
});

const socketA = { id: 'a' };
const generationA = lifecycle.beginAttempt();
lifecycle.attach(generationA, socketA);
assert.equal(lifecycle.isCurrent(generationA, socketA), true);

const socketB = { id: 'b' };
const generationB = lifecycle.beginAttempt();
const replaced = lifecycle.attach(generationB, socketB);
assert.equal(replaced, socketA);
assert.equal(lifecycle.isCurrent(generationA, socketA), false);
assert.equal(lifecycle.isCurrent(generationB, socketB), true);

let reconnects = 0;
assert.equal(lifecycle.scheduleReconnect(generationA, socketA, 100, () => { reconnects += 1; }), false);
assert.equal(lifecycle.scheduleReconnect(generationB, socketB, 200, () => { reconnects += 1; }), true);
assert.equal(lifecycle.scheduleReconnect(generationB, socketB, 300, () => { reconnects += 1; }), false);
assert.equal(scheduled.length, 1);
scheduled[0].callback();
assert.equal(reconnects, 1);

lifecycle.invalidate();
assert.equal(lifecycle.isCurrent(generationB, socketB), false);
assert.equal(lifecycle.hasReconnectTimer, false);

console.log('[test-socket-lifecycle] 11 assertions passed');
