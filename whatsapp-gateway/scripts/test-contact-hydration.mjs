import assert from 'node:assert/strict';
import { createContactRepository, jidFromContactPhone } from '../src/contacts/contact-repository.js';
import { createSessionStore } from '../src/messages/message-store.js';

const OWNER = 'f65642ab-4ae5-4d69-945c-8f30c8454bac';
const SESSION = '4b69b1c0-50d8-4fb7-a96d-4e032811f1a8';

const warnings = [];
const logger = { warn: (o) => warnings.push(o), info: () => {}, debug: () => {} };

// --- A. JID derivation -------------------------------------------------------
assert.equal(jidFromContactPhone('+905076382749'), '905076382749@s.whatsapp.net');
assert.equal(jidFromContactPhone('905076382749'), '905076382749@s.whatsapp.net');
assert.equal(jidFromContactPhone('jid:120363424890338512@g.us'), '120363424890338512@g.us');
assert.equal(jidFromContactPhone('jid:62771114836011@lid'), null, 'unresolved LID is not a store key');
assert.equal(jidFromContactPhone('+0'), null, 'degenerate number rejected');
assert.equal(jidFromContactPhone(null), null);
assert.equal(jidFromContactPhone('   '), null);

// --- fake pool that records every call --------------------------------------
function makePool({ owner = OWNER, contacts = [], ownerThrows = false, contactsThrow = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM public.whatsapp_sessions')) {
        if (ownerThrows) throw new Error('db down');
        return { rows: owner ? [{ user_id: owner }] : [] };
      }
      if (sql.includes('FROM public.contacts')) {
        if (contactsThrow) throw new Error('db down');
        return { rows: contacts };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// --- B. hydrates real names, scoped to the resolved owner --------------------
{
  const pool = makePool({
    contacts: [
      { phone_e164: '+905076382749', display_name: 'Cevat Aydın' },
      { phone_e164: 'jid:120363424890338512@g.us', display_name: 'Kovulanlar' },
      { phone_e164: '+905333240016', display_name: '+905333240016' }, // phone-shaped
      { phone_e164: '+905459137484', display_name: 'jid:120363424890338512@g.us' }, // raw jid
      { phone_e164: '+905395081857', display_name: '   ' }, // blank
    ],
  });
  const repo = createContactRepository({ pool, logger });
  const store = createSessionStore();
  const written = await repo.hydrateContactNames(SESSION, store);

  assert.equal(written, 2, 'only the two real names were written');
  assert.equal(store.contacts.get('905076382749@s.whatsapp.net')?.name, 'Cevat Aydın');
  assert.equal(store.contacts.get('120363424890338512@g.us')?.name, 'Kovulanlar');
  assert.equal(store.contacts.has('905333240016@s.whatsapp.net'), false, 'phone-shaped name skipped');
  assert.equal(store.contacts.has('905459137484@s.whatsapp.net'), false, 'raw jid name skipped');

  // Tenant scoping: the owner is resolved from gateway_id and used as the
  // contact filter — never a global scan.
  const ownerCall = pool.calls.find((c) => c.sql.includes('FROM public.whatsapp_sessions'));
  assert.deepEqual(ownerCall.params, [SESSION], 'owner resolved by gateway_id');
  const contactCall = pool.calls.find((c) => c.sql.includes('FROM public.contacts'));
  assert.equal(contactCall.params[0], OWNER, 'contacts filtered by the resolved owner user_id');
  assert.match(contactCall.sql, /ct\.user_id = \$1::uuid/, 'contact query is user-scoped');
}

// --- C. an unresolved owner hydrates nothing and never scans contacts --------
{
  const pool = makePool({ owner: null });
  const repo = createContactRepository({ pool, logger });
  const store = createSessionStore();
  assert.equal(await repo.hydrateContactNames(SESSION, store), 0);
  assert.equal(store.contacts.size, 0);
  assert.equal(pool.calls.some((c) => c.sql.includes('FROM public.contacts')), false,
    'no contact query without an owner');
}

// --- D. a fresher addressbook name already in the store is not downgraded ----
{
  const pool = makePool({ contacts: [{ phone_e164: '+905076382749', display_name: 'Stale Name' }] });
  const repo = createContactRepository({ pool, logger });
  const store = createSessionStore();
  const jid = '905076382749@s.whatsapp.net';
  store.contacts.set(jid, { id: jid, jid, name: 'Fresh Addressbook', name_source: 'addressbook' });
  assert.equal(await repo.hydrateContactNames(SESSION, store), 0, 'nothing rewritten');
  assert.equal(store.contacts.get(jid).name, 'Fresh Addressbook');
  assert.equal(store.contacts.get(jid).name_source, 'addressbook');
}

// --- E. hydration survives a database outage --------------------------------
{
  assert.equal(warnings.length, 0, `no warnings before the outage case: ${JSON.stringify(warnings)}`);
  const pool = makePool({ ownerThrows: true });
  const repo = createContactRepository({ pool, logger });
  const store = createSessionStore();
  assert.equal(await repo.hydrateContactNames(SESSION, store), 0, 'owner lookup failure is swallowed');

  const pool2 = makePool({ contactsThrow: true });
  const repo2 = createContactRepository({ pool: pool2, logger });
  assert.equal(await repo2.hydrateContactNames(SESSION, store), 0, 'contact query failure is swallowed');

  // A swallowed failure must still be visible in the logs, not silent.
  assert.equal(warnings.length, 2, 'each outage was logged as a warning');
  assert.ok(warnings.every((w) => w.err === 'db down'));
  warnings.length = 0;
}

// --- F. no pool / no session / no store are all no-ops ----------------------
{
  const repo = createContactRepository({ pool: null, logger });
  assert.equal(await repo.hydrateContactNames(SESSION, createSessionStore()), 0);
  const pool = makePool();
  const repo2 = createContactRepository({ pool, logger });
  assert.equal(await repo2.hydrateContactNames(null, createSessionStore()), 0);
  assert.equal(await repo2.hydrateContactNames(SESSION, null), 0);
  assert.equal(pool.calls.length, 0, 'no queries issued for no-op inputs');
}

// --- G. hydrated names are persisted by the contact cache -------------------
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-hydrate-')), 'session-1');
  const pool = makePool({ contacts: [{ phone_e164: '+905076382749', display_name: 'Cevat Aydın' }] });
  const repo = createContactRepository({ pool, logger });
  const store = createSessionStore({ sessionDir: dir, logger });
  await repo.hydrateContactNames(SESSION, store);
  store.contactCache.flush();
  const restored = createSessionStore({ sessionDir: dir, logger });
  assert.equal(restored.contacts.get('905076382749@s.whatsapp.net')?.name, 'Cevat Aydın',
    'hydration fed the disk cache too');
}

assert.equal(warnings.length, 0, `no warnings expected: ${JSON.stringify(warnings)}`);

console.log('[test-contact-hydration] 26 assertions passed');
