// `jids` filtresi — kapsamli geri doldurma turu.
//
// Sorun (uretim, 2026-09-26): backend'in ilk-senkron job'i `since` suucunu
// KULLANICI GENELINDEKI en yeni INBOUND zaman damgasindan turetir ve gateway bu
// filtreyi SOHBET BASINA uygular. En yeni mesaji esikten eski olan her sohbet
// SIFIR mesaj doner. Hic satiri olmayan bir sohbet boylece sonraki senkronlarda
// asla doldurulamaz (esik yalnizca ILERI gider). Uretimde 112 sohbetin 19'u
// boyleydi.
//
// Cozum: backend, suucun disladigi sohbetler icin SUUCSLU (`since` yok) ve
// `jids` ile SINIRLI ikinci bir tur atar. Bu test o filtrenin sozlesmesini
// sabitler: yalnizca istenen sohbetler doner, filtre yoksa davranis degismez.
//
// Kaynak degisikligi geri alinirsa FAIL eder.
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

const CHAT_A = '905551110001@s.whatsapp.net';
const CHAT_B = '905551110002@s.whatsapp.net';
const CHAT_OLD = '905551110003@s.whatsapp.net';

function msg(jid, id, createdAt) {
  return {
    conversation_id: jid,
    wa_message_id: `wamid_${jid.split('@')[0]}_${id}`,
    body: `m${id}`,
    created_at: createdAt,
    id,
    direction: 'INBOUND',
  };
}

function makeManager() {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), 'bulk-jids-sessions'),
    mediaDir: path.join(os.tmpdir(), 'bulk-jids-media'),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

const sm = makeManager();
const sid = (await sm.createSession('bulk-jids-hat', { autoStart: false })).id;
const session = sm.getSession(sid);
const store = sm._storeOf(session);

store.messagesByChat.set(CHAT_A, [
  msg(CHAT_A, 1, '2026-09-26T10:00:00.000Z'),
  msg(CHAT_A, 2, '2026-09-26T10:05:00.000Z'),
]);
store.messagesByChat.set(CHAT_B, [msg(CHAT_B, 3, '2026-09-26T10:06:00.000Z')]);
// Suucun disladigi eski sohbet: en yeni mesaji esikten ESKI.
store.messagesByChat.set(CHAT_OLD, [
  msg(CHAT_OLD, 4, '2026-08-27T12:40:00.000Z'),
  msg(CHAT_OLD, 5, '2026-08-27T12:41:00.000Z'),
]);

const idsOf = (page) => page.messages.map((m) => m.conversation_id);
const cutoff = Math.floor(new Date('2026-09-26T09:00:00Z').getTime() / 1000);

// --- A. filtre yoksa davranis DEGISMEZ (tum sohbetler) ----------------------
{
  const page = sm.listAllMessages(sid, { limit: 1000, perChatLimit: 50 });
  assert.equal(page.messages.length, 5, 'all chats must be returned without a filter');
  check('A. no filter returns every chat (behaviour unchanged)', () => {});
}

// --- B. `since` eski sohbeti DISLAR (kok neden) ----------------------------
{
  const page = sm.listAllMessages(sid, { limit: 1000, perChatLimit: 50, since: cutoff });
  assert.equal(page.messages.length, 3, 'since must drop the older chat');
  assert.equal(
    idsOf(page).includes(CHAT_OLD),
    false,
    'the chat whose newest message predates the watermark must be excluded — this IS the bug',
  );
  check('B. `since` excludes the stale chat (the root cause)', () => {});
}

// --- C. `since` YOK + `jids` = kurtarma turu eski sohbeti GETIRIR ----------
{
  const page = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 50, since: null, jids: [CHAT_OLD],
  });
  assert.equal(page.messages.length, 2, 'the recovery pass must return the stale chat');
  assert.deepEqual(idsOf(page), [CHAT_OLD, CHAT_OLD]);
  check('C. recovery (since=null + jids) recovers the excluded chat', () => {});
}

// --- D. `jids` yalnizca istenenleri doner (kapsam dar) ---------------------
{
  const page = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 50, since: null, jids: [CHAT_A],
  });
  assert.deepEqual([...new Set(idsOf(page))], [CHAT_A], 'only the requested jid may return');
  assert.equal(page.messages.length, 2);
  check('D. `jids` scopes the response to exactly those chats', () => {});
}

// --- E. bos filtre = filtre yok (geriye donuk uyumlu) ----------------------
{
  const empty = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 50, since: null, jids: [],
  });
  assert.equal(empty.messages.length, 5, 'an empty jids list must not mean "nothing"');
  const nulled = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 50, since: null, jids: null,
  });
  assert.equal(nulled.messages.length, 5);
  check('E. empty/null jids falls back to all chats', () => {});
}

// --- F. bilinmeyen jid → bos (uydurma yok) --------------------------------
{
  const page = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 50, since: null, jids: ['999999@s.whatsapp.net'],
  });
  assert.equal(page.messages.length, 0, 'an unknown jid must return nothing');
  check('F. an unknown jid returns nothing', () => {});
}

// --- G. perChatLimit filtreyle birlikte hala uygulanir ---------------------
{
  const page = sm.listAllMessages(sid, {
    limit: 1000, perChatLimit: 1, since: null, jids: [CHAT_OLD],
  });
  assert.equal(page.messages.length, 1, 'perChatLimit must still cap each chat');
  assert.equal(page.messages[0].id, 5, 'the NEWEST message of the chat is kept');
  check('G. perChatLimit still applies within the filtered scope', () => {});
}

// --- H. rota `jids` parametresini iletir (sozlesme) -----------------------
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.ok(
    /jids\s*:\s*jids\s*!==\s*undefined/.test(src),
    'the /messages/bulk route must parse and forward `jids`',
  );
  assert.ok(
    /listAllMessages\(sessionId,\s*\{[\s\S]*?jids:/.test(src),
    'the route must pass `jids` into listAllMessages',
  );
  check('H. the bulk route forwards `jids`', () => {});
}

console.log(`\nBulk jids scope verification: PASS (${passed} checks)`);
