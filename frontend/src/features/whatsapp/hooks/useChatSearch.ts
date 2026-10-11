import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Message } from '../../../types';
import {
  filterMatchingMessageIds,
  resolveActiveSearchMessageId,
  getNextSearchMatchIndex,
  getPrevSearchMatchIndex,
} from '../lib/whatsappChatSearch';

export interface UseChatSearchOptions {
  selectedConvId?: number;
  messages?: Message[];
}

export interface UseChatSearchResult {
  isChatSearchOpen: boolean;
  setIsChatSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  chatSearchQuery: string;
  setChatSearchQuery: (query: string) => void;
  chatSearchCurrentIndex: number;
  setChatSearchCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  matchingMessageIds: number[];
  activeSearchMessageId: number | null;
  handleNextSearchMatch: () => void;
  handlePrevSearchMatch: () => void;
  resetSearch: () => void;
}

/**
 * Custom hook encapsulating in-thread search state and navigation for WhatsApp.
 * Extracted from WhatsAppHubPage as part of Phase 2.1 safe micro-refactoring.
 */
export function useChatSearch({
  selectedConvId,
  messages,
}: UseChatSearchOptions): UseChatSearchResult {
  const [isChatSearchOpen, setIsChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchCurrentIndex, setChatSearchCurrentIndex] = useState(0);

  const resetSearch = useCallback(() => {
    setIsChatSearchOpen(false);
    setChatSearchQuery('');
    setChatSearchCurrentIndex(0);
  }, []);

  // Reset search state whenever selected conversation changes
  useEffect(() => {
    resetSearch();
  }, [selectedConvId, resetSearch]);

  // Global Ctrl+F / Cmd+F keyboard shortcut to toggle search when a conversation is active
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && selectedConvId) {
        e.preventDefault();
        setIsChatSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedConvId]);

  const matchingMessageIds = useMemo(() => {
    if (!selectedConvId || !messages || messages.length === 0) {
      return [];
    }
    return filterMatchingMessageIds(messages, chatSearchQuery);
  }, [selectedConvId, messages, chatSearchQuery]);

  const activeSearchMessageId = useMemo(() => {
    return resolveActiveSearchMessageId(matchingMessageIds, chatSearchCurrentIndex);
  }, [matchingMessageIds, chatSearchCurrentIndex]);

  const handleNextSearchMatch = useCallback(() => {
    setChatSearchCurrentIndex((prev) => getNextSearchMatchIndex(matchingMessageIds.length, prev));
  }, [matchingMessageIds.length]);

  const handlePrevSearchMatch = useCallback(() => {
    setChatSearchCurrentIndex((prev) => getPrevSearchMatchIndex(matchingMessageIds.length, prev));
  }, [matchingMessageIds.length]);

  return {
    isChatSearchOpen,
    setIsChatSearchOpen,
    chatSearchQuery,
    setChatSearchQuery,
    chatSearchCurrentIndex,
    setChatSearchCurrentIndex,
    matchingMessageIds,
    activeSearchMessageId,
    handleNextSearchMatch,
    handlePrevSearchMatch,
    resetSearch,
  };
}
