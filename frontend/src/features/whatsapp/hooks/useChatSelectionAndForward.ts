import { useState, useEffect, useCallback } from 'react';
import { Message } from '../../../types';
import {
  toggleSelectedMessageId,
  resolveSelectedMessages,
} from '../lib/whatsappChatSelection';

export interface UseChatSelectionAndForwardOptions {
  selectedConvId?: number | string | null;
}

/**
 * Hook for managing multi-message selection and forwarding coordination in WhatsApp chat thread.
 *
 * Guarantees:
 * 1. Synchronous state reset on conversation switch prevents any cross-chat message ID leakage.
 * 2. Strict chronological ordering is preserved when resolving selected messages.
 * 3. Atomic toggle and clear operations for select mode and forward modal.
 */
export function useChatSelectionAndForward(options: UseChatSelectionAndForwardOptions = {}) {
  const { selectedConvId } = options;

  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number | string>>(new Set());
  const [isForwardModalOpen, setIsForwardModalOpen] = useState<boolean>(false);
  const [messagesToForward, setMessagesToForward] = useState<Message[]>([]);

  // Synchronous state derivation on conversation switch:
  // If the user navigates from Chat A to Chat B, reset all selection and forward states
  // immediately during render, before child components render or effects fire.
  const [prevConvId, setPrevConvId] = useState(selectedConvId);
  if (selectedConvId !== prevConvId) {
    setPrevConvId(selectedConvId);
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
    setIsForwardModalOpen(false);
    setMessagesToForward([]);
  }

  // Effect-level safety cleanup on conversation switch
  useEffect(() => {
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
    setIsForwardModalOpen(false);
    setMessagesToForward([]);
  }, [selectedConvId]);

  const enterSelectMode = useCallback((initialMessageId?: number | string) => {
    setIsSelectMode(true);
    if (initialMessageId != null) {
      setSelectedMessageIds(new Set([initialMessageId]));
    }
  }, []);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const toggleSelectMode = useCallback(() => {
    setIsSelectMode((prev) => {
      if (prev) {
        setSelectedMessageIds(new Set());
      }
      return !prev;
    });
  }, []);

  const toggleSelectMessage = useCallback((messageId: number | string) => {
    setSelectedMessageIds((prev) => toggleSelectedMessageId(prev, messageId));
  }, []);

  const openForwardSingleMessage = useCallback((msg: Message) => {
    setMessagesToForward([msg]);
    setIsForwardModalOpen(true);
  }, []);

  const openForwardSelectedMessages = useCallback(
    (currentMessages: Message[] | undefined): boolean => {
      const msgs = resolveSelectedMessages(currentMessages, selectedMessageIds);
      if (msgs.length === 0) {
        return false;
      }
      setMessagesToForward(msgs);
      setIsForwardModalOpen(true);
      return true;
    },
    [selectedMessageIds]
  );

  const closeForwardModal = useCallback(() => {
    setIsForwardModalOpen(false);
    setMessagesToForward([]);
  }, []);

  const clearSelection = useCallback(() => {
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const resetSelectionAndForward = useCallback(() => {
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
    setIsForwardModalOpen(false);
    setMessagesToForward([]);
  }, []);

  return {
    isSelectMode,
    setIsSelectMode,
    selectedMessageIds,
    setSelectedMessageIds,
    isForwardModalOpen,
    setIsForwardModalOpen,
    messagesToForward,
    setMessagesToForward,
    enterSelectMode,
    exitSelectMode,
    toggleSelectMode,
    toggleSelectMessage,
    openForwardSingleMessage,
    openForwardSelectedMessages,
    closeForwardModal,
    clearSelection,
    resetSelectionAndForward,
  };
}
