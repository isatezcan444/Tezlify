/**
 * Faz 3.6 — on-demand geçmiş (PDO) teşhis enstrümantasyonu.
 *
 * Korunan sözleşme: bir PDO isteğinin sonucu artık AYRIŞTIRILABİLİR olmalı.
 * "İstek gönderildi mi", "chunk geldi mi", "chunk bekleyen istekle eşleşti mi"
 * soruları tek bir `request_id` ile yanıtlanır — ve loglar telefon numarası
 * gibi kiracı/PII verisi taşımaz.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';
import { resolveHistoryWaitersForChunk, noteHistoryChunk } from '../src/socket/socket-events.js';
import { jidKind } from '../src/utils/whatsapp-identity.js';
import { logger as gwLogger } from '../src/utils/baileys-logger.js';

console.log('[test-history-diagnostics] starting tests...');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-diag-'));
try {
  // --- 1. jidKind: adresleme türü, numara sızdırmadan ---------------------
  assert.equal(jidKind('905551112233@s.whatsapp.net'), 'PN');
  assert.equal(jidKind('144130562887745@lid'), 'LID');
  assert.equal(jidKind('905413749073-1589570212@g.us'), 'GROUP');
  assert.equal(jidKind('status@broadcast'), 'OTHER');
  assert.equal(jidKind(null), 'OTHER');
  console.log('  ok: jidKind PN/LID/GROUP/OTHER');

  // --- 2. Yönetici örneği ------------------------------------------------
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
  const sid = (await sm.createSession('diag-test', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';

  const store = sm._storeOf(session);
  const chatJid = '905551112233@s.whatsapp.net';
  store.messagesByChat.set(chatJid, [
    { id: 1000, wa_message_id: 'anchor_oldest', timestamp_s: 1000, direction: 'INBOUND' },
    { id: 2000, wa_message_id: 'anchor_newer', timestamp_s: 2000, direction: 'INBOUND' },
  ]);

  // --- 3. SOCKET_UNAVAILABLE ayrı bir sonuçtur ---------------------------
  session.sock = null;
  const noSock = await sm.requestOlderHistory(sid, chatJid, {
    count: 10,
    timeoutMs: 50,
    requestId: 'req-nosock',
  });
  assert.equal(noSock.status, 'SOCKET_UNAVAILABLE');
  console.log('  ok: socket yokken SOCKET_UNAVAILABLE');

  // --- 4. PDO gönderilir, waiter request_id taşır, timeout döner ---------
  const calls = [];
  session.sock = {
    fetchMessageHistory: async (count, key, ts) => {
      calls.push({ count, key, ts });
      return 'pdo-msg-1';
    },
    ev: { on: () => {}, emit: () => {} },
  };

  const pending = sm.requestOlderHistory(sid, chatJid, {
    count: 10,
    timeoutMs: 60,
    requestId: 'req-timeout-1',
  });
  assert.equal(calls.length, 1, 'PDO gönderilmeliydi');
  assert.equal(calls[0].key.remoteJid, chatJid);
  assert.equal(calls[0].key.id, 'anchor_oldest');

  // Waiter kaydı korelasyon kimliğini taşımalı (chunk eşleşmesi için).
  const waiterEntry = [...sm._pendingHistoryWaiters.entries()].find(
    ([, w]) => w.key === chatJid
  );
  assert.ok(waiterEntry, 'bekleyen waiter kaydı olmalı');
  assert.equal(waiterEntry[1].requestId, 'req-timeout-1');

  const timedOut = await pending;
  assert.equal(timedOut.status, 'TIMEOUT');
  assert.equal(timedOut.count, 0);
  // Sınıflandırma: PDO gitti, hiç chunk gelmedi → NO_CHUNK.
  assert.equal(timedOut.failure_class, 'NO_CHUNK');
  console.log('  ok: PDO gönderildi, waiter request_id taşıdı, TIMEOUT/NO_CHUNK döndü');

  // --- 4b. TIMEOUT logu PDO'nun gerçekten gittiğini söylemeli -------------
  // REGRESYON: `pdoSent` bir zamanlar promise executor'ının içinde tekrar
  // `let` ile tanımlanmıştı ve dıştaki değişkeni GÖLGELİYORDU. Sonuç: PDO
  // gitmiş olsa bile timeout logu `pdo_sent: false` yazıyordu — yani
  // teşhisin çekirdeği sessizce yalan söylüyordu.
  const captureLogs = async (fn) => {
    const capture = [];
    const saved = gwLogger.info;
    gwLogger.info = (payload, msg) => {
      capture.push({ payload, msg });
    };
    try {
      const value = await fn();
      return { value, capture };
    } finally {
      gwLogger.info = saved;
    }
  };

  {
    const { capture } = await captureLogs(() =>
      sm.requestOlderHistory(sid, chatJid, {
        count: 10,
        timeoutMs: 60,
        requestId: 'req-pdo-sent-flag',
      })
    );
    const timeoutLog = capture.find(
      (l) => l.payload?.outcome === 'TIMEOUT' && l.payload?.request_id === 'req-pdo-sent-flag'
    );
    assert.ok(timeoutLog, 'TIMEOUT logu yazılmalı');
    assert.equal(
      timeoutLog.payload.pdo_sent,
      true,
      'PDO gönderildiyse log pdo_sent:true demeli (gölgeleme regresyonu)'
    );
    assert.equal(timeoutLog.payload.failure_class, 'NO_CHUNK');
    assert.equal(timeoutLog.payload.chunks_during_wait, 0);
  }
  console.log('  ok: TIMEOUT logu pdo_sent:true + failure_class:NO_CHUNK taşıyor');

  // --- 4c. WAITER_MISMATCH: chunk geldi ama BAŞKA sohbet için -------------
  {
    const { value: res, capture } = await captureLogs(async () => {
      const p = sm.requestOlderHistory(sid, chatJid, {
        count: 10,
        timeoutMs: 80,
        requestId: 'req-waiter-mismatch',
      });
      // Bekleme penceresinde bir chunk gelir (başka bir sohbeti adlandırır).
      noteHistoryChunk(session);
      return p;
    });
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(
      res.failure_class,
      'WAITER_MISMATCH',
      'chunk geldi ama eşleşmedi → WAITER_MISMATCH'
    );
    const log = capture.find(
      (l) => l.payload?.request_id === 'req-waiter-mismatch' && l.payload?.outcome === 'TIMEOUT'
    );
    assert.ok(log);
    assert.equal(log.payload.chunks_during_wait, 1);
    assert.equal(log.payload.chunk_received, false);
  }
  console.log('  ok: chunk geldi/eşleşmedi → WAITER_MISMATCH (NO_CHUNK değil)');

  // --- 4d. PDO_NOT_SENT: gönderim hiç tamamlanmadı ------------------------
  {
    const prevSock = session.sock;
    session.sock = {
      // Söz asla çözülmez: `.then` çalışmaz, `pdoSent` false kalır.
      fetchMessageHistory: () => new Promise(() => {}),
      ev: { on: () => {}, emit: () => {} },
    };
    try {
      const res = await sm.requestOlderHistory(sid, chatJid, {
        count: 10,
        timeoutMs: 60,
        requestId: 'req-pdo-not-sent',
      });
      assert.equal(res.status, 'TIMEOUT');
      assert.equal(res.failure_class, 'PDO_NOT_SENT');
    } finally {
      session.sock = prevSock;
    }
  }
  console.log('  ok: gönderim tamamlanmadı → PDO_NOT_SENT');

  // --- 5. Chunk GELİR ve waiter ile EŞLEŞİR ------------------------------
  const logs = [];
  const fakeLogger = {
    info: (payload, msg) => logs.push({ payload, msg }),
    debug: () => {},
    warn: () => {},
  };

  const p2 = sm.requestOlderHistory(sid, chatJid, {
    count: 10,
    timeoutMs: 5000,
    requestId: 'req-match-1',
  });
  // Chunk'ta daha eski bir mesaj geldi.
  store.messagesByChat.get(chatJid).unshift({
    id: 500,
    wa_message_id: 'from_chunk',
    timestamp_s: 500,
    direction: 'INBOUND',
  });

  const scan = resolveHistoryWaitersForChunk({
    pendingHistoryWaiters: sm._pendingHistoryWaiters,
    inFlightHistoryFetches: sm._inFlightHistoryFetches,
    sessionId: session.id,
    messagesByChat: store.messagesByChat,
    touchedChatKeys: new Set([chatJid]),
    logger: fakeLogger,
    chunkInfo: { syncType: 'ON_DEMAND', messageCount: 1, peerDataRequestSessionId: 'pds-1' },
  });

  assert.equal(scan.resolved, 1, 'waiter çözülmeliydi');
  const matched = logs.find((l) => l.payload?.outcome === 'CHUNK_MATCHED');
  assert.ok(matched, 'CHUNK_MATCHED logu yazılmalı');
  assert.equal(matched.payload.request_id, 'req-match-1');
  assert.equal(matched.payload.chat_jid_kind, 'PN');
  assert.equal(matched.payload.chunk_sync_type, 'ON_DEMAND');
  assert.equal(matched.payload.peer_data_request_session_id, 'pds-1');
  // PII: logda ham telefon numarası OLMAMALI.
  assert.equal(JSON.stringify(matched.payload).includes('905551112233'), false);

  const matchedResult = await p2;
  assert.equal(matchedResult.status, 'OK');
  assert.ok(matchedResult.messages.some((m) => m.wa_message_id === 'from_chunk'));
  console.log('  ok: chunk eşleşti, OK döndü, logda PII yok');

  // --- 6. BAŞKA sohbetin chunk'ı bu waiter'ı ÇÖZMEZ ----------------------
  const otherJid = '905559998877@s.whatsapp.net';
  const p3 = sm.requestOlderHistory(sid, chatJid, {
    count: 10,
    timeoutMs: 60,
    requestId: 'req-other-chat',
  });
  const scan2 = resolveHistoryWaitersForChunk({
    pendingHistoryWaiters: sm._pendingHistoryWaiters,
    inFlightHistoryFetches: sm._inFlightHistoryFetches,
    sessionId: session.id,
    messagesByChat: store.messagesByChat,
    touchedChatKeys: new Set([otherJid]),
    logger: fakeLogger,
    chunkInfo: { syncType: 'ON_DEMAND', messageCount: 3 },
  });
  assert.equal(scan2.resolved, 0, 'başka sohbetin chunk\'ı çözmemeli');
  assert.equal(scan2.waiting, 1, 'waiter hâlâ beklemede olmalı');
  const otherRes = await p3;
  assert.equal(otherRes.status, 'TIMEOUT');
  console.log('  ok: başka sohbetin chunk\'ı waiter\'ı çözmedi');

  // --- 7. scan sırasında hiç waiter yoksa patlamaz -----------------------
  const scan3 = resolveHistoryWaitersForChunk({
    pendingHistoryWaiters: sm._pendingHistoryWaiters,
    inFlightHistoryFetches: sm._inFlightHistoryFetches,
    sessionId: session.id,
    messagesByChat: store.messagesByChat,
    touchedChatKeys: new Set([chatJid]),
  });
  assert.equal(scan3.resolved, 0);
  console.log('  ok: waiter yokken scan güvenli');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('[test-history-diagnostics] PASS');
