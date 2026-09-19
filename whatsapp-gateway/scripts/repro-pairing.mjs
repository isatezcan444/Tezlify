/**
 * Phase 6.4 §3 — REPRODUCE. No code is changed here; this only observes.
 */
import { createHarness, settle, cleanupHarness, waitFor } from './pairing-harness.mjs';

const h = await createHarness();
const reg = h.registry;

// A1/A2 — session creation + socket creation
const session = await h.manager.createSession('repro-hat', { ephemeral: true });
await waitFor(() => reg.sockets.length > 0, { label: 'socket creation' });
console.log('A1 session created        :', session.id, '| status=', session.status);
console.log('A2 sockets opened         :', reg.sockets.length);
const sock = reg.sockets[reg.sockets.length - 1];
console.log('   socket present         :', Boolean(sock));

// A3 — QR emitted by Baileys
await h.connectionUpdate(sock, { qr: 'QR-PAYLOAD-1', connection: undefined });
await settle(10);
const qrEvents = h.eventsOfType('session_qr_updated');
console.log('A3 qr handled             :', qrEvents.length, 'event(s)');
console.log('A4 session_qr_updated     :', qrEvents.length ? 'EMITTED' : 'NOT EMITTED');
console.log('   qr_code is data URI    :', String(qrEvents[0]?.qr_code || '').slice(0, 24));
console.log('   session status         :', h.manager.getSession(session.id).status);

// A5..A7 depend on backend/frontend; assert the gateway-side payload shape
console.log('A5 event payload keys     :', Object.keys(qrEvents[0] || {}).join(','));

// A8/A9 — scan + open
await h.connectionUpdate(sock, { connection: 'connecting' });
await settle(5);
console.log('A8 connecting status      :', h.manager.getSession(session.id).status);
await h.connectionUpdate(sock, { connection: 'open' });
await settle(10);
const afterOpen = h.manager.getSession(session.id);
console.log('A9/A11 status after open  :', afterOpen.status);
console.log('   qr cleared             :', afterOpen.qr_code === null);
console.log('   ephemeral promoted     :', afterOpen.ephemeral === false);

await cleanupHarness();
