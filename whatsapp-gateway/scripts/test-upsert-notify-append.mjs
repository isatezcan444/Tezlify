/**
 * AŞAMA 5.2 — `messages.upsert` `notify` / `append` davranış sözleşmesi (gateway).
 *
 * Neden: `socket-events.js` `type` alanını yalnızca teşhis log'una yazıyordu;
 * `_ingestUpsertMessage` onu hiç görmüyordu. Bu yüzden `append` (geçmiş/senkron
 * kapsamında eklenen mesaj) canlı `notify` ile aynı hattı paylaşıyordu:
 * rozeti artırıyor, sohbet önizlemesini oynatıyor ve `message_new` yayınlıyordu.
 *
 * Bu test ÜÇ katmanı ayrı ayrı doğrular:
 *   1. `socket-events.js` → `messages.upsert` dinleyicisi `type`'ı geçiriyor mu?
 *   2. `_ingestUpsertMessage` append'te rozeti artırıyor mu? (artırmamalı)
 *   3. `_touchChat` append'te önizleme/damga oynatıyor mu? (oynatmamalı)
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-upsert-append-'));
const sm = createSessionManager({
  sessionsDir: dir,
  mediaDir: dir,
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});
const sid = (await sm.createSession('upsert-append', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
session.ephemeral = true;

const ev = new EventEmitter();
const sock = { ev, async readMessages() { return true; } };
session.sock = sock;
const gen = session.lifecycle.beginAttempt();
session.lifecycle.attach(gen, sock);

bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

const emitted = [];
sm.onEvent((event) => emitted.push(event));

const PN = '905551112233@s.whatsapp.net';
const chatOf = () => session.store.chats.get(PN);
const lastNew = (waId) =>
  [...emitted].reverse().find((e) => e.event === 'message_new' && e.message?.wa_message_id === waId);

const mk = (id, body, ts) => ({
  key: { remoteJid: PN, fromMe: false, id },
  message: { conversation: body },
  messageTimestamp: ts,
});

const base = Math.floor(Date.now() / 1000);
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
};

console.log('[test-upsert-notify-append] Starting...');

try {
  // --- 1. notify: canlı davranış korunur --------------------------------
  const n1 = mk('UPSERT_NOTIFY_1', 'Canli mesaj', base + 10);
  await sm._ingestUpsertMessage(n1, sock, sid, { upsertType: 'notify' });
  const e1 = lastNew('UPSERT_NOTIFY_1');
  check('notify emits message_new with upsert_type=notify', () => {
    assert.ok(e1, 'message_new yayinlanmali');
    assert.equal(e1.upsert_type, 'notify');
  });
  check('notify increments unread', () => {
    assert.equal(chatOf().unread_count, 1);
  });

  // --- 2. append: yayın var ama rozet artmaz ----------------------------
  const a1 = mk('UPSERT_APPEND_1', 'Gecmis mesaj', base + 5);
  await sm._ingestUpsertMessage(a1, sock, sid, { upsertType: 'append' });
  const e2 = lastNew('UPSERT_APPEND_1');
  check('append still emits message_new (backend must persist it)', () => {
    assert.ok(e2, 'append de backend e gitmeli');
    assert.equal(e2.upsert_type, 'append');
  });
  check('append does NOT increment unread', () => {
    assert.equal(chatOf().unread_count, 1, 'rozet degismemeli');
  });
  check('append reports the unchanged badge (not a bump)', () => {
    // Append rozeti ARTIRMAZ; mevcut degeri oldugu gibi raporlar. Backend bu
    // alani append'te hic okumaz, ama sozlesme "artmamis deger" olmali.
    assert.equal(e2.unread_count, 1, 'append mevcut rozeti raporlar');
  });

  // --- 3. append önizlemeyi/damgayı oynatmaz ----------------------------
  const previewBefore = chatOf().last_message_preview;
  const tsBefore = chatOf().last_message_at;
  const a2 = mk('UPSERT_APPEND_2', 'Cok daha eski', base - 3600);
  await sm._ingestUpsertMessage(a2, sock, sid, { upsertType: 'append' });
  check('append does not move last_message_preview', () => {
    assert.equal(chatOf().last_message_preview, previewBefore);
  });
  check('append does not move last_message_at', () => {
    assert.equal(chatOf().last_message_at, tsBefore);
  });

  // --- 4. bilinmeyen type: sessizce yutulmaz, notify gibi işlenir ------
  const u1 = mk('UPSERT_UNKNOWN_1', 'Bilinmeyen', base + 20);
  await sm._ingestUpsertMessage(u1, sock, sid, { upsertType: 'weird_future_type' });
  const e3 = lastNew('UPSERT_UNKNOWN_1');
  check('unknown type is not treated as append', () => {
    assert.ok(e3, 'bilinmeyen type de islenmeli');
    assert.equal(e3.upsert_type, 'weird_future_type');
  });
  check('unknown type increments unread (notify fallback)', () => {
    assert.equal(chatOf().unread_count, 2);
  });

  // --- 5. UÇTAN UCA: socket-events `type`'ı gerçekten geçiriyor mu? -----
  const a3 = mk('UPSERT_VIA_SOCKET_APPEND', 'Soket uzerinden gecmis', base + 3);
  ev.emit('messages.upsert', { messages: [a3], type: 'append' });
  await new Promise((r) => setTimeout(r, 30));
  const e4 = lastNew('UPSERT_VIA_SOCKET_APPEND');
  check('socket-events forwards upsert type=append', () => {
    assert.ok(e4, 'socket-events append olayini islemeli');
    assert.equal(e4.upsert_type, 'append', 'type plumbing calismiyor');
  });
  check('socket-events append does not increment unread', () => {
    assert.equal(chatOf().unread_count, 2, 'uçtan uca append rozeti artirmamali');
  });

  const n2 = mk('UPSERT_VIA_SOCKET_NOTIFY', 'Soket uzerinden canli', base + 40);
  ev.emit('messages.upsert', { messages: [n2], type: 'notify' });
  await new Promise((r) => setTimeout(r, 30));
  const e5 = lastNew('UPSERT_VIA_SOCKET_NOTIFY');
  check('socket-events forwards upsert type=notify', () => {
    assert.ok(e5);
    assert.equal(e5.upsert_type, 'notify');
  });
  check('socket-events notify increments unread', () => {
    assert.equal(chatOf().unread_count, 3);
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`[test-upsert-notify-append] FAILED (${failures} assertion)`);
  process.exit(1);
}
console.log('[test-upsert-notify-append] All checks passed');
