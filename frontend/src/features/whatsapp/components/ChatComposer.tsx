import { createSendLock } from '../lib/sendLock';
import { insertAtCaret } from '../lib/emojiData';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { 
  Send, 
  Lock, 
  Plus, 
  Paperclip, 
  Loader2, 
  LayoutTemplate, 
  Image as ImageIcon, 
  FileText, 
  RotateCcw,
  Smile,
  Sparkles,
  Mic,
  Music,
  Trash2,
  X,
  Zap,
  AtSign,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Avatar } from '../../../components/ui/Avatar';
import { Tooltip } from '../../../components/ui/Tooltip';
import { Modal } from '../../../components/ui/Modal';
import { EmojiPicker } from './EmojiPicker';
import { MediaSendModal } from './MediaSendModal';
import { AiSuggestPopover } from './AiSuggestPopover';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { QuickReply } from '../../../types';
import { WhatsAppRepository } from '../data/whatsappRepository';
import { filterQuickReplies, renderQuickReplyContent } from '../lib/whatsappQuickReplies';
import { formatPhoneNumber } from '../lib/whatsappIdentity';

export interface QuotedMessage {
  id: number | string;
  senderName?: string;
  body?: string;
  mediaType?: string;
}

export interface ChatComposerProps {
  conversationId?: number;
  onSend?: (text: string) => Promise<void> | void;
  onSendTemplate?: () => void;
  onSendMedia?: (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => Promise<void>;
  onSendMediaFile?: (file: File, caption?: string) => Promise<void>;
  onTyping?: (typing: boolean) => void;
  onReopenConversation?: () => void;
  disabled?: boolean;
  isClosed?: boolean;
  isWindowOpen?: boolean;
  placeholder?: string;
  leadName?: string;
  replyingTo?: QuotedMessage | null;
  onCancelReply?: () => void;
  insertedText?: { text: string; timestamp: number } | null;
  stagedFiles?: { files: File[]; timestamp: number } | null;
  onClearStagedFiles?: () => void;
  isGroup?: boolean;
  groupParticipants?: Array<{ id: string; name: string; phone?: string; is_me?: boolean; admin?: string }>;
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
  conversationId,
  onSend,
  onSendTemplate,
  onSendMedia,
  onSendMediaFile,
  onTyping,
  onReopenConversation,
  disabled = false,
  isClosed = false,
  isWindowOpen = true,
  placeholder,
  leadName,
  replyingTo,
  onCancelReply,
  insertedText,
  stagedFiles,
  onClearStagedFiles,
  isGroup = false,
  groupParticipants,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const draftInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const emojiContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [mediaModalType, setMediaModalType] = useState<'IMAGE' | 'DOCUMENT' | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaCaption, setMediaCaption] = useState('');
  const [mediaFilename, setMediaFilename] = useState('');
  const [sendingMedia, setSendingMedia] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState<number>(0);
  const [fileCaptions, setFileCaptions] = useState<Record<number, string>>({});
  const [sendingFiles, setSendingFiles] = useState(false);
  const [sendingIndex, setSendingIndex] = useState<number>(0);
  const [isFileModalOpen, setIsFileModalOpen] = useState(false);
  const [isAiOpen, setIsAiOpen] = useState(false);


  // Quick Replies (Canned Responses) Shortcut ('/') State
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [isQuickRepliesLoaded, setIsQuickRepliesLoaded] = useState<boolean>(false);
  const [quickReplyIndex, setQuickReplyIndex] = useState<number>(0);
  const [isQuickRepliesDismissed, setIsQuickRepliesDismissed] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    WhatsAppRepository.getQuickReplies()
      .then((data) => {
        if (active && Array.isArray(data)) {
          setQuickReplies(data);
          setIsQuickRepliesLoaded(true);
        }
      })
      .catch((err) => {
        console.warn('[ChatComposer] Failed to load quick replies for shortcut:', err);
      });
    return () => {
      active = false;
    };
  }, []);

  const isTypingShortcut = text.startsWith('/') && !isQuickRepliesDismissed;
  const shortcutQuery = isTypingShortcut ? text.slice(1) : '';
  const matchedQuickReplies = useMemo(() => {
    if (!isTypingShortcut || !isQuickRepliesLoaded) return [];
    return filterQuickReplies(quickReplies, shortcutQuery);
  }, [isTypingShortcut, isQuickRepliesLoaded, quickReplies, shortcutQuery]);

  useEffect(() => {
    setQuickReplyIndex(0);
  }, [shortcutQuery]);

  useEffect(() => {
    if (!text.startsWith('/')) {
      setIsQuickRepliesDismissed(false);
    }
  }, [text]);

  // Group Mention ('@') Autocomplete Logic
  const [isMentionDismissed, setIsMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const justSelectedMentionRef = useRef(false);

  const cursorMentionMatch = useMemo(() => {
    if (!isGroup || !groupParticipants || groupParticipants.length === 0 || justSelectedMentionRef.current) return null;
    const el = draftInputRef.current;
    const cursor = el ? el.selectionStart ?? text.length : text.length;
    const textBeforeCursor = text.slice(0, cursor);
    const match = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    return {
      query: match[1].toLowerCase(),
      atIndex: textBeforeCursor.lastIndexOf('@'),
      cursor,
    };
  }, [isGroup, groupParticipants, text]);

  const matchedMentions = useMemo(() => {
    if (!cursorMentionMatch || !groupParticipants || justSelectedMentionRef.current) return [];
    const q = cursorMentionMatch.query;
    return groupParticipants.filter((p) => {
      if (p.is_me) return false;
      if (!q) return true;
      const nameMatch = (p.name || '').toLowerCase().includes(q);
      const phoneDigits = (p.phone || '').replace(/\D/g, '');
      const phoneMatch = phoneDigits.includes(q);
      return nameMatch || phoneMatch;
    });
  }, [cursorMentionMatch, groupParticipants]);

  const isMentionActive = Boolean(
    !justSelectedMentionRef.current &&
    cursorMentionMatch &&
    matchedMentions.length > 0 &&
    !isMentionDismissed
  );

  useEffect(() => {
    setMentionIndex(0);
  }, [cursorMentionMatch?.query]);

  useEffect(() => {
    if (!cursorMentionMatch && !justSelectedMentionRef.current) {
      setIsMentionDismissed(false);
    }
  }, [cursorMentionMatch]);


  // Live Voice Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    if (disabled || isClosed || !isWindowOpen) return;

    // Check if insecure context (browsers block getUserMedia over non-HTTPS)
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      toast.error(t('whatsapp.micRequiresHttps'), t('common.error'));
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t('whatsapp.micPermissionDenied'), t('common.error'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      let mimeType = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
          mimeType = 'audio/aac';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus';
        } else {
          mimeType = '';
        }
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.start(250);
      setIsRecording(true);
      setRecordingDuration(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((s) => s + 1);
      }, 1000);
    } catch (err: any) {
      console.warn('[ChatComposer] Mic recording start error:', err);
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        toast.error(t('whatsapp.micPermissionInstruction'), t('common.error'));
      } else if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
        toast.error(t('whatsapp.micNotFound'), t('common.error'));
      } else {
        toast.error(t('whatsapp.micPermissionDenied'), t('common.error'));
      }
    }
  }, [disabled, isClosed, isWindowOpen, t, toast]);

  const cancelRecording = useCallback(() => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingDuration(0);
  }, []);

  const sendRecording = useCallback(async () => {
    if (!mediaRecorderRef.current) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    recorder.onstop = async () => {
      const chunks = audioChunksRef.current;
      if (chunks.length > 0) {
        const finalMime = recorder.mimeType || 'audio/mp4';
        let ext = 'm4a';
        if (finalMime.includes('webm')) ext = 'webm';
        else if (finalMime.includes('ogg')) ext = 'ogg';
        else if (finalMime.includes('mp4') || finalMime.includes('m4a') || finalMime.includes('aac')) ext = 'm4a';
        const blob = new Blob(chunks, { type: finalMime });
        const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: finalMime });
        if (onSendMediaFile) {
          try {
            await onSendMediaFile(file);
          } catch (err) {
            console.error('[ChatComposer] Send voice note error:', err);
          }
        }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];
      setIsRecording(false);
      setRecordingDuration(0);
    };

    if (recorder.state === 'recording') {
      try {
        recorder.requestData();
      } catch {}
    }
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [onSendMediaFile]);

  // Clean up streams on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Escape cancels recording
  useEffect(() => {
    if (!isRecording) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRecording, cancelRecording]);

  const [isEmojiOpen, setIsEmojiOpen] = useState(false);

  // Click / tap outside handler to auto-close emoji panel and attachment menu
  useEffect(() => {
    if (!isEmojiOpen && !isAttachMenuOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (isEmojiOpen && emojiContainerRef.current && !emojiContainerRef.current.contains(target)) {
        setIsEmojiOpen(false);
      }
      if (isAttachMenuOpen && attachMenuRef.current && !attachMenuRef.current.contains(target)) {
        setIsAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isEmojiOpen, isAttachMenuOpen]);

  const lastTypingSignalRef = useRef<number>(0);
  const typingActiveRef = useRef<boolean>(false);
  const onTypingRef = useRef<((typing: boolean) => void) | undefined>(onTyping);
  onTypingRef.current = onTyping;

  // WhatsApp Web benzeri 'yazıyor...' sinyali: en fazla her 4 sn'de bir
  // composing gonderir; duraklama veya gönderim sonrası paused sinyaller.
  const notifyTypingActivity = () => {
    if (!onTyping || isInputDisabledSafe()) return;
    const now = Date.now();
    if (!typingActiveRef.current || now - lastTypingSignalRef.current > 4000) {
      typingActiveRef.current = true;
      lastTypingSignalRef.current = now;
      onTyping(true);
    } else {
      lastTypingSignalRef.current = now;
    }
  };

  // Memoised because the pause timer below depends on it: without a stable
  // identity the 4s timer would be torn down and restarted on every render,
  // so the "typing" indicator could never actually stop.
  const stopTypingSignal = useCallback(() => {
    if (!onTyping) return;
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);

  const isInputDisabledSafe = () => disabled || isClosed || !isWindowOpen;

  // Yazmayı bırakınca (duraklama) karşı tarafa paused gönder
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => {
      if (typingActiveRef.current && Date.now() - lastTypingSignalRef.current >= 3500) {
        stopTypingSignal();
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [text, stopTypingSignal]);

  // Unmount / konuşma değişimi durumunda 'yazıyor' sinyali askıda kalmasın
  useEffect(() => {
    return () => {
      if (typingActiveRef.current && onTypingRef.current) {
        onTypingRef.current(false);
      }
    };
  }, []);

  // Synchronize externally staged files (e.g. dropped onto the chat thread or column)
  useEffect(() => {
    if (stagedFiles && stagedFiles.files && stagedFiles.files.length > 0 && onSendMediaFile) {
      setPendingFiles((prev) => (prev.length > 0 ? [...prev, ...stagedFiles.files] : stagedFiles.files));
      setActiveFileIndex(0);
      setIsFileModalOpen(true);
      onClearStagedFiles?.();
    }
  }, [stagedFiles, onSendMediaFile, onClearStagedFiles]);

  const openFilePicker = (accept: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files ? Array.from(e.target.files) : [];
    if (chosen.length === 0 || !onSendMediaFile) return;
    setPendingFiles((prev) => (prev.length > 0 ? [...prev, ...chosen] : chosen));
    setIsFileModalOpen(true);
  };

  // Helper to deduplicate files by name, size, and lastModified
  const deduplicateFiles = (existing: File[], incoming: File[]): File[] => {
    const result = [...existing];
    for (const inc of incoming) {
      const exists = result.some(
        (f) => f.name === inc.name && f.size === inc.size && f.lastModified === inc.lastModified
      );
      if (!exists) {
        result.push(inc);
      }
    }
    return result;
  };

  const lastPasteTimeRef = useRef<number>(0);

  // Clipboard paste (Ctrl+V / Cmd+V) for screenshots, images and files
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (disabled || isClosed || !isWindowOpen) return;
    const now = Date.now();
    if (now - lastPasteTimeRef.current < 250) {
      return;
    }
    lastPasteTimeRef.current = now;

    const items = e.clipboardData?.items;
    const filesFound: File[] = [];
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) filesFound.push(f);
        }
      }
    }
    if (filesFound.length === 0 && e.clipboardData?.files) {
      filesFound.push(...Array.from(e.clipboardData.files));
    }

    if (filesFound.length > 0 && onSendMediaFile) {
      e.preventDefault();
      e.stopPropagation();
      setPendingFiles((prev) => deduplicateFiles(prev, filesFound));
      setIsFileModalOpen(true);
    }
  };

  // Window-level paste listener: catches screenshots even if chat thread is focused
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (disabled || isClosed || !isWindowOpen || !onSendMediaFile) return;
      const target = e.target as HTMLElement | null;
      // If paste originated inside draftInputRef, handlePaste already processed it.
      if (target && (target === draftInputRef.current || draftInputRef.current?.contains(target))) {
        return;
      }
      // If paste was inside any other input or textarea (e.g. search bar), ignore.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      const now = Date.now();
      if (now - lastPasteTimeRef.current < 250) {
        return;
      }
      lastPasteTimeRef.current = now;

      const items = e.clipboardData?.items;
      const filesFound: File[] = [];
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            const f = items[i].getAsFile();
            if (f) filesFound.push(f);
          }
        }
      }
      if (filesFound.length === 0 && e.clipboardData?.files) {
        filesFound.push(...Array.from(e.clipboardData.files));
      }

      if (filesFound.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setPendingFiles((prev) => deduplicateFiles(prev, filesFound));
        setIsFileModalOpen(true);
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [disabled, isClosed, isWindowOpen, onSendMediaFile]);

  // Single-flight guard. `sending` below is only for rendering; it cannot
  // prevent a duplicate, because React commits state asynchronously and a
  // double Enter (or Enter plus a click) runs both handlers before that commit.
  // The backend's idempotency check does not catch it either: it is keyed on
  // client_message_id, and each send mints a fresh one, so two sends of the same
  // text are two unrelated messages and both reach WhatsApp.
  const sendLockRef = useRef(createSendLock());
  const filesSendLockRef = useRef(createSendLock());
  const mediaUrlSendLockRef = useRef(createSendLock());

  /**
   * WhatsApp Web keeps the cursor in the draft field after Enter, so the next
   * message can be typed straight away.
   *
   * Focus was being lost on every send because the draft input was rendered
   * `disabled` while `sending` (see `isInputDisabled` below), and a focused
   * element that becomes disabled is blurred by the browser. Re-enabling it
   * never restores focus, so the user had to click the field again — the whole
   * point of Enter-to-send is that they do not.
   *
   * The draft is now left enabled during a send and focus is reclaimed here.
   * It is only reclaimed when nothing else has claimed it: a deliberate click
   * into the attachment menu or the template picker must not be undone.
   */
  const refocusDraft = useCallback(() => {
    const el = draftInputRef.current;
    if (!el || el.disabled) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active !== document.body && active !== el) return;
    el.focus();
  }, []);

  useEffect(() => {
    if (replyingTo) {
      refocusDraft();
    }
  }, [replyingTo, refocusDraft]);

  const handleSelectQuickReply = useCallback(
    (qr: QuickReply) => {
      const rendered = renderQuickReplyContent(qr, { name: leadName || '' });
      setText(rendered);
      setIsQuickRepliesDismissed(true);
      setTimeout(() => {
        refocusDraft();
        if (draftInputRef.current) {
          draftInputRef.current.style.height = 'auto';
          draftInputRef.current.style.height = `${Math.min(draftInputRef.current.scrollHeight, 120)}px`;
        }
      }, 30);
    },
    [leadName, refocusDraft]
  );

  const handleSelectMention = useCallback(
    (participant: { id: string; name: string; phone?: string }) => {
      if (!cursorMentionMatch) return;
      const mentionText = `@${participant.name && participant.name !== 'ME' ? participant.name : formatPhoneNumber(participant.phone) || participant.phone || 'Katılımcı'} `;
      const beforeAt = text.slice(0, cursorMentionMatch.atIndex);
      const afterCursor = text.slice(cursorMentionMatch.cursor);
      const newText = `${beforeAt}${mentionText}${afterCursor}`;
      const newPos = beforeAt.length + mentionText.length;

      justSelectedMentionRef.current = true;
      setIsMentionDismissed(true);
      setText(newText);

      if (draftInputRef.current) {
        draftInputRef.current.value = newText;
        draftInputRef.current.setSelectionRange(newPos, newPos);
        draftInputRef.current.style.height = 'auto';
        draftInputRef.current.style.height = `${Math.min(draftInputRef.current.scrollHeight, 120)}px`;
      }

      setTimeout(() => {
        refocusDraft();
        if (draftInputRef.current) {
          draftInputRef.current.setSelectionRange(newPos, newPos);
        }
      }, 30);
    },
    [cursorMentionMatch, text, refocusDraft]
  );


  useEffect(() => {
    if (insertedText && insertedText.text) {
      setText((current) => {
        if (!current.trim()) {
          return insertedText.text;
        }
        return `${current}\n${insertedText.text}`;
      });
      setTimeout(() => {
        refocusDraft();
        if (draftInputRef.current) {
          draftInputRef.current.style.height = 'auto';
          draftInputRef.current.style.height = `${Math.min(draftInputRef.current.scrollHeight, 120)}px`;
        }
      }, 30);
    }
  }, [insertedText, refocusDraft]);

  useEffect(() => {
    const handleInsertEvent = (e: any) => {
      const incoming = e?.detail?.text;
      if (typeof incoming === 'string' && incoming) {
        setText((current) => {
          if (!current.trim()) {
            return incoming;
          }
          return `${current}\n${incoming}`;
        });
        setTimeout(() => {
          refocusDraft();
          if (draftInputRef.current) {
            draftInputRef.current.style.height = 'auto';
            draftInputRef.current.style.height = `${Math.min(draftInputRef.current.scrollHeight, 120)}px`;
          }
        }, 30);
      }
    };
    window.addEventListener('tezlify:insert_quick_reply', handleInsertEvent);
    return () => {
      window.removeEventListener('tezlify:insert_quick_reply', handleInsertEvent);
    };
  }, [refocusDraft]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = text.trim();
    if (!clean || disabled || isClosed || !onSend) return;
    // A send already in flight makes this a duplicate; reject it before any
    // request is made, and report nothing to the user because nothing failed.
    if (sendLockRef.current.isLocked()) return;

    // Snapshot the RAW draft, not the trimmed text: needed to restore if send fails
    const draft = text;
    let textToSend = clean;
    if (replyingTo && replyingTo.body) {
      const snippet = replyingTo.body.split('\n')[0].slice(0, 100);
      textToSend = `> ${snippet}\n\n${clean}`;
    }

    // IMMEDIATELY clear the input field and reset states so the user can
    // start typing their next message without text concatenation or visual lag:
    setText('');
    if (draftInputRef.current) {
      draftInputRef.current.value = '';
      draftInputRef.current.style.height = 'auto';
    }
    if (replyingTo && onCancelReply) {
      onCancelReply();
    }
    setIsEmojiOpen(false);
    stopTypingSignal();
    refocusDraft();

    setSending(true);
    try {
      await sendLockRef.current.run(async () => {
        await onSend(textToSend);
      });
    } catch (err) {
      console.error('[ChatComposer] Send error:', err);
      // If the field is still empty, restore the draft so the user doesn't lose what they typed.
      // If they already started typing their next message, do not overwrite it.
      setText((current) => (current === '' ? draft : current));
    } finally {
      setSending(false);
      refocusDraft();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (isMentionActive && matchedMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % matchedMentions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + matchedMentions.length) % matchedMentions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const chosen = matchedMentions[mentionIndex];
        if (chosen) {
          handleSelectMention(chosen);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        justSelectedMentionRef.current = true;
        setIsMentionDismissed(true);
        return;
      }

    }

    if (isTypingShortcut && matchedQuickReplies.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setQuickReplyIndex((prev) => (prev + 1) % matchedQuickReplies.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setQuickReplyIndex((prev) => (prev - 1 + matchedQuickReplies.length) % matchedQuickReplies.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = matchedQuickReplies[quickReplyIndex];
        if (chosen) {
          handleSelectQuickReply(chosen);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsQuickRepliesDismissed(true);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleMediaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mediaUrl.trim() || !mediaModalType || !onSendMedia || mediaUrlSendLockRef.current.isLocked()) return;

    setSendingMedia(true);
    try {
      await mediaUrlSendLockRef.current.run(async () => {
        await onSendMedia(
          mediaModalType,
          mediaUrl.trim(),
          mediaCaption.trim() || undefined,
          mediaFilename.trim() || undefined
        );
        setMediaModalType(null);
        setMediaUrl('');
        setMediaCaption('');
        setMediaFilename('');
        stopTypingSignal();
        // The modal took focus; hand it back to the draft field it closed over.
        refocusDraft();
      });
    } catch (err) {
      console.error('[ChatComposer] Media send error:', err);
    } finally {
      setSendingMedia(false);
    }
  };

  const handleSendAllFiles = async () => {
    if (pendingFiles.length === 0 || !onSendMediaFile || filesSendLockRef.current.isLocked()) return;
    setSendingFiles(true);
    try {
      await filesSendLockRef.current.run(async () => {
        let sentCount = 0;
        try {
          for (let i = 0; i < pendingFiles.length; i++) {
            setSendingIndex(i);
            const f = pendingFiles[i];
            const cap = fileCaptions[i]?.trim() || undefined;
            await onSendMediaFile(f, cap);
            sentCount = i + 1;
            if (i < pendingFiles.length - 1) {
              // Micro delay to maintain dispatch order
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
          }
          stopTypingSignal();
          setIsFileModalOpen(false);
          setPendingFiles([]);
          setActiveFileIndex(0);
          setFileCaptions({});
          onClearStagedFiles?.();
          refocusDraft();
        } catch (err) {
          // If some files were sent before failure, remove only the sent files
          // so retry will not re-send already dispatched files!
          if (sentCount > 0) {
            setPendingFiles((prev) => prev.slice(sentCount));
            setActiveFileIndex(0);
            setFileCaptions((prev) => {
              const nextCaps: Record<number, string> = {};
              Object.entries(prev).forEach(([key, val]) => {
                const numKey = Number(key);
                if (numKey >= sentCount) {
                  nextCaps[numKey - sentCount] = val;
                }
              });
              return nextCaps;
            });
          }
          throw err;
        }
      });
    } catch (err) {
      console.error('[ChatComposer] Multi-file send error:', err);
    } finally {
      setSendingFiles(false);
      setSendingIndex(0);
    }
  };

  // `sending` gates the ACTIONS (send, attach, template) so an in-flight send
  // still renders its spinner and cannot be re-triggered by a click. It must
  // NOT gate the draft input: disabling a focused field blurs it, which is how
  // Enter-to-send used to drop the cursor out of the composer.
  const isActionDisabled = disabled || isClosed || sending;
  const isInputDisabled = disabled || isClosed || !isWindowOpen;


  /**
   * Insert at the caret, not at the end: someone who moved the cursor back into
   * the middle of a draft expects the emoji where they were typing. The caret is
   * restored right after the inserted character so several emoji in a row land
   * side by side.
   */
  const handleEmojiPick = (char: string) => {
    const el = draftInputRef.current;
    const next = insertAtCaret(text, char, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    setText(next.text);
    notifyTypingActivity();
    window.requestAnimationFrame(() => {
      const input = draftInputRef.current;
      if (!input) return;
      input.focus();
      const pos = Math.min(next.caret, next.text.length);
      input.setSelectionRange(pos, pos);
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    });
  };

  return (
    <div
      ref={composerRootRef}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
      className="relative p-3 border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/20"
    >

      {/* 1. Closed Conversation Notice */}
      {isClosed && (
        <div className="flex items-center justify-between mb-2.5 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs">
          <div className="flex items-center space-x-2">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span className="font-bold">{t('whatsapp.closedComposerNotice')}</span>
          </div>
          {onReopenConversation && (
            <button
              type="button"
              onClick={onReopenConversation}
              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 font-extrabold text-[11px] transition-all cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>{t('whatsapp.reopen')}</span>
            </button>
          )}
        </div>
      )}

      {/* 2. Window Expired / Template Prompt Banner */}
      {!isClosed && !isWindowOpen && (
        <div className="flex items-center justify-between mb-2.5 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span className="font-medium">
              {t('whatsapp.windowExpiredNotice')}
            </span>
          </div>
          {onSendTemplate && (
            <Button
              type="button"
              size="sm"
              onClick={onSendTemplate}
              className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-[11px] py-1 px-2.5 h-auto space-x-1 shadow-xs cursor-pointer"
            >
              <LayoutTemplate className="w-3 h-3" />
              <span>{t('whatsapp.useTemplateBtn')}</span>
            </Button>
          )}
        </div>
      )}

      {/* 2.5 Quoted/Reply preview banner */}
      {replyingTo && (
        <div className="flex items-center justify-between px-3.5 py-2 mb-2 bg-slate-100 dark:bg-white/[0.06] border-l-4 border-l-[#25D366] rounded-r-xl text-xs animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="min-w-0 pr-2">
            <div className="font-bold text-[#25D366] text-[11px]">
              {replyingTo.senderName || t('whatsapp.reply')}
            </div>
            <div className="text-slate-600 dark:text-slate-300 truncate text-[11px]">
              {replyingTo.body || (replyingTo.mediaType ? `[${replyingTo.mediaType}]` : '')}
            </div>
          </div>
          {onCancelReply && (
            <button
              type="button"
              onClick={onCancelReply}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
              title={t('common.cancel')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* 2.8 AI Reply Co-Pilot Popover */}
      {conversationId && (
        <AiSuggestPopover
          conversationId={conversationId}
          isOpen={isAiOpen}
          onClose={() => setIsAiOpen(false)}
          onSelectSuggestion={(sugText) => {
            setText(sugText);
            draftInputRef.current?.focus();
          }}
        />
      )}

      {/* 3. Main Composer Row */}
      <form onSubmit={handleSubmit} className="flex items-end space-x-2">
        {/* Emoji Picker (WhatsApp Web: smiley first, then attach) */}
        <div className="relative mb-0.5" ref={emojiContainerRef}>
          <Tooltip content={t('whatsapp.emojiPickerTitle')}>
            <button
              type="button"
              aria-label={t('whatsapp.emojiPickerTitle')}
              aria-expanded={isEmojiOpen}
              disabled={isInputDisabled}
              onClick={() => {
                setIsEmojiOpen((open) => !open);
                setIsAttachMenuOpen(false);
              }}
              className={`p-2 rounded-xl transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isEmojiOpen
                  ? 'text-[#7367F0] bg-[#7367F0]/10'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08]'
              }`}
            >
              <Smile className="w-4 h-4" />
            </button>
          </Tooltip>

          {isEmojiOpen && (
            <EmojiPicker
              onPick={handleEmojiPick}
              onClose={() => setIsEmojiOpen(false)}
              className="absolute bottom-12 left-0 z-40 animate-in fade-in slide-in-from-bottom-2 duration-150"
            />
          )}
        </div>

        {/* Attachment '+' Button with Popover */}
        <div className="relative mb-0.5" ref={attachMenuRef}>
          <Tooltip content={t('whatsapp.addAttachment')}>
            <button
              type="button"
              aria-label={t('whatsapp.addAttachment')}
              disabled={isActionDisabled}
              onClick={() => {
                setIsAttachMenuOpen(!isAttachMenuOpen);
                setIsEmojiOpen(false);
              }}
              className="p-2 rounded-xl text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
            </button>
          </Tooltip>

          {isAttachMenuOpen && (
            <div className="absolute bottom-12 left-0 z-30 w-44 p-1.5 rounded-2xl bg-white dark:bg-[#1E2333] shadow-xl border border-slate-200 dark:border-white/[0.1] space-y-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  openFilePicker('image/*,video/*');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.choosePhotoFile')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  openFilePicker('audio/*,.mp3,.ogg,.wav,.m4a,.aac,.webm');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[#FF9F43]/15 text-[#FF9F43] flex items-center justify-center shrink-0">
                  <Music className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.chooseAudioFile')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  openFilePicker('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/pdf,application/msword');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.chooseDocFile')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  setMediaModalType('IMAGE');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-slate-500/15 text-slate-500 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.sendPhotoUrl')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAttachMenuOpen(false);
                  setMediaModalType('DOCUMENT');
                }}
                className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-all cursor-pointer text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-slate-500/15 text-slate-500 flex items-center justify-center shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <span>{t('whatsapp.sendDocUrl')}</span>
              </button>
            </div>
          )}
        </div>

        {/* Hidden native file picker (WhatsApp Web tarzı anlık dosya gönderimi) */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChosen}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Recording Bar or Multiline Textarea Input */}
        {isRecording ? (
          <div className="flex-1 flex items-center justify-between px-3.5 py-2 bg-slate-100 dark:bg-[#202c33] rounded-2xl animate-in fade-in duration-200">
            {/* Discard / Trash button */}
            <Tooltip content={t('whatsapp.voiceDiscard')}>
              <button
                type="button"
                data-testid="composer-voice-discard-btn"
                onClick={cancelRecording}
                className="p-2 rounded-full text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
                aria-label={t('whatsapp.voiceDiscard')}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </Tooltip>

            {/* Recording indicator & timer */}
            <div className="flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
              <span className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100">
                {Math.floor(recordingDuration / 60)}:{(recordingDuration % 60).toString().padStart(2, '0')}
              </span>
              <div className="flex items-center gap-0.5 h-4 px-2">
                {[35, 75, 45, 90, 60, 30, 80, 50, 85].map((h, i) => (
                  <span
                    key={i}
                    className="w-0.5 bg-rose-500/80 rounded-full animate-pulse"
                    style={{ height: `${h}%`, animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
            </div>

            {/* Send voice recording button */}
            <Tooltip content={t('whatsapp.voiceSend')}>
              <button
                type="button"
                data-testid="composer-voice-send-btn"
                onClick={sendRecording}
                className="p-2 rounded-full bg-[#25D366] hover:bg-[#1EBE5D] text-white shadow-sm transition-transform active:scale-95 cursor-pointer"
                aria-label={t('whatsapp.voiceSend')}
              >
                <Send className="w-4 h-4 fill-white" />
              </button>
            </Tooltip>
          </div>
        ) : (
          <>
            {/* Multiline Textarea Input */}
            <div className="relative flex-1 min-w-0">
              {/* Quick Replies Shortcut ('/') Floating Popover */}
              {isTypingShortcut && (
                <div
                  data-testid="composer-quick-replies-popover"
                  className="absolute bottom-full mb-2 left-0 right-0 z-30 bg-white dark:bg-[#202c33] rounded-2xl shadow-xl border border-slate-200/90 dark:border-white/[0.08] overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150"
                >
                  <div className="px-3.5 py-2 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/70 dark:bg-black/20">
                    <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
                      <Zap className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{t('whatsapp.quickRepliesShortTitle')}</span>
                      <span className="text-[10px] text-slate-400 font-normal">({matchedQuickReplies.length})</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-[10px] text-slate-400 hidden sm:inline">
                        {t('whatsapp.quickRepliesHint')}
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsQuickRepliesDismissed(true)}
                        className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  <div className="max-h-56 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
                    {matchedQuickReplies.length === 0 ? (
                      <div className="py-4 text-center text-xs text-slate-400">
                        {t('whatsapp.noQuickRepliesFound')}
                      </div>
                    ) : (
                      matchedQuickReplies.map((qr, idx) => {
                        const isSelected = idx === quickReplyIndex;
                        return (
                          <div
                            key={qr.id}
                            data-testid={`quick-reply-item-${qr.shortcut}`}
                            onClick={() => handleSelectQuickReply(qr)}
                            onMouseEnter={() => setQuickReplyIndex(idx)}
                            className={`flex items-start justify-between p-2 rounded-xl text-left cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/20 text-[#7367F0]'
                                : 'hover:bg-slate-100 dark:hover:bg-white/[0.04] text-slate-700 dark:text-slate-200'
                            }`}
                          >
                            <div className="min-w-0 flex-1 pr-2">
                              <div className="flex items-center space-x-1.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#7367F0]/15 text-[#7367F0]">
                                  {qr.shortcut?.startsWith('/') ? qr.shortcut : `/${qr.shortcut || ''}`}
                                </span>
                                <span className="text-xs font-bold truncate">
                                  {qr.title}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                                {qr.content}
                              </p>
                            </div>
                            {isSelected && (
                              <span className="text-[10px] font-mono text-[#7367F0] shrink-0 self-center hidden sm:inline">
                                Enter ↵
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* Group Mention ('@') Floating Popover */}
              {isMentionActive && (
                <div
                  data-testid="composer-mentions-popover"
                  className="absolute bottom-full mb-2 left-0 right-0 z-30 bg-white dark:bg-[#202c33] rounded-2xl shadow-xl border border-slate-200/90 dark:border-white/[0.08] overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150"
                >
                  <div className="px-3.5 py-2 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/70 dark:bg-black/20">
                    <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
                      <AtSign className="w-3.5 h-3.5 text-[#00a884]" />
                      <span>{t('whatsapp.mentionParticipant')}</span>
                      <span className="text-[10px] text-slate-400 font-normal">({matchedMentions.length})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        justSelectedMentionRef.current = true;
                        setIsMentionDismissed(true);
                      }}
                      className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>

                  </div>

                  <div className="max-h-56 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
                    {matchedMentions.map((part, idx) => {
                      const isSelected = idx === mentionIndex;
                      const displayName = part.name && part.name !== 'ME' ? part.name : formatPhoneNumber(part.phone) || part.phone || 'Katılımcı';
                      return (
                        <div
                          key={part.id}
                          data-testid={`mention-item-${part.id}`}
                          onClick={() => handleSelectMention(part)}
                          onMouseEnter={() => setMentionIndex(idx)}
                          className={`flex items-center justify-between p-2 rounded-xl text-left cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-[#00a884]/10 dark:bg-[#00a884]/20 text-[#00a884]'
                              : 'hover:bg-slate-100 dark:hover:bg-white/[0.04] text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0 flex-1 pr-2">
                            <Avatar
                              name={displayName}
                              phone={part.phone || undefined}
                              size="sm"
                              shape="circle"
                              className="w-7 h-7 text-[10px] shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center space-x-1.5">
                                <span className="text-xs font-bold truncate">
                                  {displayName}
                                </span>
                                {part.admin && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-bold border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
                                    {t('whatsapp.groupAdmin')}
                                  </span>
                                )}
                              </div>
                              {part.phone && part.name && (
                                <p className="text-[11px] text-slate-400 font-mono truncate">
                                  {formatPhoneNumber(part.phone)}
                                </p>
                              )}
                            </div>
                          </div>
                          {isSelected && (
                            <span className="text-[10px] font-mono text-[#00a884] shrink-0 self-center hidden sm:inline">
                              Enter ↵
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <textarea
                ref={draftInputRef as any}
                rows={1}
                data-testid="composer-input"
                value={text}
                disabled={isInputDisabled}
                onFocus={() => {
                  setIsAttachMenuOpen(false);
                }}
                onChange={(e) => {
                  justSelectedMentionRef.current = false;
                  setIsMentionDismissed(false);
                  setText(e.target.value);
                  notifyTypingActivity();
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                }}

                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  isClosed
                    ? (t('whatsapp.closedPlaceholder'))
                    : !isWindowOpen
                    ? (t('whatsapp.windowExpiredPlaceholder'))
                    : (placeholder || t('leads.typeMessagePlaceholder'))
                }
                className={`w-full px-3.5 py-2.5 pr-20 text-base sm:text-[13px] leading-relaxed rounded-xl vuexy-input transition-all resize-none max-h-[120px] overflow-y-auto scrollbar-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden block ${
                  isInputDisabled
                    ? 'opacity-60 cursor-not-allowed bg-slate-100 dark:bg-white/[0.04]'
                    : ''
                }`}
              />

              {/* Action Buttons inside Input: AI Co-Pilot & Quick Template */}
              {!isClosed && (
                <div className="absolute right-2 top-3 flex items-center space-x-1">
                  {conversationId && (
                    <Tooltip content={t('whatsapp.aiCoPilotBtn')}>
                      <button
                        type="button"
                        aria-label={t('whatsapp.aiCoPilotBtn')}
                        onClick={() => setIsAiOpen((open) => !open)}
                        disabled={isActionDisabled}
                        className={`flex items-center space-x-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-all cursor-pointer disabled:opacity-40 ${
                          isAiOpen
                            ? 'bg-[#7367F0] text-white shadow-xs'
                            : 'bg-[#7367F0]/10 hover:bg-[#7367F0]/20 text-[#7367F0] border border-[#7367F0]/20'
                        }`}
                      >
                        <Sparkles className="w-3 h-3" />
                        <span className="hidden sm:inline">{t('whatsapp.aiShort')}</span>
                      </button>
                    </Tooltip>
                  )}

                  {onSendTemplate && (
                    <Tooltip content={t('whatsapp.useTemplateBtn')}>
                      <button
                        type="button"
                        aria-label={t('whatsapp.useTemplateBtn')}
                        onClick={onSendTemplate}
                        disabled={isActionDisabled}
                        className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-[#7367F0]/10 hover:bg-[#7367F0]/20 text-[#7367F0] text-[10px] font-bold transition-all cursor-pointer disabled:opacity-40"
                      >
                        <LayoutTemplate className="w-3 h-3" />
                        <span className="hidden sm:inline">{t('whatsapp.templateShort')}</span>
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>

            {/* Send or Mic Button */}
            {text.trim() ? (
              <Tooltip content={isClosed ? t('whatsapp.closedComposerNotice') : !isWindowOpen ? t('whatsapp.windowExpiredNotice') : t('leads.sendNow')}>
                <div className="mb-0.5">
                  <Button
                    type="submit"
                    size="sm"
                    aria-label={t('leads.sendNow')}
                    disabled={isActionDisabled || !text.trim()}
                    className="bg-[#25D366] hover:bg-[#1EBE5D] text-white px-3.5 py-2.5 rounded-xl font-bold shadow-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 h-auto transition-transform active:scale-95"
                  >
                    {sending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4 fill-white" />
                    )}
                  </Button>
                </div>
              </Tooltip>
            ) : (
              <Tooltip content={t('whatsapp.voiceRecordTooltip')}>
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={isActionDisabled}
                  data-testid="composer-mic-btn"
                  className="p-2.5 mb-0.5 rounded-xl text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/[0.08] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  aria-label={t('whatsapp.voiceRecordTooltip')}
                  title={t('whatsapp.voiceRecordTooltip')}
                >
                  <Mic className="w-4 h-4 text-[#25D366]" />
                </button>
              </Tooltip>
            )}
          </>
        )}
      </form>

      {/* 4. Media Send Modal */}
      {mediaModalType && (
        <Modal
          isOpen={!!mediaModalType}
          onClose={() => setMediaModalType(null)}
          title={mediaModalType === 'IMAGE' ? (t('whatsapp.sendPhotoTitle')) : (t('whatsapp.sendDocTitle'))}
          subtitle={t('whatsapp.mediaUrlPrompt')}
          icon={mediaModalType === 'IMAGE' ? ImageIcon : FileText}
          maxWidth="md"
        >
          <form onSubmit={handleMediaSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.mediaUrlLabel')}
              </label>
              <input
                type="url"
                required
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder={mediaModalType === 'IMAGE' ? t('whatsapp.mediaUrlImagePlaceholder') : t('whatsapp.mediaUrlDocumentPlaceholder')}
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>

            {mediaModalType === 'DOCUMENT' && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                  {t('whatsapp.filenameLabel')}
                </label>
                <input
                  type="text"
                  value={mediaFilename}
                  onChange={(e) => setMediaFilename(e.target.value)}
                  placeholder={t('whatsapp.filenamePlaceholder')}
                  className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                {t('whatsapp.captionLabel')}
              </label>
              <input
                type="text"
                value={mediaCaption}
                onChange={(e) => setMediaCaption(e.target.value)}
                placeholder={t('whatsapp.captionPlaceholder')}
                className="w-full px-3 py-2 text-xs rounded-xl vuexy-input font-medium"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200/80 dark:border-white/[0.08]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMediaModalType(null)}
                disabled={sendingMedia}
                className="text-xs font-bold"
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={sendingMedia || !mediaUrl.trim()}
                className="bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold space-x-1.5 shadow-sm cursor-pointer"
              >
                {sendingMedia ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>{t('whatsapp.sendMediaBtn')}</span>
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* 5. Picked-File Caption Modal (WhatsApp Web: dosya sec / yapistir / surukle -> onizle -> aciklama -> gonder) */}
      {isFileModalOpen && pendingFiles.length > 0 && (
        <MediaSendModal
          isOpen={isFileModalOpen}
          onClose={() => {
            if (!sendingFiles) {
              setIsFileModalOpen(false);
              setPendingFiles([]);
              setFileCaptions({});
              onClearStagedFiles?.();
            }
          }}
          files={pendingFiles}
          onFilesChange={setPendingFiles}
          activeIndex={activeFileIndex}
          onActiveIndexChange={setActiveFileIndex}
          captions={fileCaptions}
          onCaptionChange={(idx, val) => setFileCaptions((prev) => ({ ...prev, [idx]: val }))}
          onSendAll={handleSendAllFiles}
          isSending={sendingFiles}
          sendingIndex={sendingIndex}
          onAddMoreFiles={() => openFilePicker('*')}
        />
      )}
    </div>
  );
};
