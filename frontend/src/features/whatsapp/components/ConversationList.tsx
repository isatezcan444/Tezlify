import React, { useState, useRef, useCallback } from 'react';
import { MessageSquare, Archive, CheckCircle2, Inbox, Mail, MessageSquarePlus, RefreshCw, RotateCcw, Users, AlertTriangle } from 'lucide-react';
import { Conversation, ConversationStatus } from '../../../types';
import { Avatar } from '../../../components/ui/Avatar';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { SearchInput } from '../../../components/forms/SearchInput';
import { Skeleton } from '../../../components/ui/Skeleton';
import { useI18n } from '../../../context/I18nContext';
import { formatConversationTime } from '../../../lib/utils';
import { compareConversationsByActivityDesc, dedupeConversationsByCanonicalIdentity } from '../lib/whatsappOrdering';
import {
  extractCleanPhone,
  formatPhoneNumber,
  getConversationDisplayName,
  isRawWhatsAppJid,
  stripJidPrefix,
} from '../lib/whatsappIdentity';

// Kanonik kimlik yardımcıları tek bir modülde yaşar (features/whatsapp/lib/
// whatsappIdentity). Geriye dönük içe aktarımlar bozulmasın diye buradan
// yeniden dışa aktarılır — ikinci bir kopya TANIMLANMAZ.
export { extractCleanPhone, formatPhoneNumber, getConversationDisplayName, isRawWhatsAppJid, stripJidPrefix };

export type FilterTab = 'ALL' | 'ACTIVE' | 'GROUPS' | 'ARCHIVED' | 'CLOSED' | 'UNREAD';

export interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: number;
  onSelect: (conv: Conversation) => void;
  loading?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  activeFilter?: FilterTab;
  onFilterChange?: (filter: FilterTab) => void;
  onNewChat?: () => void;
  onSync?: () => void;
  isSyncing?: boolean;
  /** WhatsApp Web paritesi: karsi taraf su an yaziyorsa listede "yazıyor..."
   * (yesil) gosterilir. conversation_id -> bool. */
  typingMap?: Record<number, boolean>;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Sorun 1/16/17: LOADING ≠ EMPTY ≠ ERROR. Liste bileşenine AÇIK yükleme
   * durumu verilir:
   *  - 'loading': ilk conversation snapshot henüz gelmedi → skeleton,
   *    asla "sohbet yok" gösterilmez.
   *  - 'ready':   ilk yükleme tamamlandı → normal liste / gerçek empty state.
   *  - 'error':   GERÇEK initial-load hatası → ayrı error ekranı + retry.
   * Verilmemişse (eski çağıranlar) mevcut davranış korunur: `loading`
   * prop'u skeleton'u yönetir, boş liste 'ready' kabul edilir. */
  loadState?: 'loading' | 'ready' | 'error';
  /** loadState === 'error' iken gösterilecek gerçek hata mesajı. */
  loadError?: string | null;
  /** Error state'teki "tekrar dene" eylemi. */
  onRetryLoad?: () => void;
}

// PHASE 2.K.6 experiment: the conversation row extracted from the inline map, but
// fed PRIMITIVE / value props (the render-affecting `conv.*` fields) instead of the
// cloned `conv` object — so default React.memo shallow comparison can bail out
// unchanged rows. Behavior, JSX and formatting are preserved verbatim; only the
// prop contract changed. name is derived in the parent (getConversationDisplayName)
// and passed as a stable string. onSelect receives the row id; the parent maps it
// back to the real conversation so the click behavior is identical.
interface ConversationRowProps {
  id: number;
  name: string;
  avatarUrl?: string;
  phone?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  lastMessageState?: string;
  messageCount?: number;
  status: ConversationStatus;
  unreadCount: number;
  isGroup?: boolean;
  selected: boolean;
  typing: boolean;
  isSyncing: boolean;
  onSelect: (id: number) => void;
}

const ConversationRowComponent: React.FC<ConversationRowProps> = ({ id, name, avatarUrl, phone, lastMessagePreview, lastMessageAt, lastMessageState, messageCount, status, unreadCount, isGroup, selected, typing, isSyncing, onSelect }) => {
  const { t, language } = useI18n();
  const isRawJid = isRawWhatsAppJid(phone);
  const cleanPhone = extractCleanPhone(phone);
  const formatTime = (dateStr?: string) => formatConversationTime(dateStr, language);
  let lastMsg: string;
  if (typing) lastMsg = '__typing__';
  else if (lastMessagePreview) lastMsg = lastMessagePreview;
  else if (isSyncing) lastMsg = t('whatsapp.lastMessageSyncing');
  else if (lastMessageState === 'NO_MESSAGES' || (messageCount === 0 && lastMessageState !== 'REPAIRING' && lastMessageState !== 'LOADING')) lastMsg = t('leads.noMessagesTitle');
  else if (lastMessageState === 'REPAIRING' || lastMessageState === 'LOADING' || (typeof messageCount === 'number' && messageCount > 0)) lastMsg = t('whatsapp.lastMessageSyncing');
  else lastMsg = t('leads.noMessagesTitle');
  return (
    <button
      type="button"
      data-conv-id={id}
      data-phone={cleanPhone || undefined}
      onClick={() => onSelect(id)}
      className={`w-full text-left p-3.5 flex items-start space-x-3 transition-colors cursor-pointer ${
        selected
          ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15 border-l-4 border-[#7367F0]'
          : 'hover:bg-slate-100/60 dark:hover:bg-white/[0.04]'
      }`}
    >
      <Avatar
        name={name}
        image={avatarUrl}
        phone={cleanPhone || (!isRawJid && phone ? phone : undefined)}
        size="md"
        shape="rounded"
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-1.5 truncate">
            {isGroup && (
              <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25">
                <Users className="w-2.5 h-2.5" />
                <span>{t('whatsapp.group')}</span>
              </span>
            )}
            <h4 className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
              {name}
            </h4>
          </div>
          <span className="text-[10px] text-slate-400 font-medium shrink-0 ml-1">
            {lastMessageAt ? formatTime(lastMessageAt) : ''}
          </span>
        </div>

        {lastMsg === '__typing__' ? (
          <p className="text-[11px] text-[#25D366] dark:text-[#25D366] font-bold truncate mt-0.5 animate-pulse">
            {t('whatsapp.peerTyping')}
          </p>
        ) : (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
            {lastMsg}
          </p>
        )}

        {(status !== 'ACTIVE' || unreadCount > 0) && (
          <div className="flex items-center justify-end space-x-1.5 mt-1.5">
            {status !== 'ACTIVE' && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                {status === 'ARCHIVED' ? t('whatsapp.statusArchived') : t('whatsapp.statusClosed')}
              </span>
            )}
            {unreadCount > 0 && (
              <Badge variant="primary">
                {unreadCount}
              </Badge>
            )}
          </div>
        )}
      </div>
    </button>
  );
};

// PHASE 2.K.6 arm switch (single variable = memoization; primitive props identical both arms):
//   CONTROL   : const ConversationRow = ConversationRowComponent;
//   CANDIDATE : const ConversationRow = React.memo(ConversationRowComponent);
const ConversationRow = React.memo(ConversationRowComponent);

const ConversationListComponent: React.FC<ConversationListProps> = ({
  conversations,
  selectedId,
  onSelect,
  loading = false,
  searchQuery = '',
  onSearchChange,
  activeFilter = 'ALL',
  onFilterChange,
  onNewChat,
  onSync,
  isSyncing = false,
  typingMap,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  loadState,
  loadError = null,
  onRetryLoad,
}) => {

  const { t, language } = useI18n();
  // Stable row-select handler: the row gets an id (primitive), the parent maps it
  // back to the real conversation so onSelect(conv) behaves exactly as before.
  // Reads the latest `conversations` via a ref and depends only on the (already
  // stable) onSelect -> handleSelectById identity never changes -> row memo bails.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const handleSelectById = useCallback((cid: number) => {
    const c = conversationsRef.current.find((x) => x.id === cid);
    if (c) onSelect?.(c);
  }, [onSelect]);
  const [internalFilter, setInternalFilter] = useState<FilterTab>(activeFilter);
  const currentFilter = onFilterChange ? activeFilter : internalFilter;

  const handleFilterClick = (tab: FilterTab) => {
    if (onFilterChange) {
      onFilterChange(tab);
    } else {
      setInternalFilter(tab);
    }
  };

  const formatTime = (dateStr?: string) => {
    return formatConversationTime(dateStr, language);
  };

  const filtered = conversations.filter((c) => {
    // 1. Tab filter
    // Sorun 4 (WhatsApp paritesi): arsivli sohbetler ANA listeden gizlenir,
    // yalnizca "Arsiv" sekmesinde gorunur. Arsiv = WhatsApp arsiv durumu
    // (is_archived, gateway metadata) VEYA CRM status ARCHIVED (kullanici
    // aksiyonu) — ikisi de ayni sekmede toplanir.
    const archivedLike = Boolean(c.is_archived) || c.status === 'ARCHIVED';
    if (currentFilter === 'ALL' && archivedLike) return false;
    if (currentFilter === 'ACTIVE' && (c.status !== 'ACTIVE' || archivedLike)) return false;
    if (currentFilter === 'GROUPS' && (!c.is_group || archivedLike)) return false;
    if (currentFilter === 'ARCHIVED' && !archivedLike) return false;
    if (currentFilter === 'CLOSED' && c.status !== 'CLOSED') return false;
    if (currentFilter === 'UNREAD' && ((c.unread_count || 0) <= 0 || archivedLike)) return false;

    // 2. Search query filter
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const rawPhone = c.lead_phone || (c as any).phone || '';
    const rawName = c.lead_name || (c as any).name || '';
    const cleanPhone = extractCleanPhone(rawPhone) || extractCleanPhone(rawName);
    return (
      (rawName && rawName.toLowerCase().includes(q)) ||
      (rawPhone && rawPhone.toLowerCase().includes(q)) ||
      (cleanPhone && cleanPhone.toLowerCase().includes(q)) ||
      (c.last_message_preview && c.last_message_preview.toLowerCase().includes(q))
    );
  });

  const sorted = [...filtered].sort(compareConversationsByActivityDesc);

  // I-7: `conversation.id` is the primary authority for dedup — it is the
  // backend's unique conversation key. The old key truncated the phone to its
  // last 10 digits, which could merge two DIFFERENT people who share a suffix.
  // A canonical full-E.164 / JID key is used only when a row has no id.
  const deduplicated = React.useMemo(
    () => dedupeConversationsByCanonicalIdentity(sorted),
    [sorted],
  );

  // F-12: each filter has its OWN empty state. One generic message for
  // "no conversations at all", "none unread", "no groups", "none archived"
  // and "no search results" was misleading.
  const emptyStateKey = (() => {
    if (searchQuery.trim()) return 'whatsapp.emptySearch';
    switch (currentFilter) {
      case 'UNREAD':
        return 'whatsapp.emptyUnread';
      case 'GROUPS':
        return 'whatsapp.emptyGroups';
      case 'ARCHIVED':
        return 'whatsapp.emptyArchived';
      case 'ACTIVE':
        return 'whatsapp.emptyActive';
      case 'CLOSED':
        return 'whatsapp.emptyClosed';
      default:
        return 'whatsapp.noConversations';
    }
  })();

  // Faz 10 (P2): son mesaj satiri — "Henüz WhatsApp Mesajı Yok" YALNIZCA
  // sohbetin hic mesaji olmadigi dogrulaninca (message_count===0 &&
  // last_message_state==='NO_MESSAGES') gosterilir. Ozet henuz hesaplanmadiysa
  // (mesaj var / senkron suruyor) yaniltici "mesaj yok" yerine bekleme
  // metni gosterilir — kullaniciya yalan soylenemez (AGENTS.md Truthfulness).
  const renderLastMessage = (conv: Conversation) => {
    // WhatsApp Web paritesi: karsi taraf yaziyorsa son mesaj yerine yesil
    // "yazıyor..." gosterilir (hem liste hem acik sohbette ayni sinyal).
    if (typingMap?.[conv.id]) return '__typing__';
    if (conv.last_message_preview) return conv.last_message_preview;
    const state = conv.last_message_state;
    const count = conv.message_count;
    // Senkron suruyorsa hicbir sohbet icin "mesaj yok" iddiasinda bulunulmaz.
    if (isSyncing) return t('whatsapp.lastMessageSyncing');
    if (state === 'NO_MESSAGES' || (count === 0 && state !== 'REPAIRING' && state !== 'LOADING')) {
      return t('leads.noMessagesTitle');
    }
    if (state === 'REPAIRING' || state === 'LOADING' || (typeof count === 'number' && count > 0)) {
      return t('whatsapp.lastMessageSyncing');
    }
    // Eski/mock veri: state bilgisi yoksa onceki davranis (bos => mesaj yok).
    return t('leads.noMessagesTitle');
  };

  const filterTabs: { id: FilterTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'ALL', label: t('whatsapp.tabAll'), icon: Inbox },
    { id: 'ACTIVE', label: t('whatsapp.tabActive'), icon: MessageSquare },
    // Sorun 4: grup sohbetleri ayri sekme (JID @g.us — backend is_group).
    { id: 'GROUPS', label: t('whatsapp.tabGroups'), icon: Users },
    { id: 'UNREAD', label: t('whatsapp.tabUnread'), icon: Mail },
    { id: 'ARCHIVED', label: t('whatsapp.tabArchived'), icon: Archive },
    { id: 'CLOSED', label: t('whatsapp.tabClosed'), icon: CheckCircle2 },
  ];

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    const target = e.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
      onLoadMore();
    }
  };

  // Sorun 1/16/17: liste durumu ÜÇ ayrı state olarak çözülür —
  //   LOADING (ilk snapshot bekleniyor) ≠ EMPTY (gerçekten 0 sohbet) ≠ ERROR.
  // `loadState` verilmediyse eski davranış: `loading` prop'u skeleton'u,
  // boş liste ise 'ready' (gerçek empty state) anlamına gelir.
  const effectiveLoadState: 'loading' | 'ready' | 'error' =
    loadState ?? (loading ? 'loading' : 'ready');
  const showSkeleton = effectiveLoadState === 'loading' || (loading && effectiveLoadState !== 'error');
  const showError = effectiveLoadState === 'error';

  return (
    <div className="flex flex-col h-full border-r border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/10">
      {/* Top Action Bar & Search Header */}
      <div className="p-3 border-b border-slate-200/80 dark:border-white/[0.08] space-y-2.5">

        {/* Action Buttons: New Chat & Sync WhatsApp */}
        {(onNewChat || onSync) && (
          <div className="flex items-center gap-2">
            {onNewChat && (
              <Button
                type="button"
                size="sm"
                onClick={onNewChat}
                className="flex-1 space-x-1.5 bg-[#25D366] hover:bg-[#20ba59] text-white font-bold text-xs cursor-pointer shadow-xs"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
                <span>{t('whatsapp.newChat')}</span>
              </Button>
            )}
            {onSync && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSync}
                disabled={isSyncing}
                title={t('whatsapp.syncChats')}
                className="px-2.5 space-x-1 text-xs font-bold border-slate-200 dark:border-white/[0.1] hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-[#7367F0] ${isSyncing ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{t('whatsapp.sync')}</span>
              </Button>
            )}
          </div>
        )}

        {onSearchChange && (
          <SearchInput
            value={searchQuery}
            onChange={onSearchChange}
            placeholder={t('whatsapp.searchConversations')}
            sizeVariant="sm"
          />
        )}

          {/* Filter Pills */}
          <div className="flex items-center space-x-1 overflow-x-auto pb-0.5 scrollbar-none">
            {filterTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = currentFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleFilterClick(tab.id)}
                  className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#7367F0] text-white shadow-sm shadow-[#7367F0]/25'
                      : 'bg-slate-200/50 dark:bg-white/[0.06] text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

      {/* List content */}
      <div onScroll={handleScroll} className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04]">

        {showError ? (
          // GERÇEK initial-load hatası: "sohbet yok" veya skeleton DEĞİL —
          // hata + retry. Mevcut mesajlar/liste verisi silinmez.
          <div className="p-6 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-rose-500/70" />
            <p className="text-xs font-bold text-rose-600 dark:text-rose-400">
              {t('whatsapp.loadFailedChats')}
            </p>
            {loadError && (
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400 break-words">{loadError}</p>
            )}
            {onRetryLoad && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryLoad}
                className="mt-3 space-x-1.5 text-xs font-bold cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t('whatsapp.syncRetry')}</span>
              </Button>
            )}
          </div>
        ) : showSkeleton ? (
          // LOADING state: ilk conversation snapshot gelene kadar skeleton —
          // araya asla "sohbet bulunamadı" / "mesajlar yüklenemedi" girmez.
          <div className="p-3 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center space-x-3 p-2">
                <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="w-24 h-3.5" />
                  <Skeleton className="w-36 h-3" />
                </div>
              </div>
            ))}
          </div>
        ) : deduplicated.length === 0 ? (
          // EMPTY state: yalnızca ilk yükleme GERÇEKTEN tamamlandığında ve
          // aktif filtrede gerçekten 0 sonuç olduğunda gösterilir.
          <div className="p-6 text-center text-slate-400 dark:text-slate-500 text-xs">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>{t(emptyStateKey)}</p>
          </div>
        ) : (
          deduplicated.map((conv) => (
            <ConversationRow
              key={conv.id}
              id={conv.id}
              name={getConversationDisplayName(conv, t)}
              avatarUrl={conv.lead_avatar_url}
              phone={conv.lead_phone || (conv as any).phone}
              lastMessagePreview={conv.last_message_preview}
              lastMessageAt={conv.last_message_at}
              lastMessageState={conv.last_message_state}
              messageCount={conv.message_count}
              status={conv.status}
              unreadCount={conv.unread_count}
              isGroup={conv.is_group}
              selected={selectedId === conv.id}
              typing={!!typingMap?.[conv.id]}
              isSyncing={isSyncing}
              onSelect={handleSelectById}
            />
          ))
        )}
        {loadingMore && (
          <div className="p-3 text-center text-xs text-slate-400 dark:text-slate-500 flex items-center justify-center space-x-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#7367F0]" />
            <span>{t('whatsapp.loadingMore')}</span>
          </div>
        )}
      </div>

    </div>
  );
};

// PHASE 2.K.4 single-variable experiment (part 2 of 2): default shallow-compare memo.
// Effective only together with the stabilized callback props in WhatsAppHubPage.
export const ConversationList = React.memo(ConversationListComponent);
