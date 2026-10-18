import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Message } from '../../../types';
import {
  filterMatchingMessageIds,
  resolveActiveSearchMessageId,
  getNextSearchMatchIndex,
  getPrevSearchMatchIndex,
  findMessageIdByDate,
} from '../lib/whatsappChatSearch';

export interface UseChatSearchOptions {
  selectedConvId?: number;
  messages?: Message[];
}

export interface UseChatSearchResult {
  isChatSearchOpen: boolean;
  setIsChatSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isSearchResultsDrawerOpen: boolean;
  setIsSearchResultsDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleSearchResultsDrawer: () => void;
  chatSearchQuery: string;
  setChatSearchQuery: (query: string) => void;
  chatSearchCurrentIndex: number;
  setChatSearchCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  matchingMessageIds: number[];
  activeSearchMessageId: number | null;
  handleNextSearchMatch: () => void;
  handlePrevSearchMatch: () => void;
  jumpToMessageId: (messageId: number) => void;
  jumpToDate: (dateStr: string) => number | null;
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
  const [isSearchResultsDrawerOpen, setIsSearchResultsDrawerOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchCurrentIndex, setChatSearchCurrentIndex] = useState(0);
  const [selectedMessageOverride, setSelectedMessageOverride] = useState<number | null>(null);

  const resetSearch = useCallback(() => {
    setIsChatSearchOpen(false);
    setIsSearchResultsDrawerOpen(false);
    setChatSearchQuery('');
    setChatSearchCurrentIndex(0);
    setSelectedMessageOverride(null);
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
        setIsChatSearchOpen((open) => {
          if (open) {
            setIsSearchResultsDrawerOpen(false);
          }
          return !open;
        });
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
    if (selectedMessageOverride != null) {
      return selectedMessageOverride;
    }
    return resolveActiveSearchMessageId(matchingMessageIds, chatSearchCurrentIndex);
  }, [selectedMessageOverride, matchingMessageIds, chatSearchCurrentIndex]);

  const handleNextSearchMatch = useCallback(() => {
    setSelectedMessageOverride(null);
    setChatSearchCurrentIndex((prev) => getNextSearchMatchIndex(matchingMessageIds.length, prev));
  }, [matchingMessageIds.length]);

  const handlePrevSearchMatch = useCallback(() => {
    setSelectedMessageOverride(null);
    setChatSearchCurrentIndex((prev) => getPrevSearchMatchIndex(matchingMessageIds.length, prev));
  }, [matchingMessageIds.length]);

  const jumpToMessageId = useCallback((messageId: number) => {
    setSelectedMessageOverride(messageId);
    const idx = matchingMessageIds.indexOf(messageId);
    if (idx !== -1) {
      setChatSearchCurrentIndex(idx);
    }
  }, [matchingMessageIds]);

  const jumpToDate = useCallback((dateStr: string): number | null => {
    if (!messages || messages.length === 0) return null;
    const targetId = findMessageIdByDate(messages, dateStr);
    if (targetId != null) {
      setSelectedMessageOverride(targetId);
      const idx = matchingMessageIds.indexOf(targetId);
      if (idx !== -1) {
        setChatSearchCurrentIndex(idx);
      }
      return targetId;
    }
    return null;
  }, [messages, matchingMessageIds]);

  const toggleSearchResultsDrawer = useCallback(() => {
    setIsSearchResultsDrawerOpen((prev) => !prev);
  }, []);

  return {
    isChatSearchOpen,
    setIsChatSearchOpen,
    isSearchResultsDrawerOpen,
    setIsSearchResultsDrawerOpen,
    toggleSearchResultsDrawer,
    chatSearchQuery,
    setChatSearchQuery: (q: string) => {
      setSelectedMessageOverride(null);
      setChatSearchQuery(q);
      setChatSearchCurrentIndex(0);
    },
    chatSearchCurrentIndex,
    setChatSearchCurrentIndex,
    matchingMessageIds,
    activeSearchMessageId,
    handleNextSearchMatch,
    handlePrevSearchMatch,
    jumpToMessageId,
    jumpToDate,
    resetSearch,
  };
}

