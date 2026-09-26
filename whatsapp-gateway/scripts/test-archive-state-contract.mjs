// Arsiv durumu sozlesme testi.
//
// SORUN (uretim, 2026-09-26): 112 sohbetin YALNIZCA 1'i arsivli gorunuyordu
// (`is_archived=true`); kullanici "gercekten arsivlediklerim orada yok" dedi.
// Gateway'in KENDI store'u de ayni tek sohbeti arsivli gosteriyordu, ama
// 112 sohbetin 112'si `archived` anahtari tasiyordu (111'i `false`).
//
// Kok neden iki katmanli:
//   1. Baileys `getChatUpdateConditional` (Utils/chat-utils.js) yalnizca
//      `isInitialSync` sirasinda bir kosul dondurur. O kosul, sohbet
//      `historySets.chats` / `chatUpserts` icinde YOKSA `undefined` doner;
//      `event-buffer.js` `append()` bu durumda guncellemeyi `chatUpdates`'a
//      koyar ve `flush()` onu `newData`'ya tasiyip ASLA yaymaz. Yani ilk QR
//      eslesmesinde mesaj gecmisi gelmeyen sohbetlerin arsiv durumu gateway'e
//      hic ULASMAZ.
//   2. Gateway dort yazicida da bilinmeyen arsiv durumunu `false` olarak
//      IDDIA ediyordu (`?? false` / sabit `false`). Backend sozlesmesi ise
//      "anahtar yoksa dokunma" (`if "archived" in payload:`) — ama anahtar
//      her zaman gonderildigi icin bu koruma OLUYDU. Ayrica gateway'in store'u
//      yalnizca bellekte yasar: bir restart sonrasi gelen history chunk'i
//      DB'de `true` olan bir arsivi `false` ile eziyordu.
//
// Bu test, bilinmeyen durumun `false` olarak iddia EDILMEDIGINI ve BILINEN
// durumun (true da false da) kaybedilmedigini sabitler. Kaynak degisikligi geri
// alinirsa FAIL eder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archivedPatch } from '../src/utils/whatsapp-formatting.js';
import { createSessionManager } from '../src/session-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

let passed = 0;
// `await fn()` — E/F/G gercek `_touchChat` cagirir ve async'tir. Senkron
// cagirmak, reddedilen bir promise'i yutup testi yalanci sekilde "gecer"
// gosterirdi.
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

function makeManager(tag) {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), `archive-contract-${tag}`),
    mediaDir: path.join(os.tmpdir(), `archive-contract-media-${tag}`),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

// --- A. bilinmeyen durum `false` IDDIA EDILMEZ ------------------------------
await check('A. unknown archive state omits the key entirely', () => {
  assert.deepEqual(archivedPatch(undefined), {},
    'an unknown archive state must not be asserted as false');
  assert.deepEqual(archivedPatch(null), {},
    'a null archive state must not be asserted as false');
  assert.equal(
    Object.prototype.hasOwnProperty.call(archivedPatch(undefined), 'archived'),
    false,
    'the key must be ABSENT, not present-and-undefined',
  );
});

// --- B/C. BILINEN durum korunur (hem unarchive hem archive) ------------------
await check('B. an explicit unarchive still propagates', () => {
  assert.deepEqual(archivedPatch(false), { archived: false },
    'a KNOWN false must still be sent, otherwise unarchive would never reach the backend');
});

await check('C. an explicit archive still propagates', () => {
  assert.deepEqual(archivedPatch(true), { archived: true });
  assert.deepEqual(archivedPatch(1), { archived: true }, 'truthy input is coerced to a boolean');
});

// --- D. tel format: backend `"archived" in item` kapisi ATESLENIR ------------
await check('D. the wire payload drops the key so the backend guard can fire', () => {
  const unknownChat = { jid: 'x@g.us', name: 'G', ...archivedPatch(undefined) };
  const wire = JSON.parse(JSON.stringify(unknownChat));
  assert.equal(
    Object.prototype.hasOwnProperty.call(wire, 'archived'),
    false,
    'the backend only preserves its stored value when the key is absent from the JSON payload',
  );
  const knownChat = { jid: 'x@g.us', name: 'G', ...archivedPatch(true) };
  assert.equal(JSON.parse(JSON.stringify(knownChat)).archived, true,
    'a known archive must survive serialization');
});

// --- E. GERCEK yazici: _touchChat bilinmeyen durumu iddia etmez -------------
await check('E. _touchChat on an unknown chat does not assert archived:false', async () => {
  const sm = makeManager('touch-unknown');
  const sid = (await sm.createSession('t1', { autoStart: false })).id;
  const session = sm.getSession(sid);
  const jid = '905000000001@s.whatsapp.net';

  // Sohbet store'da HIC yok — gateway arsiv durumunu bilmiyor.
  sm._touchChat(session, jid, 'merhaba', new Date().toISOString());

  const chat = sm._storeOf(session).chats.get(jid);
  assert.ok(chat, 'the chat must be created');
  assert.equal(
    Object.prototype.hasOwnProperty.call(chat, 'archived'),
    false,
    'an unknown archive state must NOT be written as a definite false',
  );
  // Bu, backend'e giden REST/WS payload'inin aynisi.
  const wire = JSON.parse(JSON.stringify(chat));
  assert.equal(
    Object.prototype.hasOwnProperty.call(wire, 'archived'),
    false,
    'the emitted payload must omit `archived`, so the backend keeps its stored value',
  );
});

// --- F. GERCEK yazici: bilinen arsiv KAYBEDILMEZ (restart clobber) ----------
await check('F. _touchChat preserves a KNOWN archived:true (no restart clobber)', async () => {
  const sm = makeManager('touch-true');
  const sid = (await sm.createSession('t2', { autoStart: false })).id;
  const session = sm.getSession(sid);
  const jid = '905000000002@s.whatsapp.net';

  // Store'da arsivli olarak bilinen sohbet (orn. arsiv mutation'i yayilmisti).
  const store = sm._storeOf(session);
  store.chats.set(jid, { jid, id: jid, name: 'Arsivli', archived: true });

  sm._touchChat(session, jid, 'yeni mesaj', new Date().toISOString());

  const chat = store.chats.get(jid);
  assert.equal(chat.archived, true,
    'a message arriving must not un-archive a chat the gateway knows is archived');
  assert.equal(JSON.parse(JSON.stringify(chat)).archived, true);
});

// --- G. GERCEK yazici: bilinen unarchive de korunur -------------------------
await check('G. _touchChat preserves a KNOWN archived:false', async () => {
  const sm = makeManager('touch-false');
  const sid = (await sm.createSession('t3', { autoStart: false })).id;
  const session = sm.getSession(sid);
  const jid = '905000000003@s.whatsapp.net';

  const store = sm._storeOf(session);
  store.chats.set(jid, { jid, id: jid, name: 'Normal', archived: false });

  sm._touchChat(session, jid, 'yeni mesaj', new Date().toISOString());

  assert.equal(store.chats.get(jid).archived, false,
    'a known unarchived state must stay an explicit false, not become unknown');
});

// --- H. yapisal: hicbir yazici `archived`'i tekrar false'a sabitlememeli ----
await check('H. no gateway source asserts a default archived:false', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (/archived\s*:\s*[^,]+\?\?\s*false/.test(code) || /archived\s*:\s*false\s*,?\s*$/.test(code)) {
          offenders.push(`${path.relative(SRC, full)}:${i + 1}: ${code}`);
        }
      });
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [],
    `archive writers must go through archivedPatch(); found:\n${offenders.join('\n')}`);
});

console.log(`\nArchive state contract verification: PASS (${passed} checks)`);
