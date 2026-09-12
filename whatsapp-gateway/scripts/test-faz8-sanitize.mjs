// Faz 8 (§22): gateway sanitizasyon choke-point birim testleri —
// `node scripts/test-faz8-sanitize.mjs` ile çalışır, exit code 0 = PASS.
import assert from 'node:assert/strict';
import {
  isRawIdentityName,
  sanitizeChatForEmit,
  sanitizeOutboundEvent,
  mergeContactName,
  NAME_RANK,
  jidToPhone,
} from '../src/session-manager.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

check('isRawIdentityName detects @lid/@g.us/@s.whatsapp.net/jid:', () => {
  assert.equal(isRawIdentityName('62771114836011@lid'), true);
  assert.equal(isRawIdentityName('120363012345678901@g.us'), true);
  assert.equal(isRawIdentityName('905321002030@s.whatsapp.net'), true);
  assert.equal(isRawIdentityName('jid:120363012345678901@g.us'), true);
  assert.equal(isRawIdentityName('İstanbul İş Grubu'), false);
  assert.equal(isRawIdentityName('Mehmet Kuaför'), false);
});

check('NAME_RANK includes group_subject between addressbook and history', () => {
  assert.equal(NAME_RANK.addressbook, 5);
  assert.equal(NAME_RANK.group_subject, 4);
  assert.equal(NAME_RANK.history, 3);
});

check('jidToPhone never derives phone from group or lid jid', () => {
  assert.equal(jidToPhone('120363012345678901@g.us'), null);
  assert.equal(jidToPhone('62771114836011@lid'), null);
  assert.equal(jidToPhone('905321002030@s.whatsapp.net'), '+905321002030');
});

check('sanitizeChatForEmit nulls raw name', () => {
  const out = sanitizeChatForEmit({ id: '120363@g.us', name: '120363@g.us', name_source: 'group_subject' });
  assert.equal(out.name, null);
  assert.equal(out.name_source, null);
  const ok = sanitizeChatForEmit({ id: '120363@g.us', name: 'İstanbul İş Grubu', name_source: 'group_subject' });
  assert.equal(ok.name, 'İstanbul İş Grubu');
});

check('sanitizeOutboundEvent cleans contact_synced / message_new / conversation_updated', () => {
  const cs = sanitizeOutboundEvent({ event: 'contact_synced', contact: { id: '62771@lid', name: '62771@lid' } });
  assert.equal(cs.contact.name, null);
  const mn = sanitizeOutboundEvent({ event: 'message_new', message: { conversation_id: 'x@lid', sender_name: 'x@lid', participant_name: 'p@lid' } });
  assert.equal(mn.message.sender_name, null);
  assert.equal(mn.message.participant_name, null);
  const cu = sanitizeOutboundEvent({ event: 'conversation_updated', conversation: { id: 'g@g.us', name: 'g@g.us' } });
  assert.equal(cu.conversation.name, null);
});

check('mergeContactName: addressbook beats group_subject, group_subject beats history', () => {
  const a = mergeContactName({ name: 'Grup Adi', name_source: 'group_subject' }, 'Rehber Adi', 'addressbook');
  assert.equal(a.name, 'Rehber Adi');
  const b = mergeContactName({ name: 'Eski', name_source: 'history' }, 'Grup Adi', 'group_subject');
  assert.equal(b.name, 'Grup Adi');
  const c = mergeContactName({ name: 'Rehber Adi', name_source: 'addressbook' }, 'Push Adi', 'push');
  assert.equal(c.name, 'Rehber Adi');
});

console.log(`[test-faz8-sanitize] ${passed} assertions passed`);
