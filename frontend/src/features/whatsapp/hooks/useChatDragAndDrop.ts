import { useState, useCallback, useRef, useEffect } from 'react';
import {
  type StagedFiles,
  hasDragFiles,
  isDragLeavingWindow,
  isDropCooldownActive,
  DRAG_OVER_WATCHDOG_MS,
} from '../lib/whatsappChatDragDrop';

export type { StagedFiles };

export interface UseChatDragAndDropOptions {
  selectedConvId?: number;
}

export interface UseChatDragAndDropResult {
  isChatDragOver: boolean;
  stagedComposerFiles: StagedFiles | null;
  setStagedComposerFiles: React.Dispatch<React.SetStateAction<StagedFiles | null>>;
  clearStagedFiles: () => void;
  resetChatDragState: () => void;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
}

/**
 * Custom hook managing drag-and-drop file staging, counter balance,
 * drop cooldown suppression, and window safety listeners.
 * Extracted from WhatsAppHubPage as part of Phase 2.2 safe micro-refactoring.
 */
export function useChatDragAndDrop({
  selectedConvId,
}: UseChatDragAndDropOptions = {}): UseChatDragAndDropResult {
  const [stagedComposerFiles, setStagedComposerFiles] = useState<StagedFiles | null>(null);
  const [isChatDragOver, setIsChatDragOver] = useState(false);
  const chatDragCounterRef = useRef(0);
  const lastDropTimestampRef = useRef(0);
  const dragoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const resetChatDragState = useCallback(() => {
    if (dragoverTimeoutRef.current) {
      clearTimeout(dragoverTimeoutRef.current);
      dragoverTimeoutRef.current = null;
    }
    chatDragCounterRef.current = 0;
    setIsChatDragOver(false);
  }, []);

  const clearStagedFiles = useCallback(() => {
    setStagedComposerFiles(null);
    resetChatDragState();
  }, [resetChatDragState]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragoverTimeoutRef.current) {
        clearTimeout(dragoverTimeoutRef.current);
        dragoverTimeoutRef.current = null;
      }
      lastDropTimestampRef.current = Date.now();
      resetChatDragState();
      const droppedFiles = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      if (droppedFiles.length > 0) {
        setStagedComposerFiles({ files: droppedFiles, timestamp: Date.now() });
      }
    },
    [resetChatDragState]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Ignore phantom drag events immediately after a drop or if files are already staged
      if (isDropCooldownActive(lastDropTimestampRef.current) || stagedComposerFiles) {
        return;
      }
      if (hasDragFiles(e.dataTransfer?.types)) {
        chatDragCounterRef.current++;
        setIsChatDragOver(true);
      }
    },
    [stagedComposerFiles]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      chatDragCounterRef.current--;
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
        resetChatDragState();
      } else if (chatDragCounterRef.current <= 0) {
        resetChatDragState();
      }
    },
    [resetChatDragState]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isDropCooldownActive(lastDropTimestampRef.current) || stagedComposerFiles) {
        if (isChatDragOver) resetChatDragState();
        return;
      }
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!isChatDragOver) {
        setIsChatDragOver(true);
      }
      if (dragoverTimeoutRef.current) {
        clearTimeout(dragoverTimeoutRef.current);
      }
      dragoverTimeoutRef.current = setTimeout(() => {
        resetChatDragState();
      }, DRAG_OVER_WATCHDOG_MS);
    },
    [isChatDragOver, stagedComposerFiles, resetChatDragState]
  );

  // If files are staged, drag-over overlay must never remain active
  useEffect(() => {
    if (stagedComposerFiles) {
      resetChatDragState();
    }
  }, [stagedComposerFiles, resetChatDragState]);

  // Reset staged files whenever selected conversation switches
  useEffect(() => {
    clearStagedFiles();
  }, [selectedConvId, clearStagedFiles]);

  // Window-level safety cleanup: ensures dropzone overlay never gets stuck
  // if user cancels drag (Escape), drops outside, or drops anywhere in the window.
  useEffect(() => {
    const handleGlobalDragLeave = (e: DragEvent) => {
      if (isDragLeavingWindow(e, window.innerWidth, window.innerHeight)) {
        resetChatDragState();
      }
    };
    const handleGlobalDrop = () => {
      lastDropTimestampRef.current = Date.now();
      resetChatDragState();
    };
    const handleGlobalDragEnd = () => {
      resetChatDragState();
    };
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resetChatDragState();
      }
    };

    window.addEventListener('dragleave', handleGlobalDragLeave);
    window.addEventListener('drop', handleGlobalDrop, true);
    window.addEventListener('dragend', handleGlobalDragEnd, true);
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('dragleave', handleGlobalDragLeave);
      window.removeEventListener('drop', handleGlobalDrop, true);
      window.removeEventListener('dragend', handleGlobalDragEnd, true);
      window.removeEventListener('keydown', handleGlobalKeyDown);
      if (dragoverTimeoutRef.current) {
        clearTimeout(dragoverTimeoutRef.current);
      }
    };
  }, [resetChatDragState]);

  return {
    isChatDragOver,
    stagedComposerFiles,
    setStagedComposerFiles,
    clearStagedFiles,
    resetChatDragState,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
}
