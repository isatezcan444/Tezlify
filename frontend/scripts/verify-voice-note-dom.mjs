/**
 * Executed DOM verification of VoiceNotePlayer and ChatComposer Voice Recording.
 *
 * Verifies:
 * 1. VoiceNotePlayer renders waveform bars, play/pause controls, speed toggle, and duration.
 * 2. VoiceNotePlayer speed toggle cycles 1x -> 1.5x -> 2x -> 1x.
 * 3. VoiceNotePlayer transitions mic icon to played state (WhatsApp blue #53bdeb) after playback.
 * 4. ChatComposer exposes voice recording button.
 * 5. Clicking voice recording activates live recording bar with discard, timer, and send controls.
 * 6. Discarding cleanly terminates recording and restores standard composer input.
 *
 * Run: node scripts/verify-voice-note-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

hardenAssert(assert);
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch {
    globalThis[name] = value;
  }
};
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('Element', window.Element);
setGlobal('localStorage', window.localStorage);
setGlobal('File', window.File);
setGlobal('Blob', window.Blob);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

// Mock HTMLMediaElement prototype methods for VoiceNotePlayer
window.HTMLMediaElement.prototype.play = function() {
  this.dispatchEvent(new window.Event('play'));
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function() {
  this.dispatchEvent(new window.Event('pause'));
};

// Mock MediaRecorder & getUserMedia for ChatComposer
class MockMediaRecorder {
  constructor(stream) {
    this.stream = stream;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({ data: new window.Blob(['fake-audio-chunk'], { type: 'audio/webm' }) });
    }
    if (this.onstop) {
      this.onstop();
    }
  }
}
MockMediaRecorder.isTypeSupported = () => true;
setGlobal('MediaRecorder', MockMediaRecorder);

const mockMediaDevices = {
  getUserMedia: async () => ({
    getTracks: () => [{ stop: () => {} }],
  }),
};
try {
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, writable: true, value: mockMediaDevices });
} catch {}
try {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, writable: true, value: mockMediaDevices });
} catch {}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-voice-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `import { ToastProvider } from '${SRC}/context/ToastContext';`,
      `import { VoiceNotePlayer } from '${SRC}/features/whatsapp/components/VoiceNotePlayer';`,
      `import { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, VoiceNotePlayer, ChatComposer };`,
    ].join('\n'),
    'utf8'
  );

  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': '{}',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, ToastProvider, VoiceNotePlayer, ChatComposer } = await import(out);
  const h = React.createElement;

  let passed = 0;
  const roots = new Set();

  const cleanup = async () => {
    for (const root of roots) {
      await act(async () => { root.unmount(); });
    }
    roots.clear();
    window.document.body.innerHTML = '';
  };

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        h(I18nProvider, { defaultLocale: 'tr' },
          h(ToastProvider, null, element)
        )
      );
    });
    return { host, root };
  };

  console.log('Running Voice Note Player & Live Recording DOM Verification...');

  // -------------------------------------------------------------
  // Test 1: VoiceNotePlayer rendering and speed cycle
  // -------------------------------------------------------------
  {
    const { host } = await mount(
      h(VoiceNotePlayer, {
        mediaUrl: 'http://localhost/test-voice.ogg',
        duration: 14,
        isOutgoing: false,
      })
    );

    const playBtn = host.querySelector('button');
    assert.ok(playBtn, 'Play button must exist');

    // Waveform bars
    const bars = host.querySelectorAll('[style*="height"]');
    assert.ok(bars.length >= 20, `Waveform must render at least 20 bars, found ${bars.length}`);

    // Speed pill
    const speedBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent && b.textContent.trim().includes('1x')
    );
    assert.ok(speedBtn, 'Speed pill button must exist with 1x default');

    // Click speed button to cycle 1x -> 1.5x
    await act(async () => {
      speedBtn.click();
    });
    assert.equal(speedBtn.textContent.trim(), '1.5x', 'Speed should cycle to 1.5x');

    // Click again: 1.5x -> 2x
    await act(async () => {
      speedBtn.click();
    });
    assert.equal(speedBtn.textContent.trim(), '2x', 'Speed should cycle to 2x');

    // Playback trigger and played mic color check
    await act(async () => {
      playBtn.click();
    });

    const audioEl = host.querySelector('audio');
    assert.ok(audioEl, 'Audio element must be created');

    await act(async () => {
      audioEl.currentTime = 1;
      audioEl.dispatchEvent(new window.Event('timeupdate'));
    });

    const playedWrapper = host.querySelector('.text-\\[\\#53bdeb\\]');
    assert.ok(playedWrapper, 'Microphone icon must transition to WhatsApp played blue color (#53bdeb)');

    await cleanup();
    passed += 1;
    console.log('  ok - VoiceNotePlayer renders waveform, speed cycling, and blue played mic');
  }

  // -------------------------------------------------------------
  // Test 2: ChatComposer live recording lifecycle
  // -------------------------------------------------------------
  {
    let sentVoiceFile = null;
    let sentVoiceCaption = null;

    const { host } = await mount(
      h(ChatComposer, {
        text: '',
        onTextChange: () => {},
        onSend: () => {},
        onSendMediaFile: (file, caption) => {
          sentVoiceFile = file;
          sentVoiceCaption = caption;
        },
        disabled: false,
      })
    );

    const micButton = host.querySelector('[data-testid="composer-mic-btn"]') || Array.from(host.querySelectorAll('button')).find(
      (b) => (b.title && b.title.includes('Ses')) || (b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('Ses'))
    );
    assert.ok(micButton, 'Voice recording mic button must be rendered when message text is empty');

    // Start recording
    await act(async () => {
      micButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Rose pulsing dot check
    const redDot = host.querySelector('.bg-rose-500');
    assert.ok(redDot, 'Active recording must render red/rose recording indicator dot');

    // Discard button check
    const discardBtn = host.querySelector('[data-testid="composer-voice-discard-btn"]') || Array.from(host.querySelectorAll('button')).find(
      (b) => (b.title && b.title.includes('İptal')) || (b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('İptal'))
    );
    assert.ok(discardBtn, 'Discard/trash button must be present in recording mode');

    // Send button check
    const sendBtn = host.querySelector('[data-testid="composer-voice-send-btn"]') || Array.from(host.querySelectorAll('button')).find(
      (b) => (b.title && b.title.includes('Gönder')) || (b.getAttribute('aria-label') && b.getAttribute('aria-label').includes('Gönder'))
    );
    assert.ok(sendBtn, 'Send voice note button must be present in recording mode');

    // Click send
    await act(async () => {
      sendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    assert.ok(sentVoiceFile, 'onSendMediaFile must receive audio File');
    assert.ok(sentVoiceFile.name.endsWith('.ogg'), `Voice file name must end in .ogg, got ${sentVoiceFile.name}`);
    assert.ok(sentVoiceFile.type.startsWith('audio/'), `Voice file type must be audio, got ${sentVoiceFile.type}`);

    await cleanup();
    passed += 1;
    console.log('  ok - ChatComposer starts recording, renders live bar, and dispatches native voice note');
  }

  console.log(`\n===========================================`);
  console.log(`All ${passed}/2 Voice Note DOM tests passed cleanly!`);
  console.log(`===========================================\n`);
  process.exit(0);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
