import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, ArrowUp, RotateCcw } from 'lucide-react';
import { Message } from '../../../types';
import { ChatBubble } from './ChatBubble';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Skeleton } from '../../../components/ui/Skeleton';
import { WhatsAppIcon } from '../../../components/ui/whatsapp-icon';
import { useI18n } from '../../../context/I18nContext';
import { parseServerTime, formatMessageDate } from '../../../lib/utils';
import { finishWaLatency } from '../lib/whatsappLatency';

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
  /** Faz 6a: grup sohbetinde balonlarda katilimci adlari gosterilir. */
  isGroup?: boolean;
  onRetry?: (messageId: number | string) => Promise<void> | void;
  peerTyping?: boolean;
  /** Sorun 2 (LOADING ≠ EMPTY ≠ ERROR): bu sohbetin MESAJ hidrasyonu
   * basarisiz olduysa hata mesaji. Yalnizca BU sohbeti etkiler — diger
   * sohbetler ve liste etkilenmez; mevcut mesajlar varsa silinmez. */
  error?: string | null;
  /** Hidrasyon hatasindan sonra "tekrar dene". */
  onRetryLoad?: () => void;
  /** Eski sayfa (history pagination) basarisiz mi — mevcut mesajlar korunur. */
  pagingError?: boolean;
}

export const ChatThread: React.FC<ChatThreadProps> = ({
  messages,
  loading = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  leadName,
  isGroup = false,
  onRetry,
  peerTyping = false,
  error = null,
  onRetryLoad,
  pagingError = false,
}) => {
  const { t, language } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (messages.length) finishWaLatency('chat_request_to_commit_ms', messages[0].conversation_id);
  }, [messages]);

  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  // Snapshot of the thread at the moment a prepend was requested. It lets the
  // restore effect tell a REAL prepend (older messages added at the front)
  // apart from any other change, so an unrelated event can never apply a
  // bogus scrollTop or leave the guard stuck.
  const pendingPrependRef = useRef<{ firstId: string | number | null; count: number } | null>(null);
  const prevMessagesCountRef = useRef<number>(messages.length);
  // P6-7: pagination must not fire before the thread has taken its initial
  // position. On mount `scrollTop` is still 0, so any scroll event raised while
  // the initial scroll is running looks exactly like "the user is at the top".
  const initialScrollDoneRef = useRef<boolean>(false);

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

    // Scroll upward -> older page request
    if (scrollTop < 60 && hasMore && !loadingOlder && initialScrollDoneRef.current) {
      handleLoadOlder();
    }
  };

  // Trigger loading older messages and track previous scroll height
  const handleLoadOlder = () => {
    if (!onLoadOlder || loadingOlder || !containerRef.current) return;
    const first = sortedMessages[0];
    pendingPrependRef.current = {
      firstId: first ? (first.wa_message_id || first.id) : null,
      count: sortedMessages.length,
    };
    isPrependingRef.current = true;
    prevScrollHeightRef.current = containerRef.current.scrollHeight;
    prevScrollTopRef.current = containerRef.current.scrollTop;
    try {
      onLoadOlder();
    } catch (err) {
      // F-10: a synchronous throw must never leave the guard set.
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
      console.error('[ChatThread] onLoadOlder failed:', err);
    }
  };

  // Restore scroll position after prepending older messages.
  //
  // F-10: the guard is released on EVERY path:
  //  - a real prepend restores the viewport and clears the guard;
  //  - the no-more / error / zero-result path (nothing prepended once the
  //    request is no longer in flight) clears the guard WITHOUT moving the
  //    viewport, so a later unrelated message change cannot apply a bogus
  //    scrollTop or suppress auto-scroll.
  useLayoutEffect(() => {
    if (!isPrependingRef.current) return;
    const pending = pendingPrependRef.current;
    const first = sortedMessages[0];
    const firstId = first ? (first.wa_message_id || first.id) : null;
    const didPrepend =
      Boolean(pending) &&
      sortedMessages.length > pending!.count &&
      firstId !== pending!.firstId;
    if (didPrepend && containerRef.current) {
      const newScrollHeight = containerRef.current.scrollHeight;
      const heightDiff = newScrollHeight - prevScrollHeightRef.current;
      containerRef.current.scrollTop = prevScrollTopRef.current + heightDiff;
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
      return;
    }
    if (!loadingOlder) {
      isPrependingRef.current = false;
      pendingPrependRef.current = null;
    }
  }, [sortedMessages, loadingOlder]);

  // Identity of the NEWEST rendered message. Loading an older page grows the
  // list but leaves the newest message untouched; only a genuinely new message
  // changes it. The count alone is not enough: the prepend-restore layout
  // effect above clears `isPrependingRef` before this passive effect runs, so
  // a prepend would otherwise be reported to the user as "new messages".
  const newestKey = sortedMessages.length
    ? String(
        sortedMessages[sortedMessages.length - 1].wa_message_id ||
          sortedMessages[sortedMessages.length - 1].id
      )
    : null;
  const prevNewestKeyRef = useRef<string | null>(newestKey);

  // Smart Auto-Scroll when new messages arrive at the end
  useEffect(() => {
    const isNewMessageAdded =
      sortedMessages.length > prevMessagesCountRef.current &&
      newestKey !== prevNewestKeyRef.current;
    prevMessagesCountRef.current = sortedMessages.length;
    prevNewestKeyRef.current = newestKey;

    if (isNewMessageAdded && !isPrependingRef.current) {
      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        setShowNewMessagePill(false);
      } else {
        setShowNewMessagePill(true);
      }
    }
  }, [sortedMessages, isNearBottom]);

  // Initial scroll to bottom on mount or load.
  //
  // P6-7: `behavior: 'auto'` DEFERS TO CSS, and the container carries
  // `scroll-smooth`, so the initial jump was actually animated from scrollTop 0
  // up through the < 60px pagination trigger — opening ANY chat fired an
  // older-page request, whose prepend-restore then knocked the viewport off the
  // newest message. `'instant'` forces a real jump (and is what WhatsApp Web
  // does: opening a chat should not animate through the whole history).
  useEffect(() => {
    if (!loading && sortedMessages.length > 0 && isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
    initialScrollDoneRef.current = true;
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
      <div className="flex-1 min-w-0 p-4 space-y-4 overflow-y-auto overflow-x-hidden">
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
    // Sorun 2: hidrasyon GERÇEKTEN basarisiz olduysa "mesaj yok" DEGIL —
    // ayri error state + retry. Bu yalnizca BU sohbetin durumudur.
    if (error) {
      return (
        <div className="relative flex-1 min-w-0 flex flex-col items-center justify-center p-6 min-h-0">
          <EmptyState
            icon={AlertTriangle}
            title={t('whatsapp.messagesLoadFailed')}
            description={error}
            action={
              onRetryLoad
                ? { label: t('whatsapp.retryBtn'), onClick: onRetryLoad, icon: RotateCcw }
                : undefined
            }
          />
          {peerTyping && (
            <div className="absolute bottom-3 left-4">
              <TypingBubble label={t('whatsapp.peerTyping')} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="relative flex-1 min-w-0 flex flex-col items-center justify-center p-6 min-h-0">
        <EmptyState
          icon={WhatsAppIcon}
          title={t('leads.noMessagesTitle')}
          description={t('leads.noMessagesDesc')}
        />
        {peerTyping && (
          <div className="absolute bottom-3 left-4">
            <TypingBubble label={t('whatsapp.peerTyping')} />
          </div>
        )}
      </div>
    );
  }

  let lastDate = '';

  return (
    // Sorun 11/12: thread kökü `min-w-0` — flex parent içindeki mesaj içeriği
    // (uzun URL/JID) asla main chat alanını yatay olarak genişletemez.
    <div className="relative flex-1 min-w-0 flex flex-col min-h-0">
      {/* Sorun 2: eski mesaj sayfasi basarisizsa mevcut mesajlar SİLİNMEZ —
          ustte retry edilebilir bir bilgi seridi gosterilir. */}
      {pagingError && (
        <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-600 dark:text-rose-400 text-[11px] font-bold">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t('whatsapp.messagesLoadFailed')}</span>
          {onLoadOlder && (
            <button
              type="button"
              onClick={onLoadOlder}
              className="underline underline-offset-2 hover:opacity-80 cursor-pointer"
            >
              {t('leads.loadOlderMessages')}
            </button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-w-0 p-4 overflow-y-auto overflow-x-hidden space-y-1 scroll-smooth"
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
                  <span>{t('leads.loadingOlderMessages')}</span>
                </>
              ) : (
                <>
                  <ArrowUp className="w-3.5 h-3.5" />
                  <span>{t('leads.loadOlderMessages')}</span>
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
              <ChatBubble message={msg} isGroup={isGroup} chatTitle={leadName} onRetry={onRetry} />
            </React.Fragment>
          );
        })}
        {peerTyping && (
          <div className="flex justify-start pt-1">
            <TypingBubble label={t('whatsapp.peerTyping')} />
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
            <span>{t('leads.newMessageAlert')}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
