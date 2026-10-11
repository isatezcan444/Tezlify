import { useState, useRef, useEffect, useCallback } from 'react';

export interface UseMessageReactionsOptions {
  messageId: number | string;
  canReact?: boolean;
  onReact?: (messageId: number | string, emoji: string) => Promise<void> | void;
  isSelectMode?: boolean;
}

/**
 * Hook for managing WhatsApp message reaction affordances (quick reaction bar & emoji picker modal).
 *
 * Guarantees:
 * 1. Closes reaction bar and picker when multi-select mode is activated.
 * 2. Auto-closes reaction bar when clicking or tapping outside.
 * 3. Prevents duplicate reaction requests while an async reaction mutation is in flight (`reacting`).
 * 4. Logs any reaction failure while safely releasing the lock.
 */
export function useMessageReactions({
  messageId,
  canReact = true,
  onReact,
  isSelectMode = false,
}: UseMessageReactionsOptions) {
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const reactionBarRef = useRef<HTMLDivElement | null>(null);

  // Close reaction affordances if selection mode is turned on
  useEffect(() => {
    if (isSelectMode) {
      setIsReactionBarOpen(false);
      setIsPickerOpen(false);
    }
  }, [isSelectMode]);

  // Click / touch outside closes the quick reaction bar
  useEffect(() => {
    if (!isReactionBarOpen) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!reactionBarRef.current) return;
      if (!reactionBarRef.current.contains(e.target as Node)) {
        setIsReactionBarOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [isReactionBarOpen]);

  const openReactionBar = useCallback(() => {
    setIsReactionBarOpen(true);
  }, []);

  const closeReactionBar = useCallback(() => {
    setIsReactionBarOpen(false);
  }, []);

  const toggleReactionBar = useCallback(() => {
    setIsReactionBarOpen((open) => !open);
  }, []);

  const openPicker = useCallback(() => {
    setIsReactionBarOpen(false);
    setIsPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => {
    setIsPickerOpen(false);
  }, []);

  const handleReact = useCallback(
    async (emoji: string) => {
      if (!canReact || !onReact || reacting) return;
      setIsReactionBarOpen(false);
      setIsPickerOpen(false);
      setReacting(true);
      try {
        await onReact(messageId, emoji);
      } catch (err) {
        console.error('[ChatBubble] Reaction failed:', err);
      } finally {
        setReacting(false);
      }
    },
    [canReact, onReact, reacting, messageId]
  );

  return {
    isReactionBarOpen,
    setIsReactionBarOpen,
    isPickerOpen,
    setIsPickerOpen,
    reacting,
    reactionBarRef,
    openReactionBar,
    closeReactionBar,
    toggleReactionBar,
    openPicker,
    closePicker,
    handleReact,
  };
}
