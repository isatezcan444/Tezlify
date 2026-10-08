/**
 * Tezlify WhatsApp Media Playback Coordinator
 *
 * Ensures strict single-active-media invariant across WhatsApp chats:
 * - Playing an inline video automatically pauses any other video or audio message.
 * - Playing a voice note / audio automatically pauses any other audio or video message.
 * - Opening a media lightbox automatically pauses background video and audio playback.
 * - Closing a media lightbox immediately stops lightbox playback and syncs progress back.
 * - Solves dual/overlapping audio & video playback issues.
 */

export interface MediaEntry {
  id: string;
  element?: HTMLMediaElement | null;
  onPause?: () => void;
}

const registeredMedia = new Map<string, MediaEntry>();
let activeMediaId: string | null = null;

export const MEDIA_PLAY_EVENT = 'tezlify:whatsapp:media-play';
export const MEDIA_PAUSE_ALL_EVENT = 'tezlify:whatsapp:media-pause-all';

/**
 * Register a media element (video/audio) or custom player with the coordinator.
 * Returns an unregister function to call on unmount.
 */
export function registerMedia(
  id: string,
  element?: HTMLMediaElement | null,
  onPause?: () => void
): () => void {
  registeredMedia.set(id, { id, element, onPause });

  return () => {
    const existing = registeredMedia.get(id);
    if (existing && (!element || existing.element === element)) {
      registeredMedia.delete(id);
    }
    if (activeMediaId === id) {
      activeMediaId = null;
    }
  };
}

/**
 * Update the registered DOM element for an existing media ID.
 */
export function updateRegisteredMediaElement(
  id: string,
  element: HTMLMediaElement | null
): void {
  const existing = registeredMedia.get(id);
  if (existing) {
    existing.element = element;
  }
}

/**
 * Notify the coordinator that a media element has started playing.
 * Automatically pauses all other registered media elements.
 */
export function notifyMediaPlaying(
  id: string,
  element?: HTMLMediaElement | null
): void {
  activeMediaId = id;

  if (element) {
    const existing = registeredMedia.get(id);
    if (existing) {
      existing.element = element;
    } else {
      registeredMedia.set(id, { id, element });
    }
  }

  // Immediately pause all other registered media elements
  for (const [otherId, entry] of registeredMedia.entries()) {
    if (otherId !== id) {
      try {
        if (entry.element && !entry.element.paused) {
          entry.element.pause();
        }
        entry.onPause?.();
      } catch {
        // Tolerates detached elements
      }
    }
  }

  // Dispatch custom window event for decoupled subscribers
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(MEDIA_PLAY_EVENT, { detail: { id } })
    );
  }
}

/**
 * Pause all playing media across WhatsApp (except optional exempt ID).
 */
export function pauseAllMedia(exceptId?: string): void {
  for (const [id, entry] of registeredMedia.entries()) {
    if (id !== exceptId) {
      try {
        if (entry.element && !entry.element.paused) {
          entry.element.pause();
        }
        entry.onPause?.();
      } catch {
        // Tolerates detached elements
      }
    }
  }

  if (activeMediaId && activeMediaId !== exceptId) {
    activeMediaId = null;
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(MEDIA_PAUSE_ALL_EVENT, { detail: { exceptId } })
    );
  }
}

/**
 * Check if a specific media ID is currently active.
 */
export function isMediaActive(id: string): boolean {
  return activeMediaId === id;
}

/**
 * Return currently active media ID (if any).
 */
export function getActiveMediaId(): string | null {
  return activeMediaId;
}
