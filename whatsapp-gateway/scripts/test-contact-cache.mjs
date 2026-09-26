import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../src/messages/message-store.js';
import {
  CONTACTS_CACHE_FILE,
  CONTACTS_CACHE_SAVE_DEBOUNCE_MS,
} from '../src/messages/contact-cache.js';

const JID = '905076382749@s.whatsapp.net';
const GROUP_JID = '905413749073-1589570212@g.us';

function tmpSessionDir(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `gw-contacts-${label}-`));
  return path.join(base, 'session-1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const warnings = [];
const logger = { warn: (o) => warnings.push(o), info: () => {}, debug: () => {} };

// --- A. the map hook alone must persist (no manual flush) --------------------
{
  const dir = tmpSessionDir('hook');
  const store = createSessionStore({ sessionDir: dir, logger });
  assert.ok(store.contactCache, 'store exposes its contact cache');
  const file = path.join(dir, CONTACTS_CACHE_FILE);
  assert.equal(fs.existsSync(file), false, 'no cache file before any mutation');

  store.contacts.set(JID, { id: JID, jid: JID, name: 'Cevat Aydın', name_source: 'addressbook' });
  // If instrumentContacts()/schedule() were removed this would never be written.
  await sleep(CONTACTS_CACHE_SAVE_DEBOUNCE_MS + 250);
  assert.equal(fs.existsSync(file), true, 'mutation alone wrote the cache');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.contacts.length, 1);
  assert.equal(raw.contacts[0][0], JID);
  assert.equal(raw.contacts[0][1].name, 'Cevat Aydın');
}

// --- B. a fresh store on the same dir restores the name ----------------------
{
  const dir = tmpSessionDir('restore');
  const first = createSessionStore({ sessionDir: dir, logger });
  first.contacts.set(JID, { id: JID, jid: JID, name: 'Cevat Aydın', name_source: 'addressbook' });
  assert.equal(first.contactCache.flush(), true, 'explicit flush succeeds');

  const second = createSessionStore({ sessionDir: dir, logger });
  assert.equal(second.contacts.get(JID)?.name, 'Cevat Aydın', 'name survived a restart');
}

// --- C. instrumented map keeps full Map semantics ---------------------------
{
  const dir = tmpSessionDir('semantics');
  const store = createSessionStore({ sessionDir: dir, logger });
  const map = store.contacts;
  map.set('a@x', { name: 'A' });
  map.set('b@x', { name: 'B' });
  assert.equal(map.size, 2, 'size getter works through the proxy');
  assert.equal(map.has('a@x'), true);
  assert.equal(map.get('b@x').name, 'B');
  assert.deepEqual([...map.keys()].sort(), ['a@x', 'b@x'], 'iteration works through the proxy');
  assert.deepEqual([...map.entries()].length, 2);
  map.delete('a@x');
  assert.equal(map.has('a@x'), false, 'delete works through the proxy');
  store.contactCache.flush();
  const names = JSON.parse(fs.readFileSync(path.join(dir, CONTACTS_CACHE_FILE), 'utf8'))
    .contacts.map((e) => e[1].name);
  assert.deepEqual(names, ['B'], 'delete is reflected in the persisted cache');
}

// --- D. a phone-number change discards the cache ----------------------------
{
  const dir = tmpSessionDir('phone');
  const first = createSessionStore({ sessionDir: dir, sessionPhone: '+905413749073', logger });
  first.contacts.set(JID, { name: 'Cevat Aydın' });
  first.contactCache.flush();

  const samePhone = createSessionStore({ sessionDir: dir, sessionPhone: '+905413749073', logger });
  assert.equal(samePhone.contacts.get(JID)?.name, 'Cevat Aydın', 'same phone keeps names');

  const otherPhone = createSessionStore({ sessionDir: dir, sessionPhone: '+15556599459', logger });
  assert.equal(otherPhone.contacts.has(JID), false, 'different phone discards names');
}

// --- E. only real names are persisted ---------------------------------------
{
  const dir = tmpSessionDir('filter');
  const store = createSessionStore({ sessionDir: dir, logger });
  store.contacts.set('1@s.whatsapp.net', { name: 'jid:123@g.us' }); // raw identity
  store.contacts.set('2@s.whatsapp.net', { name: '+905333240016' }); // phone-shaped
  store.contacts.set('3@s.whatsapp.net', { name: '   ' }); // blank
  store.contacts.set('4@s.whatsapp.net', { name: 'Tolga Cebeci' }); // real
  assert.equal(store.contactCache.flush(), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, CONTACTS_CACHE_FILE), 'utf8')).contacts;
  assert.deepEqual(persisted.map((e) => e[0]), ['4@s.whatsapp.net'],
    'raw, phone-shaped and blank names are not persisted');
}

// --- F. a cache written by an older build cannot inject a raw JID -----------
{
  const dir = tmpSessionDir('poison');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CONTACTS_CACHE_FILE), JSON.stringify({
    version: 1,
    saved_at: new Date().toISOString(),
    session_phone: null,
    contacts: [
      ['a@s.whatsapp.net', { name: 'jid:120363424890338512@g.us' }],
      ['b@s.whatsapp.net', { name: '905321002030@s.whatsapp.net' }],
      ['c@s.whatsapp.net', { name: 'Gercek Isim' }],
    ],
  }), 'utf8');
  const store = createSessionStore({ sessionDir: dir, logger });
  assert.equal(store.contacts.has('a@s.whatsapp.net'), false, 'raw jid name rejected on load');
  assert.equal(store.contacts.has('b@s.whatsapp.net'), false, 'raw jid value rejected on load');
  assert.equal(store.contacts.get('c@s.whatsapp.net')?.name, 'Gercek Isim');
}

// --- G. clear() removes the cache (logout / banned) -------------------------
{
  const dir = tmpSessionDir('clear');
  const store = createSessionStore({ sessionDir: dir, logger });
  store.contacts.set(JID, { name: 'Cevat Aydın' });
  store.contactCache.flush();
  const file = path.join(dir, CONTACTS_CACHE_FILE);
  assert.equal(fs.existsSync(file), true);
  assert.equal(store.contactCache.clear(), true);
  assert.equal(fs.existsSync(file), false, 'clear removed the cache');
  const after = createSessionStore({ sessionDir: dir, logger });
  assert.equal(after.contacts.size, 0, 'nothing restored after clear');
}

// --- H. group JIDs are cacheable too (group subjects) -----------------------
{
  const dir = tmpSessionDir('group');
  const store = createSessionStore({ sessionDir: dir, logger });
  store.contacts.set(GROUP_JID, { name: '3Hacker', name_source: 'group_subject' });
  store.contactCache.flush();
  const restored = createSessionStore({ sessionDir: dir, logger });
  assert.equal(restored.contacts.get(GROUP_JID)?.name, '3Hacker');
}

// --- I. no session dir means no cache and no crash --------------------------
{
  const store = createSessionStore();
  assert.equal(store.contactCache, undefined, 'no cache without a session dir');
  store.contacts.set(JID, { name: 'Cevat Aydın' });
  assert.equal(store.contacts.get(JID).name, 'Cevat Aydın', 'plain store still works');
}

assert.equal(warnings.length, 0, `no warnings expected: ${JSON.stringify(warnings)}`);

console.log('[test-contact-cache] 31 assertions passed');
