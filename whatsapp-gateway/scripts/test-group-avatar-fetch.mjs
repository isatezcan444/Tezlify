// Grup avatar kurtarma regresyon testi.
//
// Sorun (uretim, 2026-09-26): bir grup YALNIZCA konusundan biliniyorsa
// (`_ensureGroupSubjects` -> `seedGroupChat`) sohbet `avatar_url: null` ile
// yaratiliyordu ve o gruba ait mesaj olmadigi icin `_touchChat` hic kosmuyordu.
// Tek seferlik arka plan avatar taramasi (`_scheduleBackgroundAvatarFetch`) ise
// history-sync %100'unde, yani gruplar seed EDILMEDEN ONCE calisir. Sonuc: o
// gruplarin fotografi hic istenmiyordu. Olcum: 12 grup sohbetinin 9'unda avatar
// yoktu ve 5'inin sunucuda fotografi VARDI (zorla `profilePictureUrl` bir URL
// dondurdu).
//
// Bu test `_ensureGroupSubjects` cagrisinin, fotografi olmayan grup icin
// WhatsApp'a `profilePictureUrl` sormasi gerektigini sabitler. Kaynak
// degisikligi geri alinirsa FAIL eder.
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

const GROUP_WITH_PICTURE = '905356872662-1533631296@g.us'; // seed'de imgUrl YOK
const GROUP_WITH_META_PICTURE = '120363406556759828@g.us'; // meta.imgUrl VAR
const PICTURE_URL = 'https://pps.whatsapp.net/v/t61.24694-24/group.jpg';

function makeManager() {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), 'group-avatar-sessions'),
    mediaDir: path.join(os.tmpdir(), 'group-avatar-media'),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

async function attachFakeSocket(sm, sid) {
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = false;
  const pictureCalls = [];
  session.sock = {
    async groupFetchAllParticipating() {
      return {
        [GROUP_WITH_META_PICTURE]: {
          id: GROUP_WITH_META_PICTURE,
          subject: 'Meyve',
          imgUrl: 'https://meta/meyve.jpg',
        },
        [GROUP_WITH_PICTURE]: {
          id: GROUP_WITH_PICTURE,
          subject: 'Tezcan Ailesi',
          // imgUrl yok — gercek `groupFetchAllParticipating` cogu zaman
          // fotograf dondurmez, bu yuzden ayrica sorulmasi gerekir.
        },
      };
    },
    async groupMetadata(jid) {
      return { id: jid, subject: 'Tezcan Ailesi' };
    },
    async profilePictureUrl(jid) {
      pictureCalls.push(jid);
      return jid === GROUP_WITH_PICTURE ? PICTURE_URL : null;
    },
  };
  return { session, pictureCalls };
}

// --- A. konudan ogrenilen grup icin fotograf ISTENIR -------------------------
{
  const sm = makeManager();
  const sid = (await sm.createSession('avatar-hat', { autoStart: false })).id;
  const { session, pictureCalls } = await attachFakeSocket(sm, sid);

  await sm._ensureGroupSubjects({ sessionId: sid, force: true });
  // `_ensureChatAvatar` atesle-unut calisir; sonucun store'a yazilmasi icin
  // mikro gorev dongusune birakilir.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const store = sm._storeOf(session);
  const chat = store.chats.get(GROUP_WITH_PICTURE);
  assert.ok(chat, 'the group must be seeded into store.chats');
  assert.equal(chat.name_source, 'group_subject');
  assert.ok(
    pictureCalls.includes(GROUP_WITH_PICTURE),
    'a subject-seeded group with no avatar must be asked for its picture',
  );
  assert.equal(
    chat.avatar_url,
    PICTURE_URL,
    'the fetched picture must land on the chat row',
  );
  check('A: subject-seeded group gets its avatar fetched', () => {});
}

// --- B. meta.imgUrl varsa fazladan istek ATILMAZ ----------------------------
{
  const sm = makeManager();
  const sid = (await sm.createSession('avatar-hat-2', { autoStart: false })).id;
  const { session, pictureCalls } = await attachFakeSocket(sm, sid);

  await sm._ensureGroupSubjects({ sessionId: sid, force: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const chat = sm._storeOf(session).chats.get(GROUP_WITH_META_PICTURE);
  assert.equal(chat.avatar_url, 'https://meta/meyve.jpg');
  assert.equal(
    pictureCalls.includes(GROUP_WITH_META_PICTURE),
    false,
    'a group that already carries a picture must not be re-fetched',
  );
  check('B: a group with meta.imgUrl is not re-fetched', () => {});
}

// --- C. fotograf yoksa sohbet yine de kalir (uydurma URL yok) ---------------
{
  const sm = makeManager();
  const sid = (await sm.createSession('avatar-hat-3', { autoStart: false })).id;
  const { session } = await attachFakeSocket(sm, sid);
  const pictureless = '120363424890338512@g.us';
  session.sock.groupFetchAllParticipating = async () => ({
    [pictureless]: { id: pictureless, subject: 'Kovulanlar' },
  });
  session.sock.profilePictureUrl = async () => null;

  await sm._ensureGroupSubjects({ sessionId: sid, force: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const chat = sm._storeOf(session).chats.get(pictureless);
  assert.ok(chat, 'the group must still exist');
  assert.equal(chat.avatar_url, null, 'no picture means null, never a made-up URL');
  check('C: a genuinely pictureless group keeps avatar_url null', () => {});
}

console.log(`\nGroup avatar fetch verification: PASS (${passed} checks)`);
