/**
 * AŞAMA 5.3.7 — 4.17 GERÇEK INGESTION YAZMA SIRASI (davranışsal test).
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * `test-tz428-initial-sync-front-trim.mjs` gerçek `stampMessageSeq` /
 * `trimChatMessages` / `boundMessagesByChat` fonksiyonlarını import ediyor,
 * AMA çağrı sırasını kendi `ingest()` yardımcı fonksiyonunda TEKRARLIYOR.
 * Bu yüzden üretimdeki sıra bozulsa bile o test yeşil kalır: iki ayna
 * birbirinin paritesini tutar, ikisinde de eksik olan şeyi göremez.
 *
 * Bu test sırayı KOPYALAMAZ. Gerçek üretim metodunu (`_ingestUpsertMessage`)
 * çağırır ve sırayı onun **davranışından** okur.
 *
 * SIRAYI NEDEN DAVRANIŞSAL OKUYABİLİYORUZ
 * --------------------------------------
 * Üç fonksiyon `store` üzerinde AYRIK izler bırakır:
 *
 *   stampMessageSeq   → `store._messageSeq` (get + set)      [nextMessageSeq]
 *   trimChatMessages  → `store.evictionsTotal` (set)         [recordEviction]
 *                       (yalnız liste tavandan uzunken çalışır)
 *   boundMessagesByChat → `messagesByChat.delete(currentKey)` + `set`
 *                       (sohbeti Map sonuna taşır)
 *
 * Store ve Map birer Proxy ile sarılır; iz sırası = gerçek çağrı sırası.
 * Beklenen: SEQ → TRIM → BOUND.
 *
 * Sıra bozulursa iz değişir:
 *   trim → stamp → bound  ⇒  TRIM → SEQ  → BOUND
 *   stamp → bound → trim  ⇒  SEQ  → BOUND → TRIM
 *   bound → stamp → trim  ⇒  BOUND → SEQ  → TRIM
 *
 * MUTASYON KANITI
 * ---------------
 * Aynı dedektör, `src/` ağacının GEÇİCİ bir kopyası üzerinde iki yanlış
 * sırayla çalıştırılır ve dedektörün GERÇEKTEN FAIL verdiği gösterilir.
 * Üretim dosyasına dokunulmaz (bkz. §"mutation" bölümü).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createSessionManager } from '../src/session-manager.js';
import { MESSAGES_PER_CHAT_MAX } from '../src/messages/message-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..', 'src');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const SILENT = { warn() {}, info() {}, debug() {}, error() {}, fatal() {}, trace() {} };

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

/**
 * Gerçek `_ingestUpsertMessage`'ı çalıştırır ve store üzerindeki izi döner.
 *
 * @param {Function} factory        createSessionManager (üretim veya mutasyon kopyası)
 * @param {number}   perChatCap     o kopyanın MESSAGES_PER_CHAT_MAX değeri
 * @param {string}   tag            geçici dizin etiketi
 * @param {number}   seedCount      sohbeti önceden doldurulacak kayıt sayısı
 */
async function runTrace(factory, perChatCap, tag, seedCount) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `wa-${tag}-`));
  const sm = factory({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
  const sid = (await sm.createSession(tag, { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const sock = { ev, async readMessages() { return true; } };
  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);

  const PN = '905551119999@s.whatsapp.net';
  const raw = sm._storeOf(session);
  raw.logger = SILENT;

  // Sohbeti tavana kadar doldur: `trimChatMessages` yalnız liste tavanı
  // AŞTIĞINDA `recordEviction` çağırır. Ön dolgu, izi görünür kılmak için.
  if (!raw.messagesByChat.has(PN)) raw.messagesByChat.set(PN, []);
  const arr = raw.messagesByChat.get(PN);
  const seedBase = Math.floor(Date.now() / 1000) - 10_000;
  for (let i = 0; i < seedCount; i += 1) {
    arr.push({
      id: seedBase * 1000 + i,
      conversation_id: PN,
      wa_message_id: `seed-${tag}-${i}`,
      body: `s${i}`,
      direction: 'INBOUND',
      created_at: new Date((seedBase + i) * 1000).toISOString(),
    });
  }

  // --- iz toplama ---------------------------------------------------------
  const trace = [];
  const rawMap = raw.messagesByChat;
  const mapProxy = new Proxy(rawMap, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return function traced(...args) {
        // `boundMessagesByChat` sohbeti Map sonuna taşır: delete + set.
        if (prop === 'delete' || prop === 'set') trace.push('BOUND');
        return value.apply(target, args);
      };
    },
  });
  const storeProxy = new Proxy(raw, {
    get(target, prop) {
      if (prop === 'messagesByChat') return mapProxy;
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      if (prop === '_messageSeq') trace.push('SEQ');
      else if (prop === 'evictionsTotal') trace.push('TRIM');
      return Reflect.set(target, prop, value);
    },
  });
  sm._storeOf = () => storeProxy;

  const msg = {
    key: { remoteJid: PN, fromMe: false, id: `WAMID-${tag}` },
    message: { conversation: 'sira testi' },
    messageTimestamp: seedBase + seedCount + 1,
  };
  const record = await sm._ingestUpsertMessage(msg, sock, sid, { upsertType: 'notify' });

  // delete+set ardışık gelir; tek faz olarak say.
  const phases = trace.filter((v, i) => i === 0 || trace[i - 1] !== v);
  const stored = raw.messagesByChat.get(PN);

  await rm(dir, { recursive: true, force: true });
  return { phases, record, stored, perChatCap };
}

// ---------------------------------------------------------------------------
// 1. ÜRETİM: sohbet tavanda → üç fazın hepsi görünür
// ---------------------------------------------------------------------------
console.log('[test-ingest-write-order] Üretim kodu — sohbet per-chat tavanında');

const atCap = await runTrace(
  createSessionManager,
  MESSAGES_PER_CHAT_MAX,
  'prod-at-cap',
  MESSAGES_PER_CHAT_MAX,
);

check('gerçek _ingestUpsertMessage SEQ → TRIM → BOUND sırasıyla yazar', () => {
  assert.deepEqual(
    atCap.phases,
    ['SEQ', 'TRIM', 'BOUND'],
    `beklenen sıra SEQ→TRIM→BOUND, ölçülen: ${JSON.stringify(atCap.phases)}`,
  );
});

check('kayıt gerçekten seq damgası aldı (_seq pozitif tamsayı)', () => {
  assert.equal(typeof atCap.record?._seq, 'number');
  assert.ok(atCap.record._seq > 0, `_seq=${atCap.record?._seq}`);
});

check('kayıt dizide ve _seq taşıyarak duruyor', () => {
  const found = atCap.stored.find((m) => m.wa_message_id === 'WAMID-prod-at-cap');
  assert.ok(found, 'yeni kayıt store dizisinde bulunamadı');
  assert.equal(found._seq, atCap.record._seq);
});

check('trim uygulandı: dizi per-chat tavanını aşmıyor', () => {
  assert.equal(atCap.stored.length, atCap.perChatCap);
});

check('en yeni kayıt dizinin SONUNDA (trim baştan atar)', () => {
  assert.equal(atCap.stored[atCap.stored.length - 1].wa_message_id, 'WAMID-prod-at-cap');
});

// ---------------------------------------------------------------------------
// 2. ÜRETİM: sohbet tavanın altında → trim tetiklenmez, iz SEQ → BOUND
//    (iz anahtarının sabit olmadığını, gerçekten duruma bağlı olduğunu kanıtlar)
// ---------------------------------------------------------------------------
console.log('[test-ingest-write-order] Üretim kodu — sohbet tavanın altında');

const belowCap = await runTrace(
  createSessionManager,
  MESSAGES_PER_CHAT_MAX,
  'prod-below-cap',
  5,
);

check('tavan altında trim tetiklenmez: SEQ → BOUND', () => {
  assert.deepEqual(
    belowCap.phases,
    ['SEQ', 'BOUND'],
    `ölçülen: ${JSON.stringify(belowCap.phases)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. MUTASYON: geçici kopyada sıra bozulur → dedektör FAIL vermeli
// ---------------------------------------------------------------------------
console.log('[test-ingest-write-order] Mutasyon — geçici src kopyası (üretim dosyasına dokunulmaz)');

const ORIGINAL_BLOCK = [
  '      chatMsgs.push(stampMessageSeq(store, record));',
  '      trimChatMessages(store, key, chatMsgs);',
  '      boundMessagesByChat(store, key);',
].join('\n');

const MUTATIONS = {
  'trim → stamp → bound': [
    '      chatMsgs.push(record);',
    '      trimChatMessages(store, key, chatMsgs);',
    '      stampMessageSeq(store, record);',
    '      boundMessagesByChat(store, key);',
  ].join('\n'),
  'stamp → bound → trim': [
    '      chatMsgs.push(stampMessageSeq(store, record));',
    '      boundMessagesByChat(store, key);',
    '      trimChatMessages(store, key, chatMsgs);',
  ].join('\n'),
};

const mutationRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-mutation-'));
try {
  const srcText = await readFile(path.join(SRC_DIR, 'session-manager.js'), 'utf8');
  check('mutasyon hedefi üretimde tam olarak bir kez bulunuyor', () => {
    const occurrences = srcText.split(ORIGINAL_BLOCK).length - 1;
    assert.equal(occurrences, 1, `blok ${occurrences} kez bulundu (1 bekleniyordu)`);
  });

  // Bağımlılıklar geçici ağaçtan çözülebilsin diye node_modules köprüsü.
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(mutationRoot, 'node_modules'), 'dir');

  for (const [label, mutatedBlock] of Object.entries(MUTATIONS)) {
    const variantDir = path.join(mutationRoot, label.replace(/\W+/g, '_'));
    await cp(SRC_DIR, path.join(variantDir, 'src'), { recursive: true });
    const target = path.join(variantDir, 'src', 'session-manager.js');
    const text = await readFile(target, 'utf8');
    await writeFile(target, text.replace(ORIGINAL_BLOCK, mutatedBlock), 'utf8');

    const mod = await import(pathToFileURL(path.join(variantDir, 'src', 'session-manager.js')).href);
    const storeMod = await import(
      pathToFileURL(path.join(variantDir, 'src', 'messages', 'message-store.js')).href
    );

    let observed = null;
    let runError = null;
    try {
      observed = await runTrace(
        mod.createSessionManager,
        storeMod.MESSAGES_PER_CHAT_MAX,
        `mut-${label.replace(/\W+/g, '_')}`,
        storeMod.MESSAGES_PER_CHAT_MAX,
      );
    } catch (err) {
      runError = err;
    }

    check(`mutasyon "${label}" dedektör tarafından YAKALANIYOR`, () => {
      assert.equal(runError, null, `mutasyon koşusu hata verdi: ${runError?.message}`);
      assert.notDeepEqual(
        observed.phases,
        ['SEQ', 'TRIM', 'BOUND'],
        `mutasyon yakalanmadı — iz hâlâ doğru sırayı gösteriyor: ${JSON.stringify(observed.phases)}`,
      );
    });

    console.log(`        gözlenen iz: ${JSON.stringify(observed?.phases ?? null)}`);
  }
} finally {
  await rm(mutationRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`[test-ingest-write-order] ${failures} kontrol BAŞARISIZ`);
  process.exit(1);
}
console.log('[test-ingest-write-order] Tüm kontroller geçti');
