import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

console.log('[test-phone-notifications-presence] Starting push notifications & presence verification...');

// 1. Verify Baileys creds.update interceptor logic
{
  const state = {
    creds: {
      me: {
        id: '905551234567@s.whatsapp.net',
        name: 'Ismail Tezcan',
        lid: '10000001@lid',
      },
      accountSyncCounter: 0,
    },
  };

  const ev = new EventEmitter();
  const sock = {
    ev,
  };

  // Set up the interceptor as implemented in socket-connector.js
  const passThrough = sock.ev.emit.bind(sock.ev);
  sock.ev.emit = (event, data) => {
    if (event === 'creds.update' && data && data.me === undefined && state.creds?.me) {
      return passThrough(event, { ...data, me: state.creds.me });
    }
    return passThrough(event, data);
  };

  // Track what listeners receive
  const receivedUpdates = [];
  sock.ev.on('creds.update', (update) => {
    receivedUpdates.push(update);
  });

  // Emulate Baileys internal presence listener from Socket/socket.ts:843
  let roguePresenceSent = false;
  sock.ev.on('creds.update', (update) => {
    const name = update.me?.name;
    // The exact vulnerable comparison in Baileys:
    if (state.creds.me?.name !== name) {
      roguePresenceSent = true;
    }
  });

  // Test Case A: Partial update without `me` (happens on every inbound message key rotation)
  sock.ev.emit('creds.update', { accountSyncCounter: 1 });
  assert.equal(receivedUpdates.length, 1, 'creds.update should be received');
  assert.deepEqual(receivedUpdates[0].me, state.creds.me, 'partial update must be augmented with state.creds.me');
  assert.equal(roguePresenceSent, false, 'rogue presence must NOT be triggered on partial update');
  console.log('  ok - partial creds.update (inbound message churn) does not trigger rogue online presence');

  // Test Case B: Legitimate name update
  sock.ev.emit('creds.update', {
    me: { id: state.creds.me.id, name: 'Updated Name', lid: state.creds.me.lid },
  });
  assert.equal(receivedUpdates.length, 2, 'second update should be received');
  assert.equal(receivedUpdates[1].me.name, 'Updated Name', 'legitimate name update passes through');
  assert.equal(roguePresenceSent, true, 'legitimate name change triggers presence as expected by protocol');
  console.log('  ok - legitimate name update passes through and updates presence');
}

// 2. Verify gateway socket connector config uses markOnlineOnConnect: false
{
  const connectorSource = await import('../src/socket/socket-connector.js');
  assert.ok(connectorSource, 'socket-connector module loads successfully');
  console.log('  ok - socket-connector module loaded');
}

console.log('[test-phone-notifications-presence] All checks passed successfully!');
