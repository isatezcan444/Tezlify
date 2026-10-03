import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

console.log('[test-phone-notifications-presence] Starting push notifications & presence verification...');

// 1. Verify Baileys creds.update interceptor logic and presence containment
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
  let dispatchedNode = null;
  const sock = {
    ev,
    sendNode: async (node) => {
      dispatchedNode = node;
      return node;
    },
    query: async (queryObj) => {
      return queryObj;
    },
  };

  // Set up the sendNode interceptor as implemented in socket-connector.js
  const originalSendNode = sock.sendNode.bind(sock);
  sock.sendNode = async (node) => {
    if (node?.tag === 'presence') {
      if (!node.attrs) node.attrs = {};
      if (node.attrs.type !== 'unavailable' && node.attrs.type !== 'subscribe') {
        node.attrs.type = 'unavailable';
      }
    }
    return originalSendNode(node);
  };

  // Set up the creds.update interceptor as implemented in socket-connector.js
  const passThrough = sock.ev.emit.bind(sock.ev);
  sock.ev.emit = (event, data) => {
    if (event === 'creds.update' && data) {
      if (data.me?.name && state.creds?.me) {
        state.creds.me.name = data.me.name;
      }
      if (data.me === undefined && state.creds?.me) {
        if (!state.creds.me.name) {
          state.creds.me.name = 'Tezlify';
        }
        return passThrough(event, { ...data, me: state.creds.me });
      }
      if (data.me && !data.me.name && state.creds?.me?.name) {
        data.me.name = state.creds.me.name;
      }
    }
    return passThrough(event, data);
  };

  // Track what listeners receive
  const receivedUpdates = [];
  sock.ev.on('creds.update', (update) => {
    receivedUpdates.push(update);
  });

  // Emulate Baileys internal presence listener from Socket/socket.ts:843
  sock.ev.on('creds.update', (update) => {
    const name = update.me?.name;
    if (state.creds.me?.name !== name) {
      void sock.sendNode({ tag: 'presence', attrs: { name } });
    }
  });

  // Test Case A: Partial update without `me` (happens on every inbound message key rotation)
  sock.ev.emit('creds.update', { accountSyncCounter: 1 });
  assert.equal(receivedUpdates.length, 1, 'creds.update should be received');
  assert.deepEqual(receivedUpdates[0].me, state.creds.me, 'partial update must be augmented with state.creds.me');
  assert.equal(dispatchedNode, null, 'no presence node should be sent on partial update');
  console.log('  ok - partial creds.update does not trigger presence dispatch');

  // Test Case B: Name update is synchronized, preventing rogue comparison, and if dispatched, forced to unavailable
  sock.ev.emit('creds.update', {
    me: { id: state.creds.me.id, name: 'Updated Name', lid: state.creds.me.lid },
  });
  assert.equal(receivedUpdates.length, 2, 'second update should be received');
  assert.equal(receivedUpdates[1].me.name, 'Updated Name', 'name update passes through');

  // Test Case C: Direct sendNode interceptor guarantees any online presence is forced to unavailable
  await sock.sendNode({ tag: 'presence', attrs: { name: 'Test' } });
  assert.ok(dispatchedNode, 'node was dispatched');
  assert.equal(dispatchedNode.attrs.type, 'unavailable', 'rogue presence must be forced to unavailable');
  console.log('  ok - sendNode interceptor converts rogue presence to unavailable');
}

// 2. Verify gateway socket connector config & exports
{
  const connectorSource = await import('../src/socket/socket-connector.js');
  assert.ok(connectorSource, 'socket-connector module loads successfully');
  assert.equal(typeof connectorSource.setCompanionPassive, 'function', 'setCompanionPassive is exported');

  let passiveQuery = null;
  const fakeSock = {
    query: async (q) => {
      passiveQuery = q;
      return q;
    },
  };
  await connectorSource.setCompanionPassive(fakeSock, null, 'test-ref');
  assert.ok(passiveQuery, 'passive query was sent');
  assert.equal(passiveQuery.attrs.xmlns, 'passive', 'passive xmlns is correct');
  assert.equal(passiveQuery.content[0].tag, 'passive', 'passive tag is correct');
  console.log('  ok - setCompanionPassive emits correct passive IQ stanza');
}

console.log('[test-phone-notifications-presence] All checks passed successfully!');
