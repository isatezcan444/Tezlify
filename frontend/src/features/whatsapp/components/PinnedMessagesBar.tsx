import React, { useState, useMemo } from 'react';
import { Pin, X, ChevronRight, ChevronLeft, Image as ImageIcon, Music, Video, FileText } from 'lucide-react';
import { Message } from '../../../types';
import { useI18n } from '../../../context/I18nContext';

export interface PinnedMessagesBarProps {
  pinnedMessages: Message[];
  onJumpToMessage: (message: Message) => void;
  onUnpinMessage?: (message: Message) => void;
  className?: string;
}

export const PinnedMessagesBar: React.FC<PinnedMessagesBarProps> = ({
  pinnedMessages,
  onJumpToMessage,
  onUnpinMessage,
  className = '',
}) => {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(0);

  // If list changes or index out of bounds, reset index
  const safeIndex = useMemo(() => {
    if (pinnedMessages.length === 0) return 0;
    if (currentIndex >= pinnedMessages.length) return pinnedMessages.length - 1;
    if (currentIndex < 0) return 0;
    return currentIndex;
  }, [currentIndex, pinnedMessages.length]);

  if (!pinnedMessages || pinnedMessages.length === 0) {
    return null;
  }

  const currentMessage = pinnedMessages[safeIndex];

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev + 1) % pinnedMessages.length);
  };

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev - 1 + pinnedMessages.length) % pinnedMessages.length);
  };

  const handleBarClick = () => {
    if (currentMessage) {
      onJumpToMessage(currentMessage);
    }
  };

  const handleUnpin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentMessage && onUnpinMessage) {
      onUnpinMessage(currentMessage);
    }
  };

  const renderMediaSnippet = (msg: Message) => {
    if (msg.message_type === 'IMAGE') {
      return (
        <span className="flex items-center gap-1">
          <ImageIcon className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="truncate">{msg.media_caption || t('whatsapp.image')}</span>
        </span>
      );
    }
    if (msg.message_type === 'AUDIO') {
      return (
        <span className="flex items-center gap-1">
          <Music className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="truncate">{t('whatsapp.audio')}</span>
        </span>
      );
    }
    if (msg.message_type === 'VIDEO') {
      return (
        <span className="flex items-center gap-1">
          <Video className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="truncate">{msg.media_caption || t('whatsapp.video')}</span>
        </span>
      );
    }
    if (msg.message_type === 'DOCUMENT') {
      return (
        <span className="flex items-center gap-1">
          <FileText className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="truncate">{msg.media_filename || t('whatsapp.document')}</span>
        </span>
      );
    }
    return <span className="truncate">{msg.body || t('whatsapp.pinnedMessage')}</span>;
  };

  const senderName =
    currentMessage.direction === 'OUTBOUND'
      ? t('whatsapp.you')
      : currentMessage.sender_name || currentMessage.sender_phone || t('whatsapp.contact');

  return (
    <div
      data-testid="pinned-messages-bar"
      onClick={handleBarClick}
      className={`relative z-10 flex items-center justify-between px-3.5 py-2 bg-white/95 dark:bg-[#202c33]/95 backdrop-blur-md border-b border-slate-200/80 dark:border-white/5 shadow-xs transition-all cursor-pointer hover:bg-slate-50/90 dark:hover:bg-[#233138]/90 select-none ${className}`}
    >
      {/* Sol taraf: İkon ve Mesaj İçeriği */}
      <div className="flex items-center space-x-3 min-w-0 flex-1 mr-2">
        <div className="w-7 h-7 rounded-lg bg-amber-500/15 dark:bg-amber-400/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <Pin className="w-4 h-4 -rotate-45 fill-amber-500/30" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
              {senderName}
            </span>
            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium shrink-0">
              {t('whatsapp.pinned')}
            </span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {renderMediaSnippet(currentMessage)}
          </div>
        </div>
      </div>

      {/* Sağ taraf: Çoklu pin navigasyonu, atlama ve sabitlemeyi kaldır butonu */}
      <div className="flex items-center space-x-1.5 shrink-0">
        {pinnedMessages.length > 1 && (
          <div className="flex items-center space-x-1 mr-1">
            <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
              {safeIndex + 1}/{pinnedMessages.length}
            </span>
            <button
              type="button"
              onClick={handlePrev}
              data-testid="pinned-bar-prev-btn"
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors"
              title={t('common.previous')}
              aria-label={t('common.previous')}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              data-testid="pinned-bar-next-btn"
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors"
              title={t('common.next')}
              aria-label={t('common.next')}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleBarClick}
          data-testid="pinned-bar-jump-btn"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-white/10 transition-colors"
          title={t('whatsapp.jumpToMessage')}
          aria-label={t('whatsapp.jumpToMessage')}
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {onUnpinMessage && (
          <button
            type="button"
            onClick={handleUnpin}
            data-testid="pinned-bar-unpin-btn"
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            title={t('whatsapp.menuUnpin')}
            aria-label={t('whatsapp.menuUnpin')}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
