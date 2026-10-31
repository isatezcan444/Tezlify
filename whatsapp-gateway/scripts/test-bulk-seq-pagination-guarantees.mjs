// `afterSeq` / `seqEpoch` sayfalama GARANTİ testleri (AŞAMA 4.15).
//
// Kardeş dosya `test-bulk-seq-pagination.mjs` sözleşmenin ŞEKLİNİ sabitler
// (anahtarlar, mod ayrımı, front-trim'in seq'te atlamadığı). Bu dosya
// GARANTİLERİ sabitler: 2000 tavanı, 2001/5000 kayıt, trim ile imlecin
// yarışması, çok sohbet, boş sohbet, epoch yenilenmesi, `_seq` tekilliği ve
// `perChatLimit`'in imleçle birlikte kullanıldığında kayıt ELEMEMESİ.
//
// Testler GERÇEK gateway kodunu çalıştırır: `createSessionManager`,
// `listAllMessages`, `stampMessageSeq`, `trimChatMessages`,
// `boundMessagesByChat`, `storeSeqEpoch`. Mesajlar, üretim yazma yollarının
// (canlı upsert / giden kayıt / history sync) yaptığı sıranın AYNISINI
// uygulayarak eklenir: push → stamp → trim → bound. Kod değişikliği geri
// alınırsa FAIL eder.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionManager,
} from '../src/session-manager.js';
import {
  MESSAGES_PER_CHAT_MAX,
  createSessionStore,
  stampMessageSeq,
  trimChatMessages,
  boundMessagesByChat,
  storeSeqEpoch,
  messageSeqOf,
  ramCapacitySnapshot,
} from '../src/messages/message-store.js';

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (err) {
    console.error(`  FAIL - ${label}`);
    throw err;
  }
  passed += 1;
  console.log(`  ok - ${label}`);
};

const BASE = Date.UTC(2026, 9, 21, 9, 0, 0);
const chatKey = (n) => `9055511${String(n).padStart(5, '0')}@s.whatsapp.net`;

function record(id, key, createdAt) {
  return {
    conversation_id: key,
    wa_message_id: `wamid_g_${key.slice(0, 10)}_${id}`,
    body: `m${id}`,
    created_at: createdAt,
    id,
    direction: 'INBOUND',
  };
}

function makeManager(tag) {
  const manager = createSessionManager({
    sessionsDir: path.join(os.tmpdir(), `bulk-seq-g-${tag}-sessions`),
    mediaDir: path.join(os.tmpdir(), `bulk-seq-g-${tag}-media`),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
  // Depo ilk erişimde kurulur; kurulduğu anda log hedefini sustur.
  const originalStoreOf = manager._storeOf.bind(manager);
  manager._storeOf = (session) => silence(originalStoreOf(session));
  return manager;
}

// Üretim yazma yoluyla AYNI sıra: push → stamp → trim → bound.
function ingest(store, key, rec) {
  if (!store.messagesByChat.has(key)) store.messagesByChat.set(key, []);
  const list = store.messagesByChat.get(key);
  list.push(stampMessageSeq(store, rec));
  trimChatMessages(store, key, list);
  boundMessagesByChat(store, key);
  return rec;
}

const ids = (page) => page.messages.map((m) => m.wa_message_id);
const seqs = (page) => page.messages.map((m) => messageSeqOf(m));

// Eviction uyarıları üretimde DEĞERLİ, testte gürültü: her trim tek satır
// yazar ve 2000+ kayıt bastığımız için çıktı okunamaz hâle gelir. Yalnızca
// log hedefi susturulur — sayılan davranış (recordEviction) aynen çalışır.
const SILENT = { warn() {}, info() {}, debug() {}, error() {} };
const silence = (store) => { store.logger = SILENT; return store; };

const sm = makeManager('main');
const sid = (await sm.createSession('bulk-seq-guarantees', { autoStart: false })).id;
const store = sm._storeOf(sm.getSession(sid));

// ===========================================================================
// 1. Boş sohbet + `afterSeq=0` ilk sayfa davranışı
// ===========================================================================
check('1. an empty chat returns an empty seq page that announces the end', () => {
  const page = sm.listAllMessages(sid, { limit: 10, afterSeq: 0 });
  assert.equal(page.pagination, 'seq');
  assert.deepEqual(page.messages, []);
  assert.equal(page.reached_end, true);
  assert.equal(page.next_after_seq, 0, 'cursor must not move on an empty store');
  assert.equal(page.epoch_reset, false);
  assert.equal(typeof page.seq_epoch, 'string');
  assert.equal(page.eligible_total, 0);
});

// ===========================================================================
// 2. `afterSeq=0` ilk sayfa, dolu sohbet — en eski kayıttan başlar
// 10. Monoton `_seq` — aynı veri üzerinde
// ===========================================================================
const CHAT_A = chatKey(1);
const recsA = [];
for (let i = 0; i < 12; i += 1) {
  recsA.push(ingest(store, CHAT_A, record(i + 1, CHAT_A, new Date(BASE + i * 60_000).toISOString())));
}

check('2. afterSeq=0 returns the oldest records first, in insertion order', () => {
  const page = sm.listAllMessages(sid, { limit: 5, afterSeq: 0 });
  assert.deepEqual(ids(page), recsA.slice(0, 5).map((m) => m.wa_message_id));
  assert.deepEqual(seqs(page), [1, 2, 3, 4, 5]);
  assert.equal(page.reached_end, false);
  assert.equal(page.next_after_seq, 5);
});

check('10. _seq is strictly increasing in insertion order', () => {
  const values = recsA.map((m) => messageSeqOf(m));
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `seq must increase at index ${i}`);
  }
});

// ===========================================================================
// 3. `afterSeq=N` yalnızca N'den SONRAKİ kayıtları döndürür
// 5. Cursor + offset birlikte: SEQ önceliklidir, offset yok sayılır
// ===========================================================================
check('3. afterSeq=N returns only records with seq > N', () => {
  const page = sm.listAllMessages(sid, { limit: 100, afterSeq: 5 });
  assert.deepEqual(seqs(page), [6, 7, 8, 9, 10, 11, 12]);
  assert.equal(page.after_seq, 5);
  assert.equal(page.reached_end, true);
});

check('5. cursor wins over offset; offset is ignored and reported as 0', () => {
  const withOffset = sm.listAllMessages(sid, { limit: 3, afterSeq: 5, offset: 9 });
  const withoutOffset = sm.listAllMessages(sid, { limit: 3, afterSeq: 5 });
  assert.equal(withOffset.pagination, 'seq');
  assert.equal(withOffset.offset, 0, 'seq mode must never report a moving offset');
  assert.deepEqual(ids(withOffset), ids(withoutOffset), 'offset must not shift the page');
  assert.deepEqual(seqs(withOffset), [6, 7, 8]);
});

// ===========================================================================
// 4. `seqEpoch` eşleşmesi — reset YOK
// ===========================================================================
check('4. a matching seqEpoch does not reset the cursor', () => {
  const epoch = storeSeqEpoch(store);
  const page = sm.listAllMessages(sid, { limit: 3, afterSeq: 5, seqEpoch: epoch });
  assert.equal(page.epoch_reset, false);
  assert.equal(page.seq_epoch, epoch);
  assert.equal(page.after_seq, 5);
  assert.deepEqual(seqs(page), [6, 7, 8]);
});

// ===========================================================================
// 11. Gateway restart / epoch değişimi — eski cursor güvenli taramaya döner
// ===========================================================================
{
  const sm2 = makeManager('restart2');
  const sid2 = (await sm2.createSession('restart2', { autoStart: false })).id;
  const store2 = sm2._storeOf(sm2.getSession(sid2));
  for (let i = 0; i < 4; i += 1) {
    ingest(store2, CHAT_A, record(i + 1, CHAT_A, new Date(BASE + i * 60_000).toISOString()));
  }
  const epoch2 = storeSeqEpoch(store2);
  const epoch1 = storeSeqEpoch(store);
  check('11b. two stores never share a seq epoch', () => {
    assert.notEqual(epoch1, epoch2);
  });
  check('11c. a stale epoch from the old process rescans instead of returning nothing', () => {
    // Eski süreçte imleç seq=12'deydi; yeni depoda yalnızca 1..4 var.
    const stale = sm2.listAllMessages(sid2, { limit: 100, afterSeq: 12, seqEpoch: epoch1 });
    assert.equal(stale.epoch_reset, true, 'a foreign epoch must be reported');
    assert.equal(stale.after_seq, 0, 'the reset cursor restarts from zero');
    assert.deepEqual(seqs(stale), [1, 2, 3, 4], 'a reset must rescan, not return empty');
    assert.equal(stale.seq_epoch, epoch2);
  });
  check('11d. after a reset the NEXT call continues from the new epoch cursor', () => {
    const stale = sm2.listAllMessages(sid2, { limit: 2, afterSeq: 12, seqEpoch: epoch1 });
    const next = sm2.listAllMessages(sid2, {
      limit: 2, afterSeq: stale.next_after_seq, seqEpoch: stale.seq_epoch,
    });
    assert.equal(next.epoch_reset, false, 'the corrected epoch must not reset again');
    assert.deepEqual(seqs(next), [3, 4]);
  });
}

// ===========================================================================
// 6. 2000 mesaj tavanı
// ===========================================================================
{
  const smC = makeManager('cap');
  const sidC = (await smC.createSession('cap', { autoStart: false })).id;
  const storeC = smC._storeOf(smC.getSession(sidC));
  const CHAT_C = chatKey(2);
  const capRecs = [];
  for (let i = 0; i < MESSAGES_PER_CHAT_MAX; i += 1) {
    capRecs.push(ingest(storeC, CHAT_C, record(i + 1, CHAT_C, new Date(BASE + i * 1000).toISOString())));
  }
  check('6a. exactly MESSAGES_PER_CHAT_MAX records fit without eviction', () => {
    assert.equal(storeC.messagesByChat.get(CHAT_C).length, MESSAGES_PER_CHAT_MAX);
    assert.equal(storeC.evictionsByReason.per_chat_cap || 0, 0, 'no eviction at the cap');
    assert.equal(ramCapacitySnapshot(storeC).ram_chats_at_cap, 1);
  });
  check('6b. a full-cap chat is fully reachable through the seq cursor', () => {
    const p1 = smC.listAllMessages(sidC, { limit: 1000, afterSeq: 0 });
    const p2 = smC.listAllMessages(sidC, {
      limit: 1000, afterSeq: p1.next_after_seq, seqEpoch: p1.seq_epoch,
    });
    assert.equal(p1.messages.length + p2.messages.length, MESSAGES_PER_CHAT_MAX);
    const seen = new Set([...ids(p1), ...ids(p2)]);
    assert.equal(seen.size, MESSAGES_PER_CHAT_MAX, 'every record visited exactly once');
  });

  // =========================================================================
  // 7. 2001+ mesajlık sohbet — en eski kayıt RAM'den düşer, sayaç artar
  // =========================================================================
  const extra = ingest(storeC, CHAT_C, record(2001, CHAT_C, new Date(BASE + 2001 * 1000).toISOString()));
  check('7a. the 2001st message evicts the oldest and is counted', () => {
    const list = storeC.messagesByChat.get(CHAT_C);
    assert.equal(list.length, MESSAGES_PER_CHAT_MAX);
    assert.equal(list[0].wa_message_id, capRecs[1].wa_message_id, 'seq 1 was evicted');
    assert.equal(storeC.evictionsByReason.per_chat_cap, 1);
    assert.equal(messageSeqOf(extra), MESSAGES_PER_CHAT_MAX + 1);
  });
  check('7b. a cursor that already passed the evicted record still advances cleanly', () => {
    const page = smC.listAllMessages(sidC, {
      limit: 10, afterSeq: MESSAGES_PER_CHAT_MAX - 1, seqEpoch: storeSeqEpoch(storeC),
    });
    assert.deepEqual(seqs(page), [MESSAGES_PER_CHAT_MAX, MESSAGES_PER_CHAT_MAX + 1]);
  });
}

// ===========================================================================
// 8. Trim edilmiş eski cursor — RAM'de KALAN hiçbir kayıt atlanmaz
// 12. Aynı anda mesaj ekleme ve trim (sayfa aralarında)
// ===========================================================================
{
  const smT = makeManager('trim');
  const sidT = (await smT.createSession('trim', { autoStart: false })).id;
  const storeT = smT._storeOf(smT.getSession(sidT));
  const CHAT_T = chatKey(3);
  const allT = [];
  for (let i = 0; i < MESSAGES_PER_CHAT_MAX; i += 1) {
    allT.push(ingest(storeT, CHAT_T, record(i + 1, CHAT_T, new Date(BASE + i * 1000).toISOString())));
  }
  const first = smT.listAllMessages(sidT, { limit: 500, afterSeq: 0 });
  const cursor = first.next_after_seq;

  // Sayfa arasında 700 yeni mesaj gelir ⇒ en eski 700 kayıt trim edilir.
  for (let i = 0; i < 700; i += 1) {
    allT.push(ingest(storeT, CHAT_T, record(2001 + i, CHAT_T, new Date(BASE + (2001 + i) * 1000).toISOString())));
  }

  check('12a. adding messages between pages trims the oldest without moving the cursor', () => {
    const alive = new Set(storeT.messagesByChat.get(CHAT_T).map((m) => m.wa_message_id));
    const second = smT.listAllMessages(sidT, {
      limit: 5000, afterSeq: cursor, seqEpoch: first.seq_epoch,
    });
    const returned = ids(second);
    // 1) Hiçbir kayıt iki kez dönmemeli.
    assert.equal(new Set(returned).size, returned.length, 'no duplicate rows across pages');
    // 2) İmleçten sonra RAM'de KALAN her kayıt dönmeli (atlanan yok).
    const expected = storeT.messagesByChat.get(CHAT_T)
      .filter((m) => messageSeqOf(m) > cursor)
      .map((m) => m.wa_message_id);
    assert.deepEqual(returned, expected, 'no record still in RAM may be skipped');
    // 3) Dönen her kayıt gerçekten RAM'de olmalı.
    for (const id of returned) assert.ok(alive.has(id));
  });

  check('8. a cursor pointing at a trimmed record resumes at the first surviving one', () => {
    // İmleç seq=100'de ama 1..700 trim edildi ⇒ sıradaki kayıt 701 olmalı.
    const page = smT.listAllMessages(sidT, {
      limit: 1, afterSeq: 100, seqEpoch: first.seq_epoch,
    });
    assert.equal(page.messages.length, 1);
    assert.equal(messageSeqOf(page.messages[0]), 701, 'resume at the first surviving seq');
    assert.ok(page.next_after_seq > 100);
  });
}

// ===========================================================================
// 9. Aynı `_seq` iki mesajda oluşmaz (2000 + 700 kayıt üzerinde)
// ===========================================================================
check('9. no two records ever share a _seq value', () => {
  const seen = new Map();
  for (const [, list] of store.messagesByChat.entries()) {
    for (const m of list) {
      const seq = messageSeqOf(m);
      assert.ok(typeof seq === 'number', 'every stored record must carry a seq');
      assert.equal(seen.has(seq), false, `duplicate seq ${seq}`);
      seen.set(seq, m.wa_message_id);
    }
  }
  assert.ok(seen.size > 0);
});

// ===========================================================================
// 13. Birden fazla JID — jids filtresi + küresel imleç
// 14. Boş sohbet (filtreyle seçilen boş sohbet)
// ===========================================================================
{
  const smM = makeManager('multi');
  const sidM = (await smM.createSession('multi', { autoStart: false })).id;
  const storeM = smM._storeOf(smM.getSession(sidM));
  const A = chatKey(11);
  const B = chatKey(12);
  const C = chatKey(13); // hiç mesajı olmayan sohbet
  storeM.messagesByChat.set(C, []);
  const recsA2 = [];
  const recsB2 = [];
  for (let i = 0; i < 6; i += 1) {
    recsA2.push(ingest(storeM, A, record(i + 1, A, new Date(BASE + i * 60_000).toISOString())));
    recsB2.push(ingest(storeM, B, record(100 + i, B, new Date(BASE + (i + 6) * 60_000).toISOString())));
  }
  check('13a. without a jid filter both chats are paged by one global cursor', () => {
    const p1 = smM.listAllMessages(sidM, { limit: 4, afterSeq: 0 });
    const p2 = smM.listAllMessages(sidM, {
      limit: 20, afterSeq: p1.next_after_seq, seqEpoch: p1.seq_epoch,
    });
    const all = [...ids(p1), ...ids(p2)];
    assert.equal(all.length, 12);
    assert.equal(new Set(all).size, 12, 'cross-chat paging must not duplicate');
    assert.deepEqual(seqs(p1), [1, 2, 3, 4]);
  });
  check('13b. a jid filter narrows the set without breaking the cursor', () => {
    const onlyB = smM.listAllMessages(sidM, { limit: 100, afterSeq: 0, jids: [B] });
    assert.equal(onlyB.messages.length, 6);
    assert.ok(onlyB.messages.every((m) => m.conversation_id === B));
  });
  check('14. a filtered chat with no messages yields an empty, finished page', () => {
    const empty = smM.listAllMessages(sidM, { limit: 10, afterSeq: 0, jids: [C] });
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.reached_end, true);
    assert.equal(empty.next_after_seq, 0);
  });
}

// ===========================================================================
// 15. `perChatLimit` imleçle birlikte kayıt ELEMEZ (AŞAMA 4.15 düzeltmesi)
//     ve offset modunda eski kırpma davranışı AYNEN korunur.
// ===========================================================================
{
  const smP = makeManager('perchat');
  const sidP = (await smP.createSession('perchat', { autoStart: false })).id;
  const storeP = smP._storeOf(smP.getSession(sidP));
  const CHAT_P = chatKey(21);
  for (let i = 0; i < 300; i += 1) {
    ingest(storeP, CHAT_P, record(i + 1, CHAT_P, new Date(BASE + i * 1000).toISOString()));
  }
  check('15a. perChatLimit does NOT truncate a seq page (no silent skip)', () => {
    const page = smP.listAllMessages(sidP, { limit: 1000, afterSeq: 0, perChatLimit: 100 });
    assert.equal(page.pagination, 'seq');
    assert.equal(page.messages.length, 300, 'all 300 records must be reachable by cursor');
    assert.deepEqual(seqs(page).slice(0, 3), [1, 2, 3]);
  });
  check('15b. perChatLimit still truncates in offset mode (legacy behaviour intact)', () => {
    const page = smP.listAllMessages(sidP, { limit: 1000, offset: 0, perChatLimit: 100 });
    assert.equal(page.pagination, 'offset');
    assert.equal(page.messages.length, 100, 'offset callers keep the newest-N contract');
    assert.equal(messageSeqOf(page.messages[0]), 201);
  });
}

// ===========================================================================
// `_seq` API yüzeyine SIZMAZ (non-enumerable) + `since` hâlâ saygı görür
// ===========================================================================
check('S1. _seq never leaks into a serialised message payload', () => {
  const page = sm.listAllMessages(sid, { limit: 1, afterSeq: 0 });
  const json = JSON.parse(JSON.stringify(page.messages[0]));
  assert.equal(Object.prototype.hasOwnProperty.call(json, '_seq'), false);
  assert.equal(Object.keys(json).includes('_seq'), false);
  assert.ok(typeof page.messages[0]._seq === 'number', 'the property exists but is hidden');
});

check('S2. `since` is still honoured in seq mode (an explicit window stays explicit)', () => {
  const cutoff = Math.floor((BASE + 6 * 60_000) / 1000);
  const page = sm.listAllMessages(sid, { limit: 100, afterSeq: 0, since: cutoff });
  assert.equal(page.messages.length, 6, 'only records at/after the cutoff');
  assert.ok(seqs(page).every((s) => s >= 7));
});

// ===========================================================================
// Büyük veri: 5000 kayıt (tavan 2000) — tavan-içi küme TAM erişilebilir
// ===========================================================================
{
  const smL = makeManager('large');
  const sidL = (await smL.createSession('large', { autoStart: false })).id;
  const storeL = smL._storeOf(smL.getSession(sidL));
  const CHAT_L = chatKey(31);
  for (let i = 0; i < 5000; i += 1) {
    ingest(storeL, CHAT_L, record(i + 1, CHAT_L, new Date(BASE + i * 1000).toISOString()));
  }
  check('L1. 5000 ingests leave exactly MESSAGES_PER_CHAT_MAX records in RAM', () => {
    assert.equal(storeL.messagesByChat.get(CHAT_L).length, MESSAGES_PER_CHAT_MAX);
    assert.ok(ramCapacitySnapshot(storeL).evictions_total >= 3000,
      'the evictions must be counted, not silently dropped');
  });
  check('L2. a full 5000-record drain reaches every surviving record exactly once', () => {
    let cursor = 0;
    let epoch = null;
    const seen = [];
    const seenSeq = [];
    for (let page = 0; page < 100; page += 1) {
      const res = smL.listAllMessages(sidL, {
        limit: 500, afterSeq: cursor, seqEpoch: epoch,
      });
      assert.equal(res.pagination, 'seq');
      seen.push(...ids(res));
      seenSeq.push(...seqs(res));
      const next = res.next_after_seq;
      assert.ok(next >= cursor, 'the cursor must never move backwards');
      cursor = next;
      epoch = res.seq_epoch;
      if (res.reached_end) break;
    }
    assert.equal(seen.length, MESSAGES_PER_CHAT_MAX,
      `expected ${MESSAGES_PER_CHAT_MAX} reachable records, saw ${seen.length}`);
    assert.equal(new Set(seen).size, MESSAGES_PER_CHAT_MAX, 'no duplicates across 2000+ records');
    assert.equal(new Set(seenSeq).size, MESSAGES_PER_CHAT_MAX, 'no duplicate seq');
  });
  check('L3. 5000 records under a perChatLimit still yields the full surviving set', () => {
    const page = smL.listAllMessages(sidL, { limit: 5000, afterSeq: 0, perChatLimit: 2000 });
    assert.equal(page.messages.length, MESSAGES_PER_CHAT_MAX);
  });
}

// ===========================================================================
// Geriye uyumluluk: eski istemcilerin davranışı BİREBİR korunur
// ===========================================================================
{
  const smB = makeManager('compat');
  const sidB = (await smB.createSession('compat', { autoStart: false })).id;
  const storeB = smB._storeOf(smB.getSession(sidB));
  const CHAT_B = chatKey(41);
  for (let i = 0; i < 10; i += 1) {
    ingest(storeB, CHAT_B, record(i + 1, CHAT_B, new Date(BASE + i * 60_000).toISOString()));
  }
  check('B1. a client that sends no afterSeq gets the legacy offset contract', () => {
    const page = smB.listAllMessages(sidB, { limit: 4, offset: 0 });
    assert.equal(page.pagination, 'offset');
    assert.equal(page.messages.length, 4);
    assert.equal(page.offset, 0);
    assert.equal(page.seq_epoch, undefined, 'offset pages must not invent a seq contract');
  });
  check('B2. offset paging still walks the whole store for old clients', () => {
    const p1 = smB.listAllMessages(sidB, { limit: 4, offset: 0 });
    const p2 = smB.listAllMessages(sidB, { limit: 4, offset: 4 });
    const p3 = smB.listAllMessages(sidB, { limit: 4, offset: 8 });
    assert.deepEqual([...ids(p1), ...ids(p2), ...ids(p3)].length, 10);
    assert.equal(p3.reached_end, true);
  });
  check('B3. a since-only client is unaffected by the seq work', () => {
    const cutoff = Math.floor((BASE + 5 * 60_000) / 1000);
    const page = smB.listAllMessages(sidB, { limit: 100, offset: 0, since: cutoff });
    assert.equal(page.pagination, 'offset');
    assert.equal(page.messages.length, 5);
  });
  check('B4. afterSeq without a seqEpoch still serves the first page', () => {
    const page = smB.listAllMessages(sidB, { limit: 3, afterSeq: 0 });
    assert.equal(page.pagination, 'seq');
    assert.equal(page.epoch_reset, false);
    assert.equal(page.messages.length, 3);
  });
  check('B5. a perChatLimit-only client keeps the newest-N contract', () => {
    const page = smB.listAllMessages(sidB, { limit: 100, offset: 0, perChatLimit: 3 });
    assert.equal(page.messages.length, 3);
    assert.deepEqual(seqs(page), [8, 9, 10]);
  });
}

// ===========================================================================
// Yarış: sayfalama SÜRERKEN ekleme + trim (üretimde eviction tam bunu yapar)
// ===========================================================================
{
  const smR = makeManager('race');
  const sidR = (await smR.createSession('race', { autoStart: false })).id;
  const storeR = smR._storeOf(smR.getSession(sidR));
  const CHAT_R = chatKey(51);
  for (let i = 0; i < 1500; i += 1) {
    ingest(storeR, CHAT_R, record(i + 1, CHAT_R, new Date(BASE + i * 1000).toISOString()));
  }
  const beforeIds = ids(smR.listAllMessages(sidR, { limit: 5000, afterSeq: 0 }));
  assert.equal(beforeIds.length, 1500);

  check('R1. concurrent ingest+trim during a drain never duplicates or rewinds', () => {
    let cursor = 0;
    let epoch = null;
    const seen = [];
    for (let page = 0; page < 200; page += 1) {
      const res = smR.listAllMessages(sidR, {
        limit: 100, afterSeq: cursor, seqEpoch: epoch,
      });
      seen.push(...ids(res));
      assert.ok(res.next_after_seq >= cursor, 'cursor must never rewind');
      cursor = res.next_after_seq;
      epoch = res.seq_epoch;
      // Sayfa ARASINDA: üretimde olan şey — yeni mesaj gelir, tavan trim eder.
      for (let k = 0; k < 20; k += 1) {
        ingest(storeR, CHAT_R, record(9000 + page * 20 + k, CHAT_R,
          new Date(BASE + (9000 + page * 20 + k) * 1000).toISOString()));
      }
      if (res.reached_end && page > 0) break;
    }
    assert.equal(new Set(seen).size, seen.length, 'no duplicate records across the race');
    // Draining başlamadan önce RAM'de olan ve trim ile DÜŞMEMİŞ her kayıt
    // görünmüş olmalı: imleç bir değer olduğu için ekleme/trim onu kaydıramaz.
    const survivors = new Set(
      storeR.messagesByChat.get(CHAT_R).map((m) => m.wa_message_id)
    );
    const missed = beforeIds.filter((id) => survivors.has(id) && !seen.includes(id));
    assert.deepEqual(missed, [], `records lost to the ingest/trim race: ${missed.length}`);
  });
}

// ===========================================================================
// Tüketici-türetilmiş anahtar paritesi BURADA DEĞİL.
//
// Bu dosya gateway deposunun kendi test paketinde çalışır; kardeş backend
// ağacına bağlanmak, gateway-only bir checkout'ta (veya backend'i eski olan
// bir ağaçta) testi sessizce anlamsız kılardı. Parite denetimi, tüketicinin
// GERÇEK kaynağından türetilerek AŞAMA 4.15 denetiminde ayrıca çalıştırıldı
// ve rapora yazıldı (`docs/audits/ASAMA-4.15-gateway-front-trim-remediation.md`).
// ===========================================================================

console.log(`\nBulk seq pagination guarantees: PASS (${passed} checks)`);
