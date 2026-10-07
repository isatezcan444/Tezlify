import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Send,
  Smile,
  Plus,
  FileText,
  FileArchive,
  Music,
  RotateCw,
  Loader2,
  Film,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { EmojiPicker } from './EmojiPicker';
import { useDialogFocusTrap } from '../../../components/ui/Modal';

export interface MediaSendModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: File | null;
  caption: string;
  onCaptionChange: (caption: string) => void;
  onSend: () => Promise<void> | void;
  isSending: boolean;
  onPickAnotherFile?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
}

export const MediaSendModal: React.FC<MediaSendModalProps> = ({
  isOpen,
  onClose,
  file,
  caption,
  onCaptionChange,
  onSend,
  isSending,
  onPickAnotherFile,
}) => {
  const { t } = useI18n();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rotation, setRotation] = useState<number>(0);
  const [isEmojiOpen, setIsEmojiOpen] = useState<boolean>(false);
  const captionInputRef = useRef<HTMLInputElement>(null);
  const emojiContainerRef = useRef<HTMLDivElement>(null);

  const panelRef = useDialogFocusTrap(isOpen);

  // Object URL lifecycle
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const type = file.type || '';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isVisual =
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      type.startsWith('audio/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg'].includes(ext);

    if (isVisual) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setPreviewUrl(null);
  }, [file]);

  // Reset rotation and emoji state when file changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setRotation(0);
      setIsEmojiOpen(false);
      // Auto-focus caption input after mount
      const timer = setTimeout(() => {
        captionInputRef.current?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isOpen, file]);

  // Close emoji on outside click
  useEffect(() => {
    if (!isEmojiOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (emojiContainerRef.current && !emojiContainerRef.current.contains(e.target as Node)) {
        setIsEmojiOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isEmojiOpen]);

  // Keyboard navigation: Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isEmojiOpen) {
          setIsEmojiOpen(false);
        } else if (!isSending) {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isEmojiOpen, isSending, onClose]);

  if (!isOpen || !file || typeof document === 'undefined') return null;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime = file.type || '';
  const isImage = mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  const isVideo = mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext);
  const isAudio = mime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'opus'].includes(ext);
  const isArchive = ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext);

  const formattedSize = formatBytes(file.size);

  let fileTypeLabel = `${ext.toUpperCase()} ${t('whatsapp.documentFile') || 'belgesi'}`;
  if (isArchive) {
    fileTypeLabel = `Zip ${t('whatsapp.archiveFile') || 'arşivi'}`;
  } else if (ext === 'pdf') {
    fileTypeLabel = `PDF ${t('whatsapp.documentFile') || 'belgesi'}`;
  } else if (['doc', 'docx'].includes(ext)) {
    fileTypeLabel = `Word ${t('whatsapp.documentFile') || 'belgesi'}`;
  } else if (['xls', 'xlsx'].includes(ext)) {
    fileTypeLabel = `Excel ${t('whatsapp.documentFile') || 'belgesi'}`;
  } else if (isAudio) {
    fileTypeLabel = `Ses dosyası`;
  } else if (isVideo) {
    fileTypeLabel = `Video dosyası`;
  }

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleEmojiPick = (char: string) => {
    onCaptionChange(caption + char);
    captionInputRef.current?.focus();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('whatsapp.sendFileTitle')}
      tabIndex={-1}
      className="fixed inset-0 z-[99999] flex flex-col bg-[#0b141a] text-white select-none animate-in fade-in duration-150 outline-none"
    >
      {/* 1. TOP HEADER BAR */}
      <header className="h-14 sm:h-16 px-4 flex items-center justify-between bg-[#111b21] sm:bg-transparent border-b border-white/5 sm:border-none shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            disabled={isSending}
            aria-label={t('common.close')}
            className="p-2 sm:p-2.5 rounded-full text-slate-300 hover:text-white hover:bg-white/10 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Centered Filename (especially for documents / archives) */}
        <div className="flex-1 px-4 text-center min-w-0">
          {!isImage && (
            <h2 className="text-sm font-semibold text-white/90 truncate max-w-sm sm:max-w-md mx-auto">
              {file.name}
            </h2>
          )}
        </div>

        {/* Top Right Tool Bar (for images/videos) */}
        <div className="flex items-center gap-2">
          {isImage && (
            <>
              <button
                type="button"
                onClick={handleRotate}
                title="Döndür (90°)"
                className="p-2 rounded-full text-slate-300 hover:text-white hover:bg-white/10 active:scale-90 transition-all cursor-pointer"
              >
                <RotateCw className="w-5 h-5" />
              </button>
              <div className="hidden sm:flex items-center px-2 py-0.5 rounded-md border border-white/20 text-[11px] font-bold text-white/80">
                HD
              </div>
            </>
          )}
          {isVideo && (
            <div className="hidden sm:flex items-center px-2 py-0.5 rounded-md border border-white/20 text-[11px] font-bold text-white/80">
              HD
            </div>
          )}
        </div>
      </header>

      {/* 2. CENTER PREVIEW AREA */}
      <main className="flex-1 flex items-center justify-center p-4 relative min-h-0 overflow-hidden">
        {/* A. Image Preview */}
        {isImage && previewUrl && (
          <div className="max-h-full max-w-full flex items-center justify-center">
            <img
              src={previewUrl}
              alt={file.name}
              className="max-h-[62vh] max-w-[88vw] object-contain rounded-xl shadow-2xl transition-transform duration-200"
              style={{ transform: `rotate(${rotation}deg)` }}
            />
          </div>
        )}

        {/* B. Video Preview */}
        {isVideo && previewUrl && (
          <div className="relative max-h-full max-w-full flex items-center justify-center">
            <video
              src={previewUrl}
              controls
              className="max-h-[62vh] max-w-[88vw] rounded-xl shadow-2xl bg-black"
            />
            {/* Top-left badge: video indicator & size */}
            <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-xs font-mono text-white/90 flex items-center gap-1.5 shadow-md pointer-events-none">
              <Film className="w-3.5 h-3.5 text-white/80" />
              <span>{formattedSize}</span>
            </div>
          </div>
        )}

        {/* C. Audio Preview */}
        {isAudio && previewUrl && (
          <div className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-[#111b21] border border-white/10 shadow-2xl max-w-md w-full">
            <div className="w-16 h-16 rounded-full bg-[#25D366]/20 text-[#25D366] flex items-center justify-center shadow-lg">
              <Music className="w-8 h-8" />
            </div>
            <p className="text-sm font-semibold text-white/90 truncate max-w-full">{file.name}</p>
            <p className="text-xs text-white/50">{formattedSize}</p>
            <audio controls src={previewUrl} className="w-full mt-2" />
          </div>
        )}

        {/* D. Document / Archive / Non-previewable Preview (WhatsApp Web style: Screenshot 1) */}
        {!isImage && !isVideo && !isAudio && (
          <div className="flex flex-col items-center justify-center p-8 max-w-sm w-full text-center animate-in zoom-in-95 duration-200">
            {/* Document sheet icon with folded top-right corner */}
            <div className="relative w-28 h-36 bg-slate-100 dark:bg-[#1f2c34] rounded-2xl border border-white/10 shadow-2xl flex flex-col items-center justify-center mb-6">
              {/* Folded corner triangle */}
              <div className="absolute top-0 right-0 w-8 h-8 bg-slate-300 dark:bg-[#2a3942] rounded-bl-xl shadow-sm" />
              {/* File badge */}
              <div className="px-3 py-1 rounded bg-black/40 text-[11px] font-extrabold uppercase tracking-wider text-white/90 mb-2">
                {ext || 'FILE'}
              </div>
              {isArchive ? (
                <FileArchive className="w-10 h-10 text-amber-400" />
              ) : (
                <FileText className="w-10 h-10 text-sky-400" />
              )}
            </div>

            {/* Primary message */}
            <p className="text-sm font-medium text-white/80 mb-1">
              {t('whatsapp.cannotPreview')}
            </p>

            {/* Secondary subtitle: File type & formatted size */}
            <p className="text-xs text-white/50">
              {fileTypeLabel} - {formattedSize}
            </p>
          </div>
        )}
      </main>

      {/* 3. BOTTOM CAPTION & SEND BAR */}
      <footer className="shrink-0 p-4 pb-6 flex justify-center items-center relative z-20">
        <div className="w-full max-w-2xl flex items-center gap-3 relative">
          {/* Optional Emoji Picker floating popover */}
          {isEmojiOpen && (
            <div
              ref={emojiContainerRef}
              className="absolute bottom-16 right-16 z-30 shadow-2xl rounded-2xl overflow-hidden border border-white/10"
            >
              <EmojiPicker
                onPick={handleEmojiPick}
                onClose={() => setIsEmojiOpen(false)}
                className="h-72 w-80 bg-[#111b21]"
              />
            </div>
          )}

          {/* Left Plus [+] Button (Pick / Replace file) */}
          {onPickAnotherFile && (
            <button
              type="button"
              onClick={onPickAnotherFile}
              title={t('whatsapp.changeFile')}
              aria-label={t('whatsapp.changeFile')}
              className="p-2.5 sm:p-3 rounded-full text-slate-300 hover:text-white hover:bg-white/10 active:scale-95 transition-all cursor-pointer shrink-0"
            >
              <Plus className="w-5 h-5" />
            </button>
          )}

          {/* Capsule Caption Input */}
          <div className="flex-1 flex items-center bg-[#202c33] rounded-full px-4 py-2.5 sm:py-3 border border-white/5 shadow-inner focus-within:border-white/20 transition-all">
            <input
              ref={captionInputRef}
              type="text"
              value={caption}
              onChange={(e) => onCaptionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!isSending) onSend();
                }
              }}
              placeholder={t('whatsapp.addCaption')}
              className="w-full bg-transparent text-white placeholder-slate-400 text-sm focus:outline-none"
            />

            {/* Emoji Trigger */}
            <button
              type="button"
              onClick={() => setIsEmojiOpen(!isEmojiOpen)}
              className="p-1 text-slate-400 hover:text-white transition-colors cursor-pointer ml-2 shrink-0"
              aria-label="Emoji"
            >
              <Smile className="w-5 h-5" />
            </button>
          </div>

          {/* WhatsApp Green Circular Send Button */}
          <button
            type="button"
            onClick={onSend}
            disabled={isSending}
            aria-label={t('whatsapp.sendFileBtn')}
            className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-[#25D366] hover:bg-[#20ba59] active:scale-95 text-white flex items-center justify-center shadow-lg shadow-[#25D366]/20 transition-all shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSending ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5 fill-white ml-0.5" />
            )}
          </button>
        </div>
      </footer>
    </div>,
    document.body
  );
};
