import { useState, useEffect, useCallback, useMemo } from 'react';
import { QuickReply } from '../../../types';
import {
  filterQuickReplies,
  extractQuickReplyCategories,
  resolveQuickReplyVariables,
  renderQuickReplyContent,
} from '../lib/whatsappQuickReplies';

export interface UseQuickReplyComposerOptions {
  selectedConvId?: number | string | null;
}

export interface StagedComposerText {
  text: string;
  timestamp: number;
}

/**
 * Hook for managing quick reply modal visibility and composer text staging in WhatsAppHubPage.
 * Ensures strict conversation isolation by resetting staged text when selected conversation changes.
 */
export function useQuickReplyComposer(options: UseQuickReplyComposerOptions = {}) {
  const { selectedConvId } = options;
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [insertedComposerText, setInsertedComposerText] = useState<StagedComposerText | null>(null);

  // Synchronous state derivation on conversation switch: ensures newly mounted ChatComposer
  // receives null insertedComposerText on the very first render without waiting for useEffect.
  const [prevConvId, setPrevConvId] = useState(selectedConvId);
  if (selectedConvId !== prevConvId) {
    setPrevConvId(selectedConvId);
    setInsertedComposerText(null);
  }

  // Clear inserted composer text when switching conversations to prevent cross-chat leakage
  useEffect(() => {
    setInsertedComposerText(null);
  }, [selectedConvId]);

  const openQuickReplyModal = useCallback(() => {
    setIsTemplateModalOpen(true);
  }, []);

  const closeQuickReplyModal = useCallback(() => {
    setIsTemplateModalOpen(false);
  }, []);

  const clearInsertedComposerText = useCallback(() => {
    setInsertedComposerText(null);
  }, []);

  const handleSelectTemplate = useCallback((renderedText: string) => {
    setInsertedComposerText({ text: renderedText, timestamp: Date.now() });
    setIsTemplateModalOpen(false);
  }, []);

  return {
    isTemplateModalOpen,
    setIsTemplateModalOpen,
    openQuickReplyModal,
    closeQuickReplyModal,
    insertedComposerText,
    setInsertedComposerText,
    clearInsertedComposerText,
    handleSelectTemplate,
  };
}

export interface UseQuickReplySelectionOptions {
  quickReplies: QuickReply[];
  leadName?: string;
  initialSelectedId?: number | null;
}

/**
 * Hook for managing quick reply searching, filtering, selection, and variable resolution
 * within modal or quick reply pickers.
 */
export function useQuickReplySelection(options: UseQuickReplySelectionOptions) {
  const { quickReplies, leadName = '', initialSelectedId = null } = options;

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  const [variables, setVariables] = useState<Record<string, string>>({});

  // When quick replies load or change, auto-select first if none selected
  useEffect(() => {
    if (quickReplies.length > 0 && selectedId === null) {
      const first = quickReplies[0];
      setSelectedId(first.id);
      setVariables(resolveQuickReplyVariables(first, leadName));
    }
  }, [quickReplies, selectedId, leadName]);

  const categories = useMemo(() => {
    return extractQuickReplyCategories(quickReplies);
  }, [quickReplies]);

  const filteredQuickReplies = useMemo(() => {
    return filterQuickReplies(quickReplies, searchQuery, selectedCategory);
  }, [quickReplies, searchQuery, selectedCategory]);

  const selectedQr = useMemo(() => {
    return quickReplies.find((qr) => qr.id === selectedId) || null;
  }, [quickReplies, selectedId]);

  const selectQuickReply = useCallback(
    (qr: QuickReply) => {
      setSelectedId(qr.id);
      setVariables(resolveQuickReplyVariables(qr, leadName));
    },
    [leadName]
  );

  const getRenderedContent = useCallback(
    (qr: QuickReply | null = selectedQr) => {
      return renderQuickReplyContent(qr, variables, leadName);
    },
    [selectedQr, variables, leadName]
  );

  const resetSelectionState = useCallback(() => {
    setSearchQuery('');
    setSelectedCategory('ALL');
    if (quickReplies.length > 0) {
      setSelectedId(quickReplies[0].id);
      setVariables(resolveQuickReplyVariables(quickReplies[0], leadName));
    } else {
      setSelectedId(null);
      setVariables({});
    }
  }, [quickReplies, leadName]);

  return {
    searchQuery,
    setSearchQuery,
    selectedCategory,
    setSelectedCategory,
    selectedId,
    setSelectedId,
    variables,
    setVariables,
    categories,
    filteredQuickReplies,
    selectedQr,
    selectQuickReply,
    getRenderedContent,
    resetSelectionState,
  };
}
