import React, { useRef, useMemo } from 'react';
import {
  X,
  Search,
  Calendar,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  ArrowRight,
} from 'lucide-react';
import { Message } from '../../../types';
import { useI18n } from '../../../context/I18nContext';
import { formatMessageDate, formatMessageTime } from '../../../lib/utils';
import { filterMatchingMessages } from '../lib/whatsappChatSearch';

export interface ChatSearchResultsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: Message[];
  query: string;
  onQueryChange: (query: string) => void;
  activeMessageId: number | null;
  onSelectMessage: (messageId: number) => void;
  onJumpToDate?: (dateStr: string) => void;
  conversationTitle?: string;
  isGroup?: boolean;
}

export const ChatSearchResultsDrawer: React.FC<ChatSearchResultsDrawerProps> = ({
  isOpen,
  onClose,
  messages,
  query,
  onQueryChange,
  activeMessageId,
  onSelectMessage,
  onJumpToDate,
  conversationTitle,
  isGroup = false,
}) => {
  const { t, language } = useI18n();
  const dateInputRef = useRef<HTMLInputElement>(null);

  const matchedMessages = useMemo(() => {
    return filterMatchingMessages(messages, query);
  }, [messages, query]);

  if (!isOpen) return null;

  const handleOpenDatePicker = () => {
    if (dateInputRef.current) {
      if (typeof dateInputRef.current.showPicker === 'function') {
        dateInputRef.current.showPicker();
      } else {
        dateInputRef.current.focus();
      }
    }
  };

  const handleDateSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val && onJumpToDate) {
      onJumpToDate(val);
    }
  };

  const highlightMatches = (text: string): React.ReactNode => {
    if (!query || !query.trim() || !text) return text;
    const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const tokens = text.split(regex);
    if (tokens.length === 1) return text;
    return tokens.map((token, i) =>
      regex.test(token) ? (
        <mark
          key={i}
          className="bg-[#00a884]/20 dark:bg-[#25D366]/30 text-emerald-800 dark:text-emerald-300 font-semibold rounded-xs px-0.5"
        >
          {token}
        </mark>
      ) : (
        token
      )
    );
  };

  const hasQuery = query.trim().length > 0;

  return (
    <aside
      role="region"
      aria-label={t('whatsapp.searchMessages')}
      data-testid="chat-search-results-drawer"
      className="w-80 md:w-96 shrink-0 border-l border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-[#111b21] flex flex-col h-full z-20 animate-in slide-in-from-right duration-200 ease-out select-text"
    >
      {/* 1. Header Bar */}
      <header className="h-[60px] px-4 border-b border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#202c33] flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="close-search-drawer-btn"
            aria-label={t('common.close')}
            title={t('common.close')}
            className="p-1.5 rounded-full text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.08] active:scale-90 transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
          <h3 className="font-bold text-sm text-slate-800 dark:text-slate-100">
            {t('whatsapp.searchMessages')}
          </h3>
        </div>
      </header>

      {/* 2. Search & Filter Bar */}
      <div className="p-3 bg-white dark:bg-[#202c33] border-b border-slate-200/80 dark:border-white/[0.08] shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 flex items-center min-w-0">
            <Search className="absolute left-3 w-4 h-4 text-slate-400 dark:text-[#8696a0] pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t('whatsapp.searchMessagesPlaceholder')}
              aria-label={t('whatsapp.searchMessages')}
              data-testid="drawer-search-input"
              className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-slate-100 dark:bg-[#111b21] text-slate-800 dark:text-[#e9edef] placeholder-slate-400 dark:placeholder-[#8696a0] border border-transparent focus:border-[#00a884] dark:focus:border-[#00a884] focus:outline-none transition-colors"
            />
            {hasQuery && (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                className="absolute right-2.5 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                aria-label={t('common.clear')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {onJumpToDate && (
            <div className="relative shrink-0 flex items-center">
              <input
                ref={dateInputRef}
                type="date"
                onChange={handleDateSelected}
                className="sr-only"
                aria-label={t('whatsapp.jumpToDate')}
                tabIndex={-1}
              />
              <button
                type="button"
                onClick={handleOpenDatePicker}
                title={t('whatsapp.jumpToDate')}
                aria-label={t('whatsapp.jumpToDate')}
                data-testid="drawer-jump-to-date-btn"
                className="p-2 rounded-xl text-slate-500 hover:text-slate-700 dark:text-[#8696a0] dark:hover:text-white bg-slate-100 dark:bg-[#111b21] hover:bg-slate-200/80 dark:hover:bg-white/[0.08] transition-colors cursor-pointer border border-transparent hover:border-slate-300 dark:hover:border-white/10"
              >
                <Calendar className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {hasQuery && (
          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-[#8696a0] px-1 font-medium">
            <span>
              {t('whatsapp.matchingMessagesCount', { count: String(matchedMessages.length) })}
            </span>
          </div>
        )}
      </div>

      {/* 3. Results List / Empty Guide */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-0">
        {!hasQuery ? (
          <div className="flex flex-col items-center justify-center p-6 text-center space-y-3 mt-6">
            <div className="w-12 h-12 rounded-2xl bg-[#00a884]/10 text-[#00a884] dark:text-[#25D366] flex items-center justify-center">
              <Search className="w-6 h-6" />
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-[220px] leading-relaxed">
              {t('whatsapp.searchGuideText')}
            </p>
            {onJumpToDate && (
              <button
                type="button"
                onClick={handleOpenDatePicker}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#202c33] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors cursor-pointer border border-slate-200/80 dark:border-white/[0.06]"
              >
                <Calendar className="w-3.5 h-3.5 text-[#00a884]" />
                <span>{t('whatsapp.jumpToDate')}</span>
              </button>
            )}
          </div>
        ) : matchedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center space-y-2 mt-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
              <Search className="w-6 h-6" />
            </div>
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {t('whatsapp.noSearchMatches')}
            </p>
            <p className="text-[11px] text-slate-400">
              "{query}"
            </p>
          </div>
        ) : (
          matchedMessages.map((msg) => {
            const isMatchActive = activeMessageId === Number(msg.id);
            const rawTimestamp = msg.created_at || msg.external_timestamp || (msg as any).timestamp;
            const msgDateStr = rawTimestamp ? (typeof rawTimestamp === 'number' ? new Date(rawTimestamp).toISOString() : String(rawTimestamp)) : null;
            const dateLabel = msgDateStr ? formatMessageDate(msgDateStr, language) : '';
            const timeLabel = msgDateStr ? formatMessageTime(msgDateStr, language) : '';
            const isInbound = msg.direction === 'INBOUND';
            const senderName = isGroup
              ? isInbound
                ? (msg.sender_name || (msg.sender_phone ? msg.sender_phone : conversationTitle))
                : (language === 'tr' ? 'Siz' : 'You')
              : isInbound
              ? conversationTitle || (language === 'tr' ? 'Kişi' : 'Contact')
              : (language === 'tr' ? 'Siz' : 'You');

            const mime = (msg.media_mime_type || '').toLowerCase();
            const isImage = mime.startsWith('image/');
            const isVideo = mime.startsWith('video/');
            const isAudio = mime.startsWith('audio/');
            const isDoc = msg.media_filename && !isImage && !isVideo && !isAudio;

            return (
              <div
                key={msg.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectMessage(Number(msg.id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectMessage(Number(msg.id));
                  }
                }}
                data-testid={`search-result-card-${msg.id}`}
                className={`p-3 rounded-2xl transition-all cursor-pointer border select-none group/card ${
                  isMatchActive
                    ? 'bg-[#00a884]/10 dark:bg-[#00a884]/20 border-[#00a884] dark:border-[#25D366] shadow-sm'
                    : 'bg-white dark:bg-[#202c33] border-slate-200/80 dark:border-white/[0.06] hover:border-[#00a884]/50 dark:hover:border-[#00a884]/40 shadow-xs'
                }`}
              >
                {/* Sender & Timestamp */}
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span
                    className={`font-bold truncate max-w-[150px] ${
                      isInbound ? 'text-slate-700 dark:text-slate-200' : 'text-[#00a884] dark:text-[#25D366]'
                    }`}
                  >
                    {senderName}
                  </span>
                  <div className="flex items-center space-x-1.5 text-slate-400 dark:text-[#8696a0] shrink-0 text-[10px]">
                    {dateLabel && <span>{dateLabel}</span>}
                    {timeLabel && <span>• {timeLabel}</span>}
                  </div>
                </div>

                {/* Message Body or Caption */}
                {msg.body && (
                  <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
                    {highlightMatches(msg.body)}
                  </p>
                )}

                {/* Media Attachment Indicator */}
                {msg.media_caption && !msg.body && (
                  <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
                    {highlightMatches(msg.media_caption)}
                  </p>
                )}

                {msg.media_filename && (
                  <div className="flex items-center space-x-1.5 mt-1.5 text-[11px] font-semibold text-[#00a884] dark:text-[#25D366]">
                    {isImage ? (
                      <ImageIcon className="w-3.5 h-3.5 shrink-0" />
                    ) : isVideo ? (
                      <Film className="w-3.5 h-3.5 shrink-0" />
                    ) : isAudio ? (
                      <Music className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate">{highlightMatches(msg.media_filename)}</span>
                  </div>
                )}

                {/* Jump prompt on hover */}
                <div className="flex items-center justify-end mt-2 pt-1.5 border-t border-slate-100 dark:border-white/[0.04] opacity-0 group-hover/card:opacity-100 transition-opacity text-[10px] text-[#00a884] dark:text-[#25D366] font-bold">
                  <span className="inline-flex items-center gap-1">
                    {t('whatsapp.jumpToMessage')}
                    <ArrowRight className="w-3 h-3" />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
