// `afterSeq` / `seqEpoch` sayfalama sözleşmesi (AŞAMA 4.7).
//
// NEDEN: backend kalıcılaştırma turu, gateway RAM'ini offset ile sayfalıyordu.
// Gateway sohbet başına 2000 mesajı aştığında EN ESKİLERİ atar; liste başından
// eviction indeksleri sola kaydırır, `offset` sabit kaldığı için hiç görülmemiş
// kayıtlar sessizce atlanır. `_seq` ekleme anında atanan bir DEĞER olduğu için
// eviction imleci kaydıramaz. `seqEpoch` ise süreç yeniden kurulduğunda
// (seq'ler sıfırdan başlar) imlecin güvenli biçimde sıfırlanmasını sağlar.
//
// Bu test ÜÇ şeyi sabitler:
//   1. Yeni sözleşme gerçekten dönüyor (pagination/seq_epoch/next_after_seq...).
//   2. Parametre VERİLMEZSE eski offset davranışı AYNEN korunuyor (eski backend
//      yeni gateway ile, yeni backend eski gateway ile çalışabilsin).
//   3. Front-trim seq modunda kayıp ÜRETMİYOR — offset modunda üretiyor.
//
// Kaynak değişikliği geri alınırsa FAIL eder.
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

const CHAT = '905551120001@s.whatsapp.net';

function msg(id, createdAt) {
  return {
    conversation_id: CHAT,
    wa_message_id: `wamid_seq_${id}`,
    body: `m${id}`,
    created_at: createdAt,
    id,
    direction: 'INBOUND',
  };
}

function makeManager() {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), 'bulk-seq-sessions'),
    mediaDir: path.join(os.tmpdir(), 'bulk-seq-media'),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

const sm = makeManager();
const sid = (await sm.createSession('bulk-seq-hat', { autoStart: false })).id;
const session = sm.getSession(sid);
const store = sm._storeOf(session);

// 6 mesaj — created_at artan, `id` artan (offset sıralaması buna göre).
const base = Date.UTC(2026, 9, 21, 9, 0, 0);
const all = [];
for (let i = 0; i < 6; i += 1) {
  all.push(msg(i + 1, new Date(base + i * 60_000).toISOString()));
}
store.messagesByChat.set(CHAT, all);

const idsOf = (page) => page.messages.map((m) => m.wa_message_id);

// --- A. seq modu sözleşmesi -----------------------------------------------
let firstPage;
{
  firstPage = sm.listAllMessages(sid, { limit: 3, afterSeq: 0 });
  assert.equal(firstPage.pagination, 'seq', 'seq mode must announce itself');
  assert.equal(firstPage.messages.length, 3);
  assert.equal(firstPage.after_seq, 0);
  assert.equal(firstPage.offset, 0, 'seq mode must not report a moving offset');
  assert.equal(typeof firstPage.seq_epoch, 'string');
  assert.ok(firstPage.seq_epoch.length > 0, 'seq_epoch must be a non-empty string');
  assert.equal(typeof firstPage.next_after_seq, 'number');
  assert.ok(firstPage.next_after_seq > 0, 'next_after_seq must advance');
  assert.equal(firstPage.epoch_reset, false, 'first call has no epoch to compare');
  assert.equal(firstPage.reached_end, false);
  assert.deepEqual(idsOf(firstPage), ['wamid_seq_1', 'wamid_seq_2', 'wamid_seq_3']);
  check('A. seq mode returns pagination/seq_epoch/next_after_seq/reached_end', () => {});
}

// --- B. seq modu ikinci sayfa ---------------------------------------------
{
  const page2 = sm.listAllMessages(sid, {
    limit: 3, afterSeq: firstPage.next_after_seq, seqEpoch: firstPage.seq_epoch,
  });
  assert.equal(page2.pagination, 'seq');
  assert.equal(page2.after_seq, firstPage.next_after_seq);
  assert.equal(page2.epoch_reset, false);
  assert.deepEqual(idsOf(page2), ['wamid_seq_4', 'wamid_seq_5', 'wamid_seq_6']);
  // `reached_end` bir "kısa sayfa" sezgisidir: toplam tam olarak `limit`in
  // katıysa son sayfa da DOLU gelir ve bayrak false kalır. Backend bunu
  // bedava karşılar (boş sayfa görünce `reached_end` sayar), ama maliyeti
  // tur başına BİR fazla istektir. Sözleşmeyi olduğu gibi sabitliyoruz.
  assert.equal(page2.reached_end, false, 'a full page cannot prove the end');
  const page3 = sm.listAllMessages(sid, {
    limit: 3, afterSeq: page2.next_after_seq, seqEpoch: page2.seq_epoch,
  });
  assert.equal(page3.messages.length, 0, 'one extra empty page terminates the scan');
  assert.equal(page3.reached_end, true);
  assert.equal(page3.next_after_seq, page2.next_after_seq, 'cursor must not move');
  check('B. a second seq page continues strictly after the cursor', () => {});
}

// --- C. parametre yoksa ESKİ offset davranışı aynen korunur ----------------
{
  const page = sm.listAllMessages(sid, { limit: 1000, offset: 0 });
  assert.equal(page.pagination, 'offset', 'omitting afterSeq must stay in offset mode');
  assert.equal(page.messages.length, 6);
  assert.equal(page.total, 6);
  assert.equal(page.offset, 0);
  assert.equal(page.limit, 1000);
  assert.equal(page.reached_end, true);
  assert.equal(page.seq_epoch, undefined, 'offset mode must not invent a seq epoch');
  assert.equal(page.next_after_seq, undefined);
  check('C. no afterSeq -> legacy offset shape is unchanged', () => {});
}

// --- D. seq değerleri benzersiz ve kesin artan ----------------------------
{
  const seqs = all.map((m) => m._seq);
  assert.ok(seqs.every((s) => typeof s === 'number'), 'every record must be stamped');
  assert.equal(new Set(seqs).size, seqs.length, 'seq values must be unique');
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], 'seq must be strictly increasing');
  }
  check('D. seq values are unique and strictly increasing', () => {});
}

// --- E. FRONT-TRIM: offset ATLAR, seq ATLAMAZ -----------------------------
{
  // Yeni bir depo: temiz bir karşılaştırma için.
  const sm2 = makeManager();
  const sid2 = (await sm2.createSession('bulk-seq-trim', { autoStart: false })).id;
  const store2 = sm2._storeOf(sm2.getSession(sid2));
  const list = [];
  for (let i = 0; i < 6; i += 1) {
    list.push(msg(i + 1, new Date(base + i * 60_000).toISOString()));
  }
  store2.messagesByChat.set(CHAT, list);

  // 1. tur: 3 mesaj (seq ile).
  const p1 = sm2.listAllMessages(sid2, { limit: 3, afterSeq: 0 });
  assert.deepEqual(idsOf(p1), ['wamid_seq_1', 'wamid_seq_2', 'wamid_seq_3']);

  // Front-trim: en eski 2 mesaj RAM'den atıldı (2000 sınırı).
  store2.messagesByChat.set(CHAT, list.slice(2));

  // 2. tur (seq): kalan 4 kayıttan 3'ü gelmeli — 4,5,6.
  const p2 = sm2.listAllMessages(sid2, {
    limit: 3, afterSeq: p1.next_after_seq, seqEpoch: p1.seq_epoch,
  });
  assert.deepEqual(
    idsOf(p2),
    ['wamid_seq_4', 'wamid_seq_5', 'wamid_seq_6'],
    'seq mode must NOT skip anything after a front-trim',
  );

  // Aynı senaryo offset ile: 3. indeksten itibaren → yalnızca son kayıt.
  const off = sm2.listAllMessages(sid2, { limit: 3, offset: 3 });
  assert.deepEqual(
    idsOf(off),
    ['wamid_seq_6'],
    'offset mode skips records after a front-trim — this IS the defect seq fixes',
  );
  check('E. front-trim skips in offset mode but not in seq mode', () => {});
}

// --- F. epoch değişimi güvenli yeniden tarama -----------------------------
{
  const page = sm.listAllMessages(sid, {
    limit: 1000, afterSeq: 999_999, seqEpoch: 'stale-epoch-from-a-dead-process',
  });
  assert.equal(page.epoch_reset, true, 'a different epoch must be reported');
  assert.equal(page.after_seq, 0, 'epoch reset must restart the scan from zero');
  assert.equal(page.messages.length, 6, 'a reset cursor must rescan everything');
  assert.equal(page.pagination, 'seq');
  check('F. an epoch mismatch resets the cursor instead of losing records', () => {});
}

// --- G. bilinmeyen/bozuk afterSeq offset'e DÜŞMEZ, sessizce yok sayılır ---
{
  const page = sm.listAllMessages(sid, { limit: 1000, afterSeq: 'not-a-number' });
  assert.equal(
    page.pagination, 'offset',
    'a non-numeric afterSeq cannot select seq mode; offset is the safe fallback',
  );
  check('G. a malformed afterSeq falls back to offset (no silent seq mode)', () => {});
}

// --- H. rota yeni parametreleri iletir (sözleşme) -------------------------
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  assert.ok(
    /afterSeq\s*!==\s*undefined/.test(src),
    'the /messages/bulk route must parse `afterSeq`',
  );
  assert.ok(
    /seqEpoch\s*!==\s*undefined/.test(src),
    'the /messages/bulk route must parse `seqEpoch`',
  );
  assert.ok(
    /listAllMessages\(sessionId,\s*\{[\s\S]*?afterSeq:/.test(src),
    'the route must pass `afterSeq` into listAllMessages',
  );
  assert.ok(
    /listAllMessages\(sessionId,\s*\{[\s\S]*?seqEpoch:/.test(src),
    'the route must pass `seqEpoch` into listAllMessages',
  );
  check('H. the bulk route forwards afterSeq/seqEpoch', () => {});
}

console.log(`\nBulk seq pagination contract: PASS (${passed} checks)`);
