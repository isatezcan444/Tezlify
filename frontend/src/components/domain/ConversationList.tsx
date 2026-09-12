import React, { useState } from 'react';
import { MessageSquare, Archive, CheckCircle2, Inbox, Mail, MessageSquarePlus, RefreshCw, Users } from 'lucide-react';
import { Conversation, ConversationStatus } from '../../types';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SearchInput } from '../forms/SearchInput';
import { Skeleton } from '../ui/Skeleton';
import { useI18n } from '../../context/I18nContext';
import { parseServerTime, formatConversationTime } from '../../lib/utils';

export type FilterTab = 'ALL' | 'ACTIVE' | 'ARCHIVED' | 'CLOSED' | 'UNREAD';

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
}

export const ConversationList: React.FC<ConversationListProps> = ({
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
}) => {
  const { t, language } = useI18n();
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
    if (currentFilter === 'ACTIVE' && c.status !== 'ACTIVE') return false;
    if (currentFilter === 'ARCHIVED' && c.status !== 'ARCHIVED') return false;
    if (currentFilter === 'CLOSED' && c.status !== 'CLOSED') return false;
    if (currentFilter === 'UNREAD' && (c.unread_count || 0) <= 0) return false;

    // 2. Search query filter
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.lead_name?.toLowerCase().includes(q) ||
      c.lead_phone?.toLowerCase().includes(q) ||
      c.last_message_preview?.toLowerCase().includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    const timeA = a.last_message_at ? parseServerTime(a.last_message_at)?.getTime() ?? 0 : (a.created_at ? parseServerTime(a.created_at)?.getTime() ?? 0 : 0);
    const timeB = b.last_message_at ? parseServerTime(b.last_message_at)?.getTime() ?? 0 : (b.created_at ? parseServerTime(b.created_at)?.getTime() ?? 0 : 0);
    return timeB - timeA;
  });

  // Deduplicate conversations by phone number (last 10 digits) or group JID so duplicate windows never appear
  const deduplicated = React.useMemo(() => {
    const seen = new Map<string, Conversation>();
    for (const c of sorted) {
      let key = '';
      if (c.is_group || c.lead_phone?.endsWith('@g.us')) {
        key = `grp_${c.lead_phone || c.id}`;
      } else {
        const digits = c.lead_phone ? c.lead_phone.replace(/\D/g, '').slice(-10) : '';
        key = digits ? `phone_${digits}` : `conv_${c.id}`;
      }

      if (!seen.has(key)) {
        seen.set(key, { ...c });
      } else {
        const existing = seen.get(key)!;
        const existingTime = existing.last_message_at ? new Date(existing.last_message_at).getTime() : 0;
        const currentTime = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
        if (currentTime > existingTime) {
          seen.set(key, {
            ...c,
            unread_count: (c.unread_count || 0) + (existing.unread_count || 0),
          });
        } else {
          existing.unread_count = (existing.unread_count || 0) + (c.unread_count || 0);
        }
      }
    }
    return Array.from(seen.values());
  }, [sorted]);

  const selectedConvDigits = React.useMemo(() => {
    if (!selectedId) return '';
    const found = conversations.find((c) => c.id === selectedId);
    return found?.lead_phone ? found.lead_phone.replace(/\D/g, '').slice(-10) : '';
  }, [selectedId, conversations]);

  const filterTabs: { id: FilterTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'ALL', label: t('whatsapp.tabAll') || 'Tümü', icon: Inbox },
    { id: 'ACTIVE', label: t('whatsapp.tabActive') || 'Aktif', icon: MessageSquare },
    { id: 'UNREAD', label: t('whatsapp.tabUnread') || 'Okunmamış', icon: Mail },
    { id: 'ARCHIVED', label: t('whatsapp.tabArchived') || 'Arşiv', icon: Archive },
    { id: 'CLOSED', label: t('whatsapp.tabClosed') || 'Kapatılan', icon: CheckCircle2 },
  ];

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
                <span>{t('whatsapp.newChat') || 'Yeni Sohbet'}</span>
              </Button>
            )}
            {onSync && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSync}
                disabled={isSyncing}
                title={t('whatsapp.syncChats') || "WhatsApp'tan Sohbetleri Güncelle"}
                className="px-2.5 space-x-1 text-xs font-bold border-slate-200 dark:border-white/[0.1] hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-[#7367F0] ${isSyncing ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{t('whatsapp.sync') || 'Eşitle'}</span>
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
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04]">
        {loading ? (
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
          <div className="p-6 text-center text-slate-400 dark:text-slate-500 text-xs">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>{t('whatsapp.noConversations')}</p>
          </div>
        ) : (
          deduplicated.map((conv) => {
            const convDigits = conv.lead_phone ? conv.lead_phone.replace(/\D/g, '').slice(-10) : '';
            const isSelected = selectedId === conv.id || Boolean(selectedConvDigits && convDigits && selectedConvDigits === convDigits);
            // Faz 7: internal JID/LID sentinel'leri ('jid:...@lid' vb.)
            // kullanıcıya ASLA gösterilmez — kimlik çözülene kadar güvenli
            // fallback kullanılır.
            const isRawJid = Boolean(
              conv.lead_phone &&
                (conv.lead_phone.startsWith('jid:') ||
                  conv.lead_phone.includes('@lid') ||
                  conv.lead_phone.includes('@g.us') ||
                  conv.lead_phone.includes('@s.whatsapp.net') ||
                  conv.lead_phone.includes('@c.us'))
            );
            const safePhone = isRawJid ? null : conv.lead_phone;
            const displayName = conv.lead_name || safePhone || (t('whatsapp.pendingIdentity') || 'Kişi kimliği çözülüyor…');
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => onSelect(conv)}
                className={`w-full text-left p-3.5 flex items-start space-x-3 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15 border-l-4 border-[#7367F0]'
                    : 'hover:bg-slate-100/60 dark:hover:bg-white/[0.04]'
                }`}
              >
                <Avatar
                  name={displayName}
                  image={conv.lead_avatar_url}
                  size="md"
                  shape="rounded"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-1.5 truncate">
                      {conv.is_group && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25">
                          <Users className="w-2.5 h-2.5" />
                          <span>{t('whatsapp.group') || 'Grup'}</span>
                        </span>
                      )}
                      <h4 className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">
                        {displayName}
                      </h4>
                    </div>
                    <span className="text-[10px] text-slate-400 font-medium shrink-0 ml-1">
                      {formatTime(conv.last_message_at || conv.created_at)}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {conv.last_message_preview || t('leads.noMessagesTitle')}
                  </p>

                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] font-mono text-slate-400">
                      {safePhone || ''}
                    </span>
                    <div className="flex items-center space-x-1.5">
                      {conv.status !== 'ACTIVE' && (
                        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                          {conv.status === 'ARCHIVED' ? (t('whatsapp.statusArchived') || 'Arşiv') : (t('whatsapp.statusClosed') || 'Kapalı')}
                        </span>
                      )}
                      {conv.unread_count > 0 && (
                        <Badge variant="primary">
                          {conv.unread_count}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
