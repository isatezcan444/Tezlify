import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../src/features/whatsapp/lib/whatsappMessageMerge.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { mergeWhatsAppMessages, mergeDeliveryStatus } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const base = { conversation_id: 1, direction: 'OUTBOUND', body: 'body', created_at: '2026-01-01T00:00:00Z' };
const pending = { ...base, id: -1, client_message_id: 'client', status: 'PENDING' };
const ack = { ...base, id: 1, client_message_id: 'client', wa_message_id: 'wa', status: 'READ' };
const stale = { ...ack, status: 'SENT' };
assert.equal(mergeDeliveryStatus('READ', 'FAILED'), 'READ');
assert.equal(mergeDeliveryStatus('FAILED', 'READ'), 'READ');
for (const batch of [[pending, ack, stale], [ack, pending, stale], [stale, ack, pending]]) {
  const result = mergeWhatsAppMessages([], batch);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'READ');
  assert.equal(result[0].id, 1);
  assert.equal(result[0].wa_message_id, 'wa');
}
const existing = Array.from({ length: 1200 }, (_, i) => ({ ...base, id: i + 1, wa_message_id: `w${i}`, status: 'READ' }));
const split = mergeWhatsAppMessages([pending, { ...ack, client_message_id: undefined }], [ack]);
assert.equal(split.length, 1);
assert.equal(split[0].status, 'READ');
let overlap = mergeWhatsAppMessages([], [pending]);
overlap = mergeWhatsAppMessages(overlap, [ack]);
overlap = mergeWhatsAppMessages(overlap, [{ ...base, id: 2, wa_message_id: 'incoming', status: 'RECEIVED' }]);
overlap = mergeWhatsAppMessages(overlap, [stale, pending]);
assert.equal(overlap.length, 2);
assert.equal(overlap.find((m) => m.id === 1).status, 'READ');
const start = performance.now();
const merged = mergeWhatsAppMessages([...existing, pending], existing.slice(-50).map((m) => ({ ...m, status: 'SENT' })));
assert.equal(merged.length, 1201);
assert.equal(merged.filter((m) => m.status === 'READ').length, 1200);
console.log('Identity/status/reconnect retention PASS; 1200+pending merge ms:', performance.now() - start);