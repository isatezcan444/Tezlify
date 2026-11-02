// AŞAMA 4.28 — Initial sync front-trim kanıtı (GERÇEK gateway kodu).
//
// AMAÇ
// ----
// `sync.py` initial sync'i `offset` + `perChatLimit=50` ile sayfalar. Gateway
// `perChatLimit` kırpmasını HER İSTEKTE yeniden uygular (`slice(-N)`), sonra
// id'ye göre sıralayıp `[offset, offset+limit)` dilimini döner. Sayfalar
// arasında bir sohbete yeni mesaj gelirse o sohbetin penceresi ilerler, global
// dizi SOLA kayar ve `offset` bir kaydı ATLAR.
//
// Bu dosya iki stratejiyi AYNI gerçek `listAllMessages` üzerinde karşılaştırır:
//   (A) MEVCUT  : tek jids=null, offset 0..total, perChatLimit=50
//   (B) ÖNERİLEN: jids'i `floor(limit/perChatLimit)` büyüklüğünde parçala;
//                 her istek TEK SAYFA (total <= limit) → offset kayması yok.
//
// DEĞİŞMEZ (test edilen): "son 50" penceresi okuma anında hesaplanır. Bu yüzden
// bir sohbetin parçası okunduktan SONRA gelen mesaj meşru biçimde kapsam dışıdır.
// İhlal = pencerede olan ve HİÇ okunmamış bir kaydın imleç yüzünden atlanması.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';
import {
  stampMessageSeq,
  trimChatMessages,
  boundMessagesByChat,
} from '../src/messages/message-store.js';

const SILENT = { warn() {}, info() {}, debug() {}, error() {} };
const silence = (store) => { store.logger = SILENT; return store; };

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
const chatKey = (n) => `9055522${String(n).padStart(5, '0')}@s.whatsapp.net`;

function record(id, key) {
  return {
    conversation_id: key,
    wa_message_id: `wamid_i_${key.slice(0, 10)}_${id}`,
    body: `m${id}`,
    created_at: new Date(id).toISOString(),
    id,
    direction: 'INBOUND',
  };
}

function ingest(store, key, rec) {
  if (!store.messagesByChat.has(key)) store.messagesByChat.set(key, []);
  const list = store.messagesByChat.get(key);
  list.push(stampMessageSeq(store, rec));
  trimChatMessages(store, key, list);
  boundMessagesByChat(store, key);
  return rec;
}

function makeManager(tag) {
  const manager = createSessionManager({
    sessionsDir: path.join(os.tmpdir(), `tz428-${tag}-sessions`),
    mediaDir: path.join(os.tmpdir(), `tz428-${tag}-media`),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
  const originalStoreOf = manager._storeOf.bind(manager);
  manager._storeOf = (session) => silence(originalStoreOf(session));
  return manager;
}

// Üretimle AYNI ORAN: page_size=100, perChatLimit=50 → parça=2.
// (Üretimde 1000/50 = 20 sohbet; yapı birebir, yalnız ölçek küçük.)
const PAGE_SIZE = 100;
const PER_CHAT = 50;
const CHUNK = Math.floor(PAGE_SIZE / PER_CHAT);
const CHATS = 5;
const PER_CHAT_TOTAL = 60; // 60 yazılır; okuma anında son 50'ye kırpılır
const LATE_ID = BASE + 999999;

function seed(sm, sid) {
  const store = sm._storeOf(sm.getSession(sid));
  const keys = Array.from({ length: CHATS }, (_, c) => chatKey(c));
  // Id'ler sohbetler arasında İÇ İÇE: id = BASE + (i*10 + c).
  for (let i = 0; i < PER_CHAT_TOTAL; i += 1) {
    for (let c = 0; c < CHATS; c += 1) {
      ingest(store, keys[c], record(BASE + i * 10 + c, keys[c]));
    }
  }
  return { store, keys };
}

// Okuma anındaki "son N" penceresi (gateway'in uyguladığı kuralın aynısı).
function windowOf(store, perChat) {
  const out = new Set();
  for (const list of store.messagesByChat.values()) {
    const sorted = [...list].sort((a, b) => (a.id || 0) - (b.id || 0));
    for (const m of sorted.slice(-perChat)) out.add(m.wa_message_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. MEVCUT STRATEJİ — offset sayfalama, sayfalar arasında yeni mesaj
// ---------------------------------------------------------------------------
function runOffsetStrategy(sm, sid, keys) {
  const collected = [];
  let offset = 0;
  let pages = 0;
  let first = true;
  for (;;) {
    const page = sm.listAllMessages(sid, {
      limit: PAGE_SIZE,
      offset,
      perChatLimit: PER_CHAT,
    });
    pages += 1;
    const msgs = page.messages;
    if (!msgs.length) break;
    collected.push(...msgs.map((m) => m.wa_message_id));
    if (first) {
      first = false;
      // Sayfa 1 ile 2 arasında canlı trafik: chat0 penceresi ilerler,
      // en eski kaydı düşer, global dizi SOLA kayar.
      ingest(sm._storeOf(sm.getSession(sid)), keys[0], record(LATE_ID, keys[0]));
    }
    offset += msgs.length;
    if (offset >= page.total) break;
    if (pages > 50) break;
  }
  return { collected, pages };
}

// ---------------------------------------------------------------------------
// B. ÖNERİLEN STRATEJİ — jids parçalama; her istek tek sayfa
// ---------------------------------------------------------------------------
function runChunkedStrategy(sm, sid, keys) {
  const collected = [];
  let pages = 0;
  let first = true;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const jids = keys.slice(i, i + CHUNK);
    const page = sm.listAllMessages(sid, {
      limit: PAGE_SIZE,
      offset: 0,
      perChatLimit: PER_CHAT,
      jids,
    });
    pages += 1;
    const msgs = page.messages;
    assert.ok(
      msgs.length >= page.total,
      `parça TEK sayfada bitmeliydi: len=${msgs.length} total=${page.total}`,
    );
    collected.push(...msgs.map((m) => m.wa_message_id));
    if (first) {
      first = false;
      ingest(sm._storeOf(sm.getSession(sid)), keys[0], record(LATE_ID, keys[0]));
    }
  }
  return { collected, pages };
}

const lateId = (keys) => record(LATE_ID, keys[0]).wa_message_id;

// ===========================================================================
// 1. A stratejisi: front-trim sayfa sınırında kayıt ATLAR
// ===========================================================================
{
  const sm = makeManager('offset');
  const sid = (await sm.createSession('tz428-offset', { autoStart: false })).id;
  const { store, keys } = seed(sm, sid);

  assert.equal(
    [...store.messagesByChat.values()].reduce((n, l) => n + l.length, 0),
    CHATS * PER_CHAT_TOTAL,
    'depo 5x60 olmalı',
  );

  const { collected, pages } = runOffsetStrategy(sm, sid, keys);
  const got = new Set(collected);
  const win = windowOf(store, PER_CHAT);
  const late = lateId(keys);
  // Pencerede olup HİÇ okunmayanlar; geç gelen mesaj meşru istisna.
  const missed = [...win].filter((id) => !got.has(id));
  const genuineSkips = missed.filter((id) => id !== late);

  console.log(
    `    [A offset] pages=${pages} delivered=${got.size} window=${win.size} missed=${missed.length} genuine=${genuineSkips.length}`,
  );

  check('A. offset stratejisi penceredeki bir kaydı sessizce atlar', () => {
    assert.ok(
      genuineSkips.length >= 1,
      `offset kayıt atlamalıydı (delivered=${got.size}, window=${win.size})`,
    );
  });

  check('A. atlanan kayıt depoda HÂLÂ duruyor (silme değil, atlama)', () => {
    for (const id of genuineSkips) {
      const present = [...store.messagesByChat.values()].some((l) =>
        l.some((m) => m.wa_message_id === id),
      );
      assert.ok(present, 'atlanan kayıt depoda bulunmalı');
    }
  });
}

// ===========================================================================
// 2. B stratejisi: parçalı tek-sayfa — HİÇ kayıt atlamaz
// ===========================================================================
{
  const sm = makeManager('chunked');
  const sid = (await sm.createSession('tz428-chunked', { autoStart: false })).id;
  const { store, keys } = seed(sm, sid);

  const { collected, pages } = runChunkedStrategy(sm, sid, keys);
  const got = new Set(collected);
  const win = windowOf(store, PER_CHAT);
  const late = lateId(keys);
  const missed = [...win].filter((id) => !got.has(id));
  const genuineSkips = missed.filter((id) => id !== late);

  console.log(
    `    [B chunked] pages=${pages} delivered=${got.size} window=${win.size} missed=${missed.length} genuine=${genuineSkips.length}`,
  );

  check('B. parçalı strateji hiçbir penceredeki kaydı atlamaz', () => {
    assert.deepEqual(
      genuineSkips,
      [],
      `atlanan kayıt olmamalı, missed=${genuineSkips.length}`,
    );
  });

  check('B. tek "kayıp" yalnızca geç gelen mesajdır (meşru snapshot davranışı)', () => {
    assert.deepEqual(missed, [late], 'tek eksik geç gelen mesaj olmalı');
  });

  check('B. sohbet başına 50 sınırı KORUNUR', () => {
    assert.equal(got.size, CHATS * PER_CHAT, 'her sohbetten 50 kayıt gelmeli');
  });
}

// ===========================================================================
// 3. İstek sayısı: parçalama latency REGRESYONU üretmez
// ===========================================================================
{
  const smA = makeManager('count-a');
  const sidA = (await smA.createSession('tz428-count-a', { autoStart: false })).id;
  const a = seed(smA, sidA);
  const aPages = runOffsetStrategy(smA, sidA, a.keys).pages;

  const smB = makeManager('count-b');
  const sidB = (await smB.createSession('tz428-count-b', { autoStart: false })).id;
  const b = seed(smB, sidB);
  const bPages = runChunkedStrategy(smB, sidB, b.keys).pages;

  console.log(`    [C istek] offset_pages=${aPages} chunked_pages=${bPages}`);
  check('C. parçalı strateji istek sayısını ARTIRMAZ', () => {
    assert.ok(
      bPages <= aPages,
      `parçalı ${bPages} istek, offset ${aPages} istek — regresyon`,
    );
  });
}

// ===========================================================================
// 4. Boş sohbet / kısmi sayfa dayanıklılığı
// ===========================================================================
{
  const sm = makeManager('edge');
  const sid = (await sm.createSession('tz428-edge', { autoStart: false })).id;
  const store = sm._storeOf(sm.getSession(sid));
  const emptyKey = chatKey(90);
  const shortKey = chatKey(91);
  ingest(store, shortKey, record(BASE, shortKey)); // tek mesajlı sohbet
  // emptyKey hiç yazılmadı → boş sohbet

  check('D. boş sohbet parçayı bozmaz, kısa sohbet eksik dönmez', () => {
    const page = sm.listAllMessages(sid, {
      limit: PAGE_SIZE,
      offset: 0,
      perChatLimit: PER_CHAT,
      jids: [emptyKey, shortKey],
    });
    assert.equal(page.messages.length, 1);
    assert.equal(page.total, 1);
    assert.ok(page.messages.length >= page.total, 'tek sayfa');
  });
}

console.log(`\nInitial sync front-trim proof: PASS (${passed} checks)`);
