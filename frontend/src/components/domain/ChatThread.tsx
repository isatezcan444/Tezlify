import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, ArrowUp } from 'lucide-react';
import { Message } from '../../types';
import { ChatBubble } from './ChatBubble';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { WhatsAppIcon } from '../ui/whatsapp-icon';
import { useI18n } from '../../context/I18nContext';
import { parseServerTime, formatMessageDate } from '../../lib/utils';

/** WhatsApp Web tarzı 'yazıyor...' balonu (üç zıplayan nokta). */
const TypingBubble: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="inline-flex items-center space-x-1.5 px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-white dark:bg-[#1E2333] shadow-sm border border-slate-200/80 dark:border-white/[0.08]"
    aria-label={label}
  >
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce"
        style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
      />
    ))}
  </div>
);

export interface ChatThreadProps {
  messages: Message[];
  loading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  leadName?: string;
  leadPhone?: string;
  onRetry?: (messageId: number | string) => Promise<void> | void;
  peerTyping?: boolean;
}

export const ChatThread: React.FC<ChatThreadProps> = ({
  messages,
  loading = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  onRetry,
  peerTyping = false,
}) => {
  const { t, language } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  const prevMessagesCountRef = useRef<number>(messages.length);

  const [isNearBottom, setIsNearBottom] = useState<boolean>(true);
  const [showNewMessagePill, setShowNewMessagePill] = useState<boolean>(false);

  // Guarantee strictly chronological message order in the thread
  const sortedMessages = React.useMemo(() => {
    return [...messages].sort((a, b) => {
      const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
      const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
      if (tA !== tB) return tA - tB;
      const nA = typeof a.id === 'number' ? a.id : 0;
      const nB = typeof b.id === 'number' ? b.id : 0;
      return nA - nB;
    });
  }, [messages]);

  // Monitor scroll position
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceToBottom < 120;
    setIsNearBottom(nearBottom);

    if (nearBottom) {
      setShowNewMessagePill(false);
    }
  };

  // Trigger loading older messages and track previous scroll height
  const handleLoadOlder = () => {
    if (!onLoadOlder || loadingOlder || !containerRef.current) return;
    isPrependingRef.current = true;
    prevScrollHeightRef.current = containerRef.current.scrollHeight;
    prevScrollTopRef.current = containerRef.current.scrollTop;
    onLoadOlder();
  };

  // Restore scroll position after prepending older messages
  useLayoutEffect(() => {
    if (isPrependingRef.current && containerRef.current) {
      const newScrollHeight = containerRef.current.scrollHeight;
      const heightDiff = newScrollHeight - prevScrollHeightRef.current;
      containerRef.current.scrollTop = prevScrollTopRef.current + heightDiff;
      isPrependingRef.current = false;
    }
  }, [sortedMessages]);

  // Smart Auto-Scroll when new messages arrive at the end
  useEffect(() => {
    const isNewMessageAdded = sortedMessages.length > prevMessagesCountRef.current;
    prevMessagesCountRef.current = sortedMessages.length;

    if (isNewMessageAdded && !isPrependingRef.current) {
      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        setShowNewMessagePill(false);
      } else {
        setShowNewMessagePill(true);
      }
    }
  }, [sortedMessages, isNearBottom]);

  // Initial scroll to bottom on mount or load
  useEffect(() => {
    if (!loading && sortedMessages.length > 0 && isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [loading]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowNewMessagePill(false);
  };

  const getDateLabel = (dateStr?: string) => {
    return formatMessageDate(dateStr, language, t('leads.today'), t('leads.yesterday'));
  };

  if (loading) {
    return (
      <div className="flex-1 p-4 space-y-4 overflow-y-auto">
        <div className="flex justify-start">
          <Skeleton className="w-48 h-12 rounded-2xl rounded-tl-sm" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="w-56 h-14 rounded-2xl rounded-tr-sm" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="w-64 h-16 rounded-2xl rounded-tl-sm" />
        </div>
      </div>
    );
  }

  if (!sortedMessages || sortedMessages.length === 0) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center p-6 min-h-0">
        <EmptyState
          icon={WhatsAppIcon}
          title={t('leads.noMessagesTitle')}
          description={t('leads.noMessagesDesc')}
        />
        {peerTyping && (
          <div className="absolute bottom-3 left-4">
            <TypingBubble label={t('whatsapp.peerTyping') || 'yazıyor...'} />
          </div>
        )}
      </div>
    );
  }

  let lastDate = '';

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 p-4 overflow-y-auto space-y-1 scroll-smooth"
      >
        {/* Load older messages button */}
        {hasMore && (
          <div className="flex justify-center my-2">
            <button
              type="button"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold text-[#7367F0] bg-[#7367F0]/10 hover:bg-[#7367F0]/20 border border-[#7367F0]/20 transition-all cursor-pointer disabled:opacity-50"
            >
              {loadingOlder ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('leads.loadingOlderMessages') || 'Eski mesajlar yükleniyor...'}</span>
                </>
              ) : (
                <>
                  <ArrowUp className="w-3.5 h-3.5" />
                  <span>{t('leads.loadOlderMessages') || 'Daha Eski Mesajları Yükle'}</span>
                </>
              )}
            </button>
          </div>
        )}

        {sortedMessages.map((msg) => {
          const currentDate = getDateLabel(msg.created_at || msg.external_timestamp);
          const showDateSeparator = currentDate && currentDate !== lastDate;
          if (showDateSeparator) {
            lastDate = currentDate;
          }

          return (
            <React.Fragment key={msg.wa_message_id || msg.id}>
              {showDateSeparator && (
                <div className="flex items-center justify-center my-4">
                  <span className="px-3 py-1 rounded-full text-[10px] font-bold bg-slate-200/80 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400 select-none shadow-xs">
                    {currentDate}
                  </span>
                </div>
              )}
              <ChatBubble message={msg} onRetry={onRetry} />
            </React.Fragment>
          );
        })}
        {peerTyping && (
          <div className="flex justify-start pt-1">
            <TypingBubble label={t('whatsapp.peerTyping') || 'yazıyor...'} />
          </div>
        )}
        <div ref={bottomRef} className="h-1" />
      </div>

      {/* Floating New Message Indicator */}
      {showNewMessagePill && (
        <div className="absolute bottom-4 right-4 z-10 animate-bounce">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-full bg-[#25D366] hover:bg-[#1EBE5D] text-white text-xs font-bold shadow-lg shadow-[#25D366]/30 transition-all cursor-pointer"
          >
            <span>{t('leads.newMessageAlert') || 'Yeni Mesaj'}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
