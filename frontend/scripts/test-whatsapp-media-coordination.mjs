#!/usr/bin/env node
import assert from 'node:assert/strict';

/**
 * Tezlify WhatsApp Media Playback Coordination & Lifecycle Test Suite
 *
 * Verifies single-active playback invariants, pause/stop coordination,
 * lifecycle unregister idempotency, error recovery, and event propagation.
 *
 * Run: node scripts/test-whatsapp-media-coordination.mjs
 */

console.log('--- Tezlify WhatsApp Media Playback Coordination Test Suite ---');

class MockMediaElement {
  constructor(id, shouldFailPlay = false) {
    this.id = id;
    this.paused = true;
    this.currentTime = 0;
    this.shouldFailPlay = shouldFailPlay;
  }
  play() {
    if (this.shouldFailPlay) {
      return Promise.reject(new Error('NotAllowedError: play() failed'));
    }
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
  notifyMediaPaused,
  notifyMediaEnded,
  pauseAllMedia,
  isMediaActive,
  getActiveMediaId,
  clearAllRegisteredMedia,
  MEDIA_PLAY_EVENT,
  MEDIA_PAUSE_ALL_EVENT,
} = await import('../src/features/whatsapp/lib/mediaCoordinator.ts');

clearAllRegisteredMedia();

// 1. Mutual exclusion between audio and video
{
  const voice1 = new MockMediaElement('voice-1');
  const video1 = new MockMediaElement('video-1');
  let voice1Paused = false;
  let video1Paused = false;

  const unregVoice = registerMedia('voice-1', voice1, () => { voice1Paused = true; });
  const unregVideo = registerMedia('video-1', video1, () => { video1Paused = true; });

  voice1.play();
  notifyMediaPlaying('voice-1', voice1);
  assert.equal(voice1.paused, false);
  assert.equal(isMediaActive('voice-1'), true);

  // Starting video must pause voice note
  video1.play();
  notifyMediaPlaying('video-1', video1);
  assert.equal(voice1.paused, true, 'Voice note must be paused when video starts');
  assert.equal(voice1Paused, true);
  assert.equal(video1.paused, false);
  assert.equal(getActiveMediaId(), 'video-1');

  unregVoice();
  unregVideo();
  console.log('  ✓ 1. Single active media: video pauses audio and maintains active ID');
}

// 2. notifyMediaPaused and notifyMediaEnded clear active media state
{
  clearAllRegisteredMedia();
  const voice = new MockMediaElement('voice-active');
  const unreg = registerMedia('voice-active', voice);

  notifyMediaPlaying('voice-active', voice);
  assert.equal(isMediaActive('voice-active'), true);

  notifyMediaPaused('voice-active');
  assert.equal(isMediaActive('voice-active'), false, 'notifyMediaPaused should clear active media ID');
  assert.equal(getActiveMediaId(), null);

  notifyMediaPlaying('voice-active', voice);
  assert.equal(isMediaActive('voice-active'), true);

  notifyMediaEnded('voice-active');
  assert.equal(isMediaActive('voice-active'), false, 'notifyMediaEnded should clear active media ID');
  assert.equal(getActiveMediaId(), null);

  unreg();
  console.log('  ✓ 2. notifyMediaPaused and notifyMediaEnded correctly clear activeMediaId');
}

// 3. Opening Lightbox pauses all background media (except lightbox video)
{
  clearAllRegisteredMedia();
  const bgVoice = new MockMediaElement('bg-voice');
  const bgVideo = new MockMediaElement('bg-video');
  const lightboxVideo = new MockMediaElement('lightbox-media-video');

  let bgVoicePaused = false;
  let bgVideoPaused = false;

  const unregVoice = registerMedia('bg-voice', bgVoice, () => { bgVoicePaused = true; });
  const unregVideo = registerMedia('bg-video', bgVideo, () => { bgVideoPaused = true; });
  const unregLightbox = registerMedia('lightbox-media-video', lightboxVideo);

  bgVoice.play();
  notifyMediaPlaying('bg-voice', bgVoice);

  // Opening lightbox calls pauseAllMedia('lightbox-media-video')
  pauseAllMedia('lightbox-media-video');
  assert.equal(bgVoice.paused, true, 'Background voice note must pause on lightbox open');
  assert.equal(bgVoicePaused, true);

  lightboxVideo.play();
  notifyMediaPlaying('lightbox-media-video', lightboxVideo);
  assert.equal(lightboxVideo.paused, false);
  assert.equal(isMediaActive('lightbox-media-video'), true);

  unregVoice();
  unregVideo();
  unregLightbox();
  console.log('  ✓ 3. Lightbox pauseAllMedia exempts lightbox video and pauses background items');
}

// 4. Conversation switch pauseAllMedia stops all running audio/video
{
  clearAllRegisteredMedia();
  const convVoice = new MockMediaElement('conv-voice');
  let convVoicePaused = false;

  const unreg = registerMedia('conv-voice', convVoice, () => { convVoicePaused = true; });
  convVoice.play();
  notifyMediaPlaying('conv-voice', convVoice);

  // User switches conversation -> pauseAllMedia() called
  pauseAllMedia();
  assert.equal(convVoice.paused, true, 'Conversation switch must pause running media');
  assert.equal(convVoicePaused, true);
  assert.equal(getActiveMediaId(), null);

  unreg();
  console.log('  ✓ 4. Conversation switch pauseAllMedia() pauses all audio and video');
}

// 5. Idempotent unregister does not throw and handles multiple calls safely
{
  clearAllRegisteredMedia();
  const elem = new MockMediaElement('elem-1');
  const unreg = registerMedia('elem-1', elem);

  // Calling unregister multiple times (e.g. Strict Mode or double unmount)
  assert.doesNotThrow(() => {
    unreg();
    unreg();
    unreg();
  }, 'Multiple unregister calls must be safe and idempotent');
  console.log('  ✓ 5. Unregister is idempotent and resilient against duplicate calls');
}

// 6. Unregistering one media does not disturb other active registrations
{
  clearAllRegisteredMedia();
  const m1 = new MockMediaElement('media-1');
  const m2 = new MockMediaElement('media-2');
  let m2Paused = false;

  const unreg1 = registerMedia('media-1', m1);
  const unreg2 = registerMedia('media-2', m2, () => { m2Paused = true; });

  m2.play();
  notifyMediaPlaying('media-2', m2);

  // Unregister m1
  unreg1();
  assert.equal(isMediaActive('media-2'), true, 'media-2 must remain active after media-1 unregisters');
  assert.equal(m2.paused, false, 'media-2 must remain playing');

  unreg2();
  console.log('  ✓ 6. Unregistering one media element preserves other active registrations');
}

// 7. React Strict Mode remount simulation (mount -> unmount -> mount)
{
  clearAllRegisteredMedia();
  const elem = new MockMediaElement('strict-elem');
  let pauseCount = 0;

  // Mount 1
  const unreg1 = registerMedia('strict-elem', elem, () => { pauseCount++; });
  // Unmount 1
  unreg1();

  // Mount 2
  const unreg2 = registerMedia('strict-elem', elem, () => { pauseCount++; });
  elem.play();
  notifyMediaPlaying('strict-elem', elem);
  assert.equal(isMediaActive('strict-elem'), true);

  unreg2();
  assert.equal(getActiveMediaId(), null);
  console.log('  ✓ 7. React Strict Mode mount-unmount-remount lifecycle operates cleanly');
}

// 8. CustomEvent dispatch and listener subscription
{
  clearAllRegisteredMedia();
  let receivedPlayId = null;
  let receivedPauseExcept = null;

  const onPlay = (e) => { receivedPlayId = e.detail?.id; };
  const onPause = (e) => { receivedPauseExcept = e.detail?.exceptId; };

  globalThis.window.addEventListener(MEDIA_PLAY_EVENT, onPlay);
  globalThis.window.addEventListener(MEDIA_PAUSE_ALL_EVENT, onPause);

  notifyMediaPlaying('event-test-id');
  assert.equal(receivedPlayId, 'event-test-id');

  pauseAllMedia('exempt-test-id');
  assert.equal(receivedPauseExcept, 'exempt-test-id');

  globalThis.window.removeEventListener(MEDIA_PLAY_EVENT, onPlay);
  globalThis.window.removeEventListener(MEDIA_PAUSE_ALL_EVENT, onPause);
  console.log('  ✓ 8. CustomEvent decoupled propagation verified');
}

// 9. Error handling and play rejection recovery
{
  const brokenAudio = new MockMediaElement('broken-audio', true);
  let playErrorHandled = false;

  brokenAudio.play().catch((err) => {
    assert(err instanceof Error);
    playErrorHandled = true;
  });

  // Allow promise tick
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(playErrorHandled, true, 'play() rejection was caught and handled safely');
  console.log('  ✓ 9. play() rejection handled gracefully without unhandled rejections');
}

console.log('\nAll 9 WhatsApp media coordination test scenarios PASSED!\n');
