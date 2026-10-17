/**
 * WhatsApp Audio & Inbound Notification Service
 *
 * Provides synthesized high-fidelity notification tones using the HTML5 Web Audio API.
 * - Zero network dependencies (never fails due to 404, CORS or offline conditions).
 * - Instant sub-millisecond audio playback.
 * - Built-in unlock handler for browser autoplay policies.
 * - Anti-cacophony throttling to prevent sound storms during rapid incoming messages.
 * - Desktop Web Notification support when tab is in background.
 */

export type SoundPresetId = 'whatsapp_classic' | 'modern_pop' | 'crystal_bell' | 'marimba' | 'subtle_ping';

export interface SoundPresetMeta {
  id: SoundPresetId;
  nameKey: string;
  descKey: string;
}

export const SOUND_PRESETS: SoundPresetMeta[] = [
  {
    id: 'whatsapp_classic',
    nameKey: 'whatsapp.soundClassic',
    descKey: 'whatsapp.soundClassicDesc',
  },
  {
    id: 'modern_pop',
    nameKey: 'whatsapp.soundPop',
    descKey: 'whatsapp.soundPopDesc',
  },
  {
    id: 'crystal_bell',
    nameKey: 'whatsapp.soundBell',
    descKey: 'whatsapp.soundBellDesc',
  },
  {
    id: 'marimba',
    nameKey: 'whatsapp.soundMarimba',
    descKey: 'whatsapp.soundMarimbaDesc',
  },
  {
    id: 'subtle_ping',
    nameKey: 'whatsapp.soundPing',
    descKey: 'whatsapp.soundPingDesc',
  },
];

let audioCtx: AudioContext | null = null;
let lastPlayedAt = 0;
const THROTTLE_WINDOW_MS = 600;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch (err) {
    console.warn('[WhatsApp Audio] Web Audio API initialization failed:', err);
    return null;
  }
}

/**
 * Attaches a one-time user gesture listener to automatically unlock AudioContext.
 */
export function initAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
  };
  window.addEventListener('click', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
  return () => {
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

/**
 * Synthesizes and plays a notification sound preset at the specified volume.
 */
export function playSoundPreset(presetId: SoundPresetId = 'whatsapp_classic', volume = 0.8): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const safeVol = Math.max(0, Math.min(1, volume));
  if (safeVol <= 0) return;

  const now = ctx.currentTime;
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(safeVol, now);
  masterGain.connect(ctx.destination);

  switch (presetId) {
    case 'whatsapp_classic': {
      // Classic high two-tone WhatsApp chime (G#5 -> C6)
      // Tone 1: 830.6 Hz
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(830.61, now);
      gain1.gain.setValueAtTime(0.0001, now);
      gain1.gain.exponentialRampToValueAtTime(0.4, now + 0.015);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc1.connect(gain1);
      gain1.connect(masterGain);
      osc1.start(now);
      osc1.stop(now + 0.13);

      // Tone 2: 1046.5 Hz (starts at +0.08s)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1046.5, now + 0.08);
      gain2.gain.setValueAtTime(0.0001, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.55, now + 0.095);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      osc2.connect(gain2);
      gain2.connect(masterGain);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.46);

      // Subtle harmonic overtone (2093 Hz)
      const oscHarm = ctx.createOscillator();
      const gainHarm = ctx.createGain();
      oscHarm.type = 'sine';
      oscHarm.frequency.setValueAtTime(2093, now + 0.08);
      gainHarm.gain.setValueAtTime(0.0001, now + 0.08);
      gainHarm.gain.exponentialRampToValueAtTime(0.1, now + 0.095);
      gainHarm.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      oscHarm.connect(gainHarm);
      gainHarm.connect(masterGain);
      oscHarm.start(now + 0.08);
      oscHarm.stop(now + 0.36);
      break;
    }

    case 'modern_pop': {
      // Modern bubble pop (frequency ramp 350Hz -> 900Hz -> 200Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(920, now + 0.04);
      osc.frequency.exponentialRampToValueAtTime(240, now + 0.14);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.6, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.17);
      break;
    }

    case 'crystal_bell': {
      // Pure crystalline chime with long decay
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1174.66, now); // D6
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.5, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

      const overtone = ctx.createOscillator();
      const gainOver = ctx.createGain();
      overtone.type = 'triangle';
      overtone.frequency.setValueAtTime(2349.32, now); // D7
      gainOver.gain.setValueAtTime(0.001, now);
      gainOver.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
      gainOver.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

      osc.connect(gain);
      gain.connect(masterGain);
      overtone.connect(gainOver);
      gainOver.connect(masterGain);

      osc.start(now);
      osc.stop(now + 0.56);
      overtone.start(now);
      overtone.stop(now + 0.46);
      break;
    }

    case 'marimba': {
      // Acoustic marimba strike (C5 at 0ms, E5 at 60ms)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(523.25, now);
      gain1.gain.setValueAtTime(0.5, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.connect(gain1);
      gain1.connect(masterGain);
      osc1.start(now);
      osc1.stop(now + 0.16);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(659.25, now + 0.06);
      gain2.gain.setValueAtTime(0.0001, now + 0.06);
      gain2.gain.exponentialRampToValueAtTime(0.55, now + 0.065);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.connect(gain2);
      gain2.connect(masterGain);
      osc2.start(now + 0.06);
      osc2.stop(now + 0.29);
      break;
    }

    case 'subtle_ping': {
      // Minimalist soft sine ping
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(700, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(now);
      osc.stop(now + 0.1);
      break;
    }
  }
}

/**
 * SVG Data URI for crisp WhatsApp notification badge (zero network dependency).
 */
export const WHATSAPP_NOTIFICATION_ICON =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="%2325D366"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-5.46-4.45-9.92-9.91-9.92z"/><path fill="%23ffffff" d="M17.5 14.4c-.2-.1-1.3-.7-1.5-.7-.2-.1-.4-.1-.5.1-.2.2-.6.7-.8.9-.2.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.6-1.5-1.9-.2-.3 0-.4.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.3 0-.5-.1-.1-.5-1.3-.7-1.8-.2-.5-.4-.4-.5-.4h-.5c-.2 0-.5.1-.7.3-.2.3-1 1-1 2.4s1 2.8 1.2 3c.2.2 2 3.1 4.9 4.3 2.9 1.2 2.9.8 3.4.8.5 0 1.6-.7 1.8-1.3.2-.7.2-1.2.1-1.4-.1-.2-.3-.3-.5-.4z"/></svg>';

/**
 * Fires a desktop notification with macOS Notification Center support.
 */
export async function showDesktopNotification(options: {
  title: string;
  body?: string;
  tag?: string;
  onClick?: () => void;
}): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }
  try {
    const title = options.title || 'WhatsApp';
    const body = options.body ? (options.body.length > 120 ? `${options.body.slice(0, 117)}...` : options.body) : 'Yeni mesaj';
    const tag = options.tag || `wa-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const notif = new Notification(title, {
      body,
      icon: WHATSAPP_NOTIFICATION_ICON,
      badge: WHATSAPP_NOTIFICATION_ICON,
      tag,
      silent: false,
    });

    notif.onclick = () => {
      try {
        window.focus();
      } catch (_) {}
      if (options.onClick) {
        options.onClick();
      } else {
        window.dispatchEvent(new CustomEvent('tezlify:navigate_tab', { detail: { tab: 'whatsapp' } }));
      }
      notif.close();
    };

    notif.onerror = (e) => {
      console.warn('[WhatsApp Audio] Desktop notification dispatch error:', e);
    };

    return true;
  } catch (err) {
    console.warn('[WhatsApp Audio] Desktop notification failed to construct:', err);
    return false;
  }
}

/**
 * Triggers an inbound message alert with anti-cacophony throttling.
 */
export function triggerInboundNotification(params: {
  soundEnabled: boolean;
  soundPreset: SoundPresetId;
  soundVolume: number;
  desktopNotificationsEnabled?: boolean;
  senderName?: string;
  body?: string;
  forceDesktopNotification?: boolean;
}): void {
  const now = Date.now();
  if (!params.forceDesktopNotification && now - lastPlayedAt < THROTTLE_WINDOW_MS) {
    return; // Throttled
  }
  lastPlayedAt = now;

  // 1. Play audio if enabled
  if (params.soundEnabled) {
    try {
      playSoundPreset(params.soundPreset, params.soundVolume);
    } catch (e) {
      console.warn('[WhatsApp Audio] Failed to play notification sound:', e);
    }
  }

  // 2. Desktop Notification
  const canSendDesktop =
    params.forceDesktopNotification ||
    (params.desktopNotificationsEnabled &&
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'granted');

  if (canSendDesktop) {
    const title = params.senderName || 'WhatsApp';
    const body = params.body ? (params.body.length > 80 ? `${params.body.slice(0, 77)}...` : params.body) : 'Yeni mesaj';

    void showDesktopNotification({
      title,
      body,
    });
  }
}
