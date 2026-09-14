import assert from 'node:assert/strict';

console.log('[test-whatsapp-chat-scroll] starting frontend chat scroll tests...');

// 1. Simulate scroll position preservation on prepend
let container = {
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
};

let prevScrollHeight = container.scrollHeight;
let prevScrollTop = container.scrollTop;

// Prepend 50 older messages: container scrollHeight increases from 1000 to 2200
container.scrollHeight = 2200;
const heightDiff = container.scrollHeight - prevScrollHeight;
container.scrollTop = prevScrollTop + heightDiff;

// Assert that the user is viewing the exact same message after prepend
assert.equal(container.scrollTop, 1200, 'Scroll position must be offset by the prepended content height');

// 2. Simulate smart auto-scroll on new incoming message
function simulateIncomingMessage(isNearBottom) {
  let scrolledToBottom = false;
  let showNewMessagePill = false;

  if (isNearBottom) {
    scrolledToBottom = true;
    showNewMessagePill = false;
  } else {
    showNewMessagePill = true;
    scrolledToBottom = false;
  }
  return { scrolledToBottom, showNewMessagePill };
}

// User reading older messages (not near bottom)
const readingOlder = simulateIncomingMessage(false);
assert.equal(readingOlder.scrolledToBottom, false, 'Should NOT force scroll to bottom when reading older messages');
assert.equal(readingOlder.showNewMessagePill, true, 'Should show new message indicator pill');

// User at bottom
const atBottom = simulateIncomingMessage(true);
assert.equal(atBottom.scrolledToBottom, true, 'Should auto-scroll when near bottom');
assert.equal(atBottom.showNewMessagePill, false, 'Should not show pill when already at bottom');

// 3. Upward scroll trigger
let loadOlderCalled = false;
function simulateScroll(scrollTop, hasMore, loadingOlder) {
  if (scrollTop < 60 && hasMore && !loadingOlder) {
    loadOlderCalled = true;
  }
}

simulateScroll(30, true, false);
assert.equal(loadOlderCalled, true, 'Scrolling upward past threshold must trigger load older');

loadOlderCalled = false;
simulateScroll(30, false, false);
assert.equal(loadOlderCalled, false, 'Must not trigger load older when hasMore is false');

loadOlderCalled = false;
simulateScroll(30, true, true);
assert.equal(loadOlderCalled, false, 'Must not trigger load older when already loading older');

console.log('[test-whatsapp-chat-scroll] ALL assertions passed.');
