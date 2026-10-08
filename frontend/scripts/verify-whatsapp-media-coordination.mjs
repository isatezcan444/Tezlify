#!/usr/bin/env node
import assert from 'node:assert/strict';

/**
 * Verification Suite for WhatsApp Media Coordination & Single Active Invariant
 */

console.log('--- Tezlify WhatsApp Media Coordination Verification ---');

// Mock DOM MediaElement & window for node test environment
class MockMediaElement {
  constructor(id) {
    this.id = id;
    this.paused = true;
    this.currentTime = 0;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

class MockCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

globalThis.CustomEvent = MockCustomEvent;
const listeners = new Map();
globalThis.window = {
  dispatchEvent: (event) => {
    const arr = listeners.get(event.type) || [];
    for (const fn of arr) fn(event);
    return true;
  },
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const arr = listeners.get(type) || [];
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  },
};

const {
  registerMedia,
  notifyMediaPlaying,
  pauseAllMedia,
  isMediaActive,
  getActiveMediaId,
  MEDIA_PLAY_EVENT,
  MEDIA_PAUSE_ALL_EVENT,
} = await import('../src/features/whatsapp/lib/mediaCoordinator.ts');

// Test 1: Register and single active playback invariant
console.log('Test 1: Single active playback invariant between multiple media');
const video1 = new MockMediaElement('video-1');
const video2 = new MockMediaElement('video-2');
const voice1 = new MockMediaElement('voice-1');

let video1PausedCallbackCalled = false;
let video2PausedCallbackCalled = false;
let voice1PausedCallbackCalled = false;

const unreg1 = registerMedia('video-1', video1, () => { video1PausedCallbackCalled = true; });
const unreg2 = registerMedia('video-2', video2, () => { video2PausedCallbackCalled = true; });
const unreg3 = registerMedia('voice-1', voice1, () => { voice1PausedCallbackCalled = true; });

// Start video 1
video1.play();
notifyMediaPlaying('video-1', video1);
assert.equal(video1.paused, false, 'video1 should be playing');
assert.equal(isMediaActive('video-1'), true, 'video1 should be active');

// Start video 2 -> video 1 must be paused automatically!
video2.play();
notifyMediaPlaying('video-2', video2);
assert.equal(video1.paused, true, 'video1 must be automatically paused when video2 starts');
assert.equal(video1PausedCallbackCalled, true, 'video1 onPause callback must have been fired');
assert.equal(video2.paused, false, 'video2 should be playing');
assert.equal(getActiveMediaId(), 'video-2', 'video2 should be current active media');

// Start voice note 1 -> video 2 must be paused automatically!
voice1.play();
notifyMediaPlaying('voice-1', voice1);
assert.equal(video2.paused, true, 'video2 must be automatically paused when voice note starts');
assert.equal(video2PausedCallbackCalled, true, 'video2 onPause callback must have been fired');
assert.equal(voice1.paused, false, 'voice1 should be playing');
console.log('  ok - mutual exclusion between video1, video2, and voice notes passed');

// Test 2: Opening Lightbox pauses all background media
console.log('Test 2: Opening Lightbox pauses all background media');
const lightboxVideo = new MockMediaElement('lightbox-media-video');
const unregLightbox = registerMedia('lightbox-media-video', lightboxVideo);

// Voice note is currently playing. Open lightbox video.
pauseAllMedia('lightbox-media-video');
assert.equal(voice1.paused, true, 'voice note must be paused when lightbox opens');
assert.equal(voice1PausedCallbackCalled, true, 'voice note onPause callback called');

// Lightbox plays
lightboxVideo.play();
notifyMediaPlaying('lightbox-media-video', lightboxVideo);
assert.equal(lightboxVideo.paused, false, 'lightbox video is playing');
assert.equal(video1.paused, true, 'inline video 1 remains paused');
assert.equal(video2.paused, true, 'inline video 2 remains paused');
assert.equal(voice1.paused, true, 'voice note remains paused');
console.log('  ok - lightbox open pauses background media and prevents dual playback');

// Test 3: Closing Lightbox pauses lightbox video and global pauseAllMedia
console.log('Test 3: Lightbox close and global pauseAllMedia');
pauseAllMedia();
assert.equal(lightboxVideo.paused, true, 'lightbox video must be paused on pauseAllMedia');
assert.equal(getActiveMediaId(), null, 'no media is active after pauseAllMedia');
console.log('  ok - lightbox close and pauseAllMedia passed');

// Test 4: CustomEvent propagation
console.log('Test 4: Custom event propagation across decoupled listeners');
let receivedPlayEventId = null;
let receivedPauseAllExceptId = null;

const onPlayEvent = (e) => { receivedPlayEventId = e.detail?.id; };
const onPauseAllEvent = (e) => { receivedPauseAllExceptId = e.detail?.exceptId; };

globalThis.window.addEventListener(MEDIA_PLAY_EVENT, onPlayEvent);
globalThis.window.addEventListener(MEDIA_PAUSE_ALL_EVENT, onPauseAllEvent);

notifyMediaPlaying('test-broadcast-id');
assert.equal(receivedPlayEventId, 'test-broadcast-id', 'Event must contain playing media ID');

pauseAllMedia('exempt-id');
assert.equal(receivedPauseAllExceptId, 'exempt-id', 'Event must contain exempt ID');
console.log('  ok - CustomEvent dispatch and listener subscription verified');

// Test 5: Cleanup & Unregister
console.log('Test 5: Clean unregister without leaks');
unreg1();
unreg2();
unreg3();
unregLightbox();
globalThis.window.removeEventListener(MEDIA_PLAY_EVENT, onPlayEvent);
globalThis.window.removeEventListener(MEDIA_PAUSE_ALL_EVENT, onPauseAllEvent);
console.log('  ok - unregistration clean');

console.log('ALL WhatsApp media coordination tests PASSED!');
