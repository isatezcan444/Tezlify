import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  files: File[];
  onFilesChange: (files: File[]) => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  captions: Record<number, string>;
  onCaptionChange: (index: number, caption: string) => void;
  onSendAll: () => Promise<void> | void;
  isSending: boolean;
  sendingIndex?: number;
  onAddMoreFiles?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
}

// Small sub-component for rendering thumbnail in carousel
const MediaThumbnailItem: React.FC<{
  file: File;
  isActive: boolean;
  onClick: () => void;
  onRemove: (e: React.MouseEvent) => void;
  isSending: boolean;
}> = ({ file, isActive, onClick, onRemove, isSending }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isImage = file.type?.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);

  useEffect(() => {
    if (!isImage) {
      setThumbUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setThumbUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file, isImage]);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`relative w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center cursor-pointer transition-all shrink-0 overflow-hidden select-none group ${
        isActive
          ? 'ring-2 ring-[#25D366] border-2 border-[#25D366] shadow-lg shadow-[#25D366]/20 scale-105 bg-[#202c33]'
          : 'border border-white/20 opacity-70 hover:opacity-100 hover:border-white/40 bg-[#111b21]'
      }`}
    >
      {isImage && thumbUrl ? (
        <img src={thumbUrl} alt={file.name} className="w-full h-full object-cover" />
      ) : file.type?.startsWith('video/') ? (
        <Film className="w-6 h-6 text-emerald-400" />
      ) : file.type?.startsWith('audio/') ? (
        <Music className="w-6 h-6 text-sky-400" />
      ) : ['zip', 'rar', '7z'].includes(ext) ? (
        <FileArchive className="w-6 h-6 text-amber-400" />
      ) : (
        <div className="flex flex-col items-center justify-center">
          <FileText className="w-5 h-5 text-slate-300" />
          <span className="text-[9px] font-extrabold uppercase text-slate-300 tracking-tighter truncate max-w-[40px]">
            {ext || 'DOC'}
          </span>
        </div>
      )}

      {/* Remove (X) button on hover */}
      {!isSending && (
        <button
          type="button"
          onClick={onRemove}
          title="Kaldır"
          aria-label="Kaldır"
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black/80 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer shadow-sm"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};

export const MediaSendModal: React.FC<MediaSendModalProps> = ({
  isOpen,
  onClose,
  files,
  onFilesChange,
  activeIndex,
  onActiveIndexChange,
  captions,
  onCaptionChange,
  onSendAll,
  isSending,
  sendingIndex,
  onAddMoreFiles,
}) => {
  const { t } = useI18n();
  const [rotations, setRotations] = useState<Record<number, number>>({});
  const [isEmojiOpen, setIsEmojiOpen] = useState<boolean>(false);
  const captionInputRef = useRef<HTMLInputElement>(null);
  const emojiContainerRef = useRef<HTMLDivElement>(null);

  const panelRef = useDialogFocusTrap(isOpen);

  const safeIndex = useMemo(() => {
    if (files.length === 0) return 0;
    return Math.max(0, Math.min(activeIndex, files.length - 1));
  }, [files.length, activeIndex]);

  const currentFile: File | null = files[safeIndex] || null;

  // Active object URL for preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!currentFile) {
      setPreviewUrl(null);
      return;
    }
    const type = currentFile.type || '';
    const ext = (currentFile.name.split('.').pop() || '').toLowerCase();
    const isVisual =
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      type.startsWith('audio/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg'].includes(ext);

    if (isVisual) {
      const url = URL.createObjectURL(currentFile);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setPreviewUrl(null);
  }, [currentFile]);

  // Focus caption input after open
  useEffect(() => {
    if (isOpen) {
      setIsEmojiOpen(false);
      const timer = setTimeout(() => {
        captionInputRef.current?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isOpen, safeIndex]);

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

  // Drag and drop onto the modal itself to append more files
  const handleModalDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleModalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSending) return;
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) {
      onFilesChange([...files, ...dropped]);
    }
  };

  const handleRemoveFile = (indexToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSending) return;
    const updated = files.filter((_, idx) => idx !== indexToRemove);
    if (updated.length === 0) {
      onFilesChange([]);
      onClose();
      return;
    }
    onFilesChange(updated);
    if (safeIndex >= updated.length) {
      onActiveIndexChange(Math.max(0, updated.length - 1));
    }
  };

  const handleRotateCurrent = () => {
    setRotations((prev) => ({
      ...prev,
      [safeIndex]: ((prev[safeIndex] || 0) + 90) % 360,
    }));
  };

  const handleEmojiPick = (char: string) => {
    const prevCap = captions[safeIndex] || '';
    onCaptionChange(safeIndex, prevCap + char);
    captionInputRef.current?.focus();
  };

  if (!isOpen || files.length === 0 || !currentFile || typeof document === 'undefined') return null;

  const ext = (currentFile.name.split('.').pop() || '').toLowerCase();
  const mime = currentFile.type || '';
  const isImage = mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  const isVideo = mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext);
  const isAudio = mime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'opus'].includes(ext);
  const isArchive = ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext);

  const formattedSize = formatBytes(currentFile.size);
  const currentRotation = rotations[safeIndex] || 0;
  const currentCaption = captions[safeIndex] || '';

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

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('whatsapp.sendFileTitle')}
      tabIndex={-1}
      onDragOver={handleModalDragOver}
      onDrop={handleModalDrop}
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

        {/* Centered Filename */}
        <div className="flex-1 px-4 text-center min-w-0">
          <h2 className="text-sm font-semibold text-white/90 truncate max-w-sm sm:max-w-md mx-auto">
            {files.length > 1 ? `(${safeIndex + 1}/${files.length}) ${currentFile.name}` : currentFile.name}
          </h2>
        </div>

        {/* Top Right Tool Bar (for images/videos) */}
        <div className="flex items-center gap-2">
          {isImage && (
            <>
              <button
                type="button"
                onClick={handleRotateCurrent}
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
              alt={currentFile.name}
              className="max-h-[55vh] max-w-[88vw] object-contain rounded-xl shadow-2xl transition-transform duration-200"
              style={{ transform: `rotate(${currentRotation}deg)` }}
            />
          </div>
        )}

        {/* B. Video Preview */}
        {isVideo && previewUrl && (
          <div className="relative max-h-full max-w-full flex items-center justify-center">
            <video
              src={previewUrl}
              controls
              className="max-h-[55vh] max-w-[88vw] rounded-xl shadow-2xl bg-black"
            />
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
            <p className="text-sm font-semibold text-white/90 truncate max-w-full">{currentFile.name}</p>
            <p className="text-xs text-white/50">{formattedSize}</p>
            <audio controls src={previewUrl} className="w-full mt-2" />
          </div>
        )}

        {/* D. Document / Archive Preview */}
        {!isImage && !isVideo && !isAudio && (
          <div className="flex flex-col items-center justify-center p-8 max-w-sm w-full text-center animate-in zoom-in-95 duration-200">
            <div className="relative w-28 h-36 bg-slate-100 dark:bg-[#1f2c34] rounded-2xl border border-white/10 shadow-2xl flex flex-col items-center justify-center mb-6">
              <div className="absolute top-0 right-0 w-8 h-8 bg-slate-300 dark:bg-[#2a3942] rounded-bl-xl shadow-sm" />
              <div className="px-3 py-1 rounded bg-black/40 text-[11px] font-extrabold uppercase tracking-wider text-white/90 mb-2">
                {ext || 'FILE'}
              </div>
              {isArchive ? (
                <FileArchive className="w-10 h-10 text-amber-400" />
              ) : (
                <FileText className="w-10 h-10 text-sky-400" />
              )}
            </div>

            <p className="text-sm font-medium text-white/80 mb-1">
              {t('whatsapp.cannotPreview')}
            </p>
            <p className="text-xs text-white/50">
              {fileTypeLabel} - {formattedSize}
            </p>
          </div>
        )}
      </main>

      {/* 3. BOTTOM CAROUSEL & CAPTION/SEND BAR */}
      <footer className="shrink-0 p-3 sm:p-4 pb-6 flex flex-col items-center relative z-20 gap-3">
        {/* Horizontal Thumbnail Strip (WhatsApp Web Carousel) */}
        <div className="w-full max-w-2xl flex items-center justify-center gap-2 overflow-x-auto py-1 px-2 no-scrollbar">
          {files.map((f, idx) => (
            <MediaThumbnailItem
              key={`${f.name}-${f.size}-${idx}`}
              file={f}
              isActive={idx === safeIndex}
              onClick={() => onActiveIndexChange(idx)}
              onRemove={(e) => handleRemoveFile(idx, e)}
              isSending={isSending}
            />
          ))}

          {/* Plus (+) Button to Add More Files to Queue */}
          {onAddMoreFiles && !isSending && (
            <button
              type="button"
              onClick={onAddMoreFiles}
              title={t('whatsapp.addMoreFiles') || 'Daha fazla ekle'}
              aria-label={t('whatsapp.addMoreFiles') || 'Daha fazla ekle'}
              className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl border-2 border-dashed border-white/30 hover:border-white/60 hover:bg-white/5 text-slate-300 hover:text-white flex items-center justify-center transition-all cursor-pointer shrink-0 active:scale-95"
            >
              <Plus className="w-6 h-6" />
            </button>
          )}
        </div>

        {/* Capsule Caption Input & Send Button */}
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

          {/* Capsule Caption Input */}
          <div className="flex-1 flex items-center bg-[#202c33] rounded-full px-4 py-2.5 sm:py-3 border border-white/5 shadow-inner focus-within:border-white/20 transition-all">
            <input
              ref={captionInputRef}
              type="text"
              value={currentCaption}
              onChange={(e) => onCaptionChange(safeIndex, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!isSending) onSendAll();
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
            onClick={onSendAll}
            disabled={isSending}
            title={files.length > 1 ? (t('whatsapp.sendAllFilesBtn') || 'Tümünü Gönder') : (t('whatsapp.sendFileBtn') || 'Gönder')}
            aria-label={t('whatsapp.sendFileBtn')}
            className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-[#25D366] hover:bg-[#20ba59] active:scale-95 text-white flex items-center justify-center shadow-lg shadow-[#25D366]/20 transition-all shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSending ? (
              <div className="flex flex-col items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
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
