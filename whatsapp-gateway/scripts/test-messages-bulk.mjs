// Faz 10 (P5): gateway birim testleri — /messages/bulk kanali (listAllMessages).
// `node scripts/test-messages-bulk.mjs` ile calisir, exit code 0 = PASS.
// Kok neden regresyonu: sohbet basina ayri getMessages turu 113 HTTP istegi
// uretip backend initial-sync'ini Render timeout'una sokuyordu; bulk kanali
// tek flatten + deterministik offset sayfalamasi ile bunu tek tura indirir.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const sm = createSessionManager({
  sessionsDir: path.join(os.tmpdir(), 'bulk-test-sessions'),
  mediaDir: path.join(os.tmpdir(), 'bulk-test-media'),
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});

const JID_A = '905321002030@s.whatsapp.net';
const JID_B = '905339998877@s.whatsapp.net';
const JID_G = '120363012345678901@g.us';

// --- Bos bellek: probe sekli (limit=1) yine gecerli sozlesme doner ---

check('empty store: listAllMessages returns contract shape (messages/total/offset/limit)', () => {
  const res = sm.listAllMessages({ limit: 1, offset: 0 });
  assert.deepEqual(res, { messages: [], total: 0, offset: 0, limit: 1 });
});

// --- Sohbetler arasi flatten: tek kaynak, kayip/kopya yok ---

check('flatten across chats: every stored message appears exactly once', () => {
  for (let i = 0; i < 3; i += 1) sm._recordOutbound(JID_A, { body: `a${i}`, wa_message_id: `wamid_a${i}`, message_type: 'TEXT', status: 'SENT' });
  for (let i = 0; i < 2; i += 1) sm._recordOutbound(JID_B, { body: `b${i}`, wa_message_id: `wamid_b${i}`, message_type: 'TEXT', status: 'SENT' });
  sm._recordOutbound(JID_G, { body: `g0`, wa_message_id: 'wamid_g0', message_type: 'TEXT', status: 'SENT' });

  const all = sm.listAllMessages({ limit: 1000, offset: 0 });
  assert.equal(all.total, 6);
  assert.equal(all.messages.length, 6);
  const ids = all.messages.map((m) => m.wa_message_id).sort();
  assert.deepEqual(ids, ['wamid_a0', 'wamid_a1', 'wamid_a2', 'wamid_b0', 'wamid_b1', 'wamid_g0']);
});

// --- Deterministik offset sayfalamasi: birlesim = tam liste, kesisim bos ---

check('paging is deterministic: pages tile the full list with no gaps/overlaps', () => {
  const total = sm.listAllMessages({ limit: 1, offset: 0 }).total;
  const seen = [];
  let offset = 0;
  let guard = 0;
  while (offset < total && guard < 100) {
    const page = sm.listAllMessages({ limit: 2, offset });
    assert.equal(page.total, total);
    assert.equal(page.offset, offset);
    assert.equal(page.limit, 2);
    for (const m of page.messages) seen.push(m.wa_message_id);
    offset += page.messages.length;
    guard += 1;
    if (page.messages.length === 0) break;
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total); // kesisim/yinelenme yok
});

// --- Sayfa kaydirma sinirlari: offset >= total -> bos sayfa, total dogru ---

check('offset past end returns empty page but true total', () => {
  const res = sm.listAllMessages({ limit: 1000, offset: 9999 });
  assert.deepEqual(res.messages, []);
  assert.equal(res.total, 6);
});

// --- Kayit semasi: backend _message_row_from_gateway alanlarini tuketir ---

check('record shape: bulk rows carry backend-consumable fields (no raw WA objects)', () => {
  const page = sm.listAllMessages({ limit: 1000, offset: 0 });
  for (const m of page.messages) {
    assert.ok(typeof m.conversation_id === 'string' && m.conversation_id.includes('@'));
    assert.equal(m.direction, 'OUTBOUND');
    assert.equal(m.status, 'SENT');
    assert.ok(typeof m.body === 'string');
    assert.ok(m.wa_message_id);
    assert.ok(!Number.isNaN(Date.parse(m.created_at)));
    // Ham WhatsApp nesnesi sizmasin: `key`/`message` alani yok.
    assert.equal(m.key, undefined);
    assert.equal(m.message, undefined);
  }
});

console.log(`\nGateway bulk-messages tests: ${passed} passed.`);
