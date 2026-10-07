import { createSendLock } from '../lib/sendLock';
import { insertAtCaret } from '../lib/emojiData';
import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Upload,
  X
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/Tooltip';
import { Modal } from '../../../components/ui/Modal';
import { EmojiPicker } from './EmojiPicker';
import { MediaSendModal } from './MediaSendModal';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';

export interface QuotedMessage {
  id: number | string;
  senderName?: string;
  body?: string;
  mediaType?: string;
}

export interface ChatComposerProps {
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
  replyingTo?: QuotedMessage | null;
  onCancelReply?: () => void;
  insertedText?: { text: string; timestamp: number } | null;
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
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
  replyingTo,
  onCancelReply,
  insertedText,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [mediaModalType, setMediaModalType] = useState<'IMAGE' | 'DOCUMENT' | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaCaption, setMediaCaption] = useState('');
  const [mediaFilename, setMediaFilename] = useState('');
  const [sendingMedia, setSendingMedia] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileCaption, setFileCaption] = useState('');
  const [sendingFile, setSendingFile] = useState(false);
  const [isFileModalOpen, setIsFileModalOpen] = useState(false);

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

  const attachMenuRef = useRef<HTMLDivElement>(null);
  const emojiContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
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

  const openFilePicker = (accept: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!onSendMediaFile) return;
    setPendingFile(file);
    setFileCaption('');
    setIsFileModalOpen(true);
  };

  // Drag & drop state and handlers for files/images
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (disabled || isClosed || !isWindowOpen) return;
    const file = e.dataTransfer.files?.[0];
    if (file && onSendMediaFile) {
      setPendingFile(file);
      setFileCaption('');
      setIsFileModalOpen(true);
    }
  };

  // Clipboard paste (Ctrl+V / Cmd+V) for screenshots, images and files
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (disabled || isClosed || !isWindowOpen) return;
    const items = e.clipboardData?.items;
    let fileFound: File | null = null;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          fileFound = items[i].getAsFile();
          if (fileFound) break;
        }
      }
    }
    if (!fileFound && e.clipboardData?.files && e.clipboardData.files.length > 0) {
      fileFound = e.clipboardData.files[0];
    }

    if (fileFound && onSendMediaFile) {
      e.preventDefault();
      setPendingFile(fileFound);
      setFileCaption('');
      setIsFileModalOpen(true);
    }
  };

  // Window-level paste listener: catches screenshots even if chat thread is focused
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (disabled || isClosed || !isWindowOpen || !onSendMediaFile) return;
      const target = e.target as HTMLElement | null;
      if (target && target !== draftInputRef.current && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (!e.clipboardData?.files || e.clipboardData.files.length === 0) return;
      }
      const items = e.clipboardData?.items;
      let fileFound: File | null = null;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            fileFound = items[i].getAsFile();
            if (fileFound) break;
          }
        }
      }
      if (!fileFound && e.clipboardData?.files && e.clipboardData.files.length > 0) {
        fileFound = e.clipboardData.files[0];
      }

      if (fileFound) {
        e.preventDefault();
        setPendingFile(fileFound);
        setFileCaption('');
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
  // See lib/sendLock.
  const sendLockRef = useRef(createSendLock());

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

    // Snapshot the RAW draft, not the trimmed text: `clean` drops trailing
    // whitespace, so comparing the live value against it would leave a draft
    // of "merhaba " behind after a successful send.
    const draft = text;
    let textToSend = clean;
    if (replyingTo && replyingTo.body) {
      const snippet = replyingTo.body.split('\n')[0].slice(0, 100);
      textToSend = `> ${snippet}\n\n${clean}`;
    }

    setSending(true);
    try {
      await sendLockRef.current.run(async () => {
        await onSend(textToSend);
        // Clear only the draft we actually sent. The field stays editable
        // while the send is in flight (you can start the next message before
        // the last one lands), so anything typed in the meantime is a NEW
        // message and must survive; an unconditional `setText('')` would have
        // silently eaten it.
        setText((current) => (current === draft ? '' : current));
        if (draftInputRef.current) {
          draftInputRef.current.style.height = 'auto';
        }
        if (replyingTo && onCancelReply) {
          onCancelReply();
        }
        setIsEmojiOpen(false);
        stopTypingSignal();
      });
    } catch (err) {
      console.error('[ChatComposer] Send error:', err);
    } finally {
      setSending(false);
      refocusDraft();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleMediaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mediaUrl.trim() || !mediaModalType || !onSendMedia || sendingMedia) return;

    setSendingMedia(true);
    try {
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
    } catch (err) {
      console.error('[ChatComposer] Media send error:', err);
    } finally {
      setSendingMedia(false);
    }
  };

  const handleFileSend = async (ev?: React.FormEvent) => {
    if (ev) ev.preventDefault();
    if (!pendingFile || !onSendMediaFile || sendingFile) return;
    setSendingFile(true);
    try {
      await onSendMediaFile(pendingFile, fileCaption.trim() || undefined);
      stopTypingSignal();
      setIsFileModalOpen(false);
      setPendingFile(null);
      setFileCaption('');
      refocusDraft();
    } catch (err) {
      console.error('[ChatComposer] File send error:', err);
    } finally {
      setSendingFile(false);
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
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
      className="relative p-3 border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/20"
    >
      {/* Drop files overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-40 rounded-2xl bg-[#0b141a]/90 backdrop-blur-xs border-2 border-dashed border-[#25D366] flex items-center justify-center gap-2.5 animate-in fade-in duration-150 pointer-events-none">
          <Upload className="w-5 h-5 text-[#25D366] animate-bounce" />
          <span className="text-xs font-bold text-white tracking-wide">
            {t('whatsapp.dropFilesHere')}
          </span>
        </div>
      )}

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

              {/* Quick Template Button inside Input */}
              {onSendTemplate && !isClosed && (
                <div className="absolute right-2 top-3 flex items-center">
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
      {isFileModalOpen && pendingFile && (
        <MediaSendModal
          isOpen={isFileModalOpen}
          onClose={() => {
            if (!sendingFile) {
              setIsFileModalOpen(false);
              setPendingFile(null);
            }
          }}
          file={pendingFile}
          caption={fileCaption}
          onCaptionChange={setFileCaption}
          onSend={handleFileSend}
          isSending={sendingFile}
          onPickAnotherFile={() => openFilePicker('*')}
        />
      )}
    </div>
  );
};
