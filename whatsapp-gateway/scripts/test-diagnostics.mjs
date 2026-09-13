import assert from 'node:assert/strict';
import { sessionRef } from '../src/observability.js';

const rawSessionId = '4d53bdda-99e9-4a56-a6d0-388b92423715';
const first = sessionRef(rawSessionId);

assert.equal(first, sessionRef(rawSessionId), 'session correlation must be stable');
assert.equal(first.length, 12, 'session correlation must stay compact');
assert.equal(first.includes(rawSessionId), false, 'session UUID must not be exposed');
assert.notEqual(first, sessionRef('another-session'), 'different sessions must not share a correlation key');

console.log('[test-diagnostics] 4 assertions passed');
