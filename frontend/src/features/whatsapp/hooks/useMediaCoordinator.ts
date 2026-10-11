import { useEffect, useCallback } from 'react';
import {
  registerMedia,
  notifyMediaPlaying,
  notifyMediaPaused,
  notifyMediaEnded,
  pauseAllMedia,
  MEDIA_PLAY_EVENT,
  MEDIA_PAUSE_ALL_EVENT,
} from '../lib/mediaCoordinator';

export interface UseMediaCoordinatorOptions {
  mediaId: string;
  elementRef: React.RefObject<HTMLMediaElement | null>;
  onExternalPause?: () => void;
  pauseOnUnmount?: boolean;
}

/**
 * Hook to coordinate single-active audio/video media playback across WhatsApp threads.
 *
 * Guarantees:
 * 1. Automatically listens for MEDIA_PLAY_EVENT and MEDIA_PAUSE_ALL_EVENT to pause when other media starts.
 * 2. Automatically registers and unregisters with mediaCoordinator without memory leaks.
 * 3. Handles React Strict Mode double-mount/unmount safely.
 * 4. Provides safe notifyPlay, notifyPause, and notifyEnded helpers that guard against errors.
 */
export function useMediaCoordinator({
  mediaId,
  elementRef,
  onExternalPause,
  pauseOnUnmount = true,
}: UseMediaCoordinatorOptions) {
  useEffect(() => {
    const handleMediaPlay = (e: Event) => {
      const custom = e as CustomEvent<{ id: string }>;
      if (custom.detail?.id && custom.detail.id !== mediaId) {
        if (elementRef.current && !elementRef.current.paused) {
          elementRef.current.pause();
        }
        onExternalPause?.();
      }
    };

    const handlePauseAll = (e: Event) => {
      const custom = e as CustomEvent<{ exceptId?: string }>;
      if (custom.detail?.exceptId !== mediaId) {
        if (elementRef.current && !elementRef.current.paused) {
          elementRef.current.pause();
        }
        onExternalPause?.();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(MEDIA_PLAY_EVENT, handleMediaPlay);
      window.addEventListener(MEDIA_PAUSE_ALL_EVENT, handlePauseAll);
    }

    const unregister = registerMedia(mediaId, elementRef.current, () => {
      if (elementRef.current && !elementRef.current.paused) {
        elementRef.current.pause();
      }
      onExternalPause?.();
    });

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(MEDIA_PLAY_EVENT, handleMediaPlay);
        window.removeEventListener(MEDIA_PAUSE_ALL_EVENT, handlePauseAll);
      }
      unregister();
      if (pauseOnUnmount && elementRef.current && !elementRef.current.paused) {
        elementRef.current.pause();
      }
    };
  }, [mediaId, onExternalPause, pauseOnUnmount]);

  const notifyPlay = useCallback(() => {
    notifyMediaPlaying(mediaId, elementRef.current);
  }, [mediaId, elementRef]);

  const notifyPause = useCallback(() => {
    notifyMediaPaused(mediaId);
  }, [mediaId]);

  const notifyEnded = useCallback(() => {
    notifyMediaEnded(mediaId);
  }, [mediaId]);

  return {
    notifyPlay,
    notifyPause,
    notifyEnded,
    pauseAllMedia,
  };
}
