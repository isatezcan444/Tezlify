import React, { useState } from 'react';
import { MessageSquare, Archive, CheckCircle2, Inbox, Mail, MessageSquarePlus, RefreshCw, Users } from 'lucide-react';
import { Conversation, ConversationStatus } from '../../../types';
import { Avatar } from '../../../components/ui/Avatar';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { SearchInput } from '../../../components/forms/SearchInput';
import { Skeleton } from '../../../components/ui/Skeleton';
import { useI18n } from '../../../context/I18nContext';
import { parseServerTime, formatConversationTime } from '../../../lib/utils';
import { compareConversationsByActivityDesc } from '../lib/whatsappOrdering';

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
}

export function formatPhoneNumber(phone?: string | null): string {
  if (!phone) return '';
  let raw = String(phone).replace(/^jid:/, '').trim();
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@c.us')) {
    raw = raw.split('@')[0];
  }
  if (raw.includes(':')) {
    raw = raw.split(':')[0];
  }

  let digits = raw.replace(/\D/g, '');
  if (!digits || digits.length < 5) return raw;

  // Turkish 10 digits starting with 5 (e.g. 5322334968) -> 905322334968
  if (digits.length === 10 && digits.startsWith('5')) {
    digits = `90${digits}`;
  } else if (digits.length === 11 && digits.startsWith('05')) {
    digits = `90${digits.slice(1)}`;
  }

  // 1. Turkey (+90) - Mobile: 12 digits (+90 5XX XXX XX XX)
  if (digits.startsWith('90') && digits.length === 12) {
    return `+90 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10, 12)}`;
  }

  // 2. North America (+1) (USA, Canada) - 11 digits: +1 XXX XXX XXXX
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  }

  // 3. United Kingdom (+44) - Mobile (+44 7XXX XXXXXX) or standard
  if (digits.startsWith('44')) {
    if (digits.length === 12) {
      return `+44 ${digits.slice(2, 6)} ${digits.slice(6, 12)}`;
    }
    if (digits.length === 11) {
      return `+44 ${digits.slice(2, 5)} ${digits.slice(5, 11)}`;
    }
  }

  // 4. Germany (+49)
  if (digits.startsWith('49') && digits.length >= 11 && digits.length <= 13) {
    return `+49 ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }

  // 5. France (+33) - 11 digits: +33 X XX XX XX XX
  if (digits.startsWith('33') && digits.length === 11) {
    return `+33 ${digits.slice(2, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7, 9)} ${digits.slice(9, 11)}`;
  }

  // 6. Generic international fallback:
  let ccLength = 2;
  if (digits.startsWith('1') || digits.startsWith('7')) {
    ccLength = 1;
  } else if (
    digits.startsWith('971') || digits.startsWith('966') ||
    digits.startsWith('351') || digits.startsWith('352') ||
    digits.startsWith('353') || digits.startsWith('354') ||
    digits.startsWith('358') || digits.startsWith('370') ||
    digits.startsWith('371') || digits.startsWith('372') ||
    digits.startsWith('380') || digits.startsWith('381') ||
    digits.startsWith('385') || digits.startsWith('420') ||
    digits.startsWith('421') || digits.startsWith('852') ||
    digits.startsWith('886')
  ) {
    ccLength = 3;
  }

  if (digits.length > ccLength + 3) {
    const cc = digits.slice(0, ccLength);
    const rest = digits.slice(ccLength);
    const chunks: string[] = [];
    let i = 0;
    while (i < rest.length) {
      const remaining = rest.length - i;
      if (remaining === 4) {
        chunks.push(rest.slice(i, i + 4));
        break;
      } else if (remaining > 4) {
        chunks.push(rest.slice(i, i + 3));
        i += 3;
      } else {
        chunks.push(rest.slice(i));
        break;
      }
    }
    return `+${cc} ${chunks.join(' ')}`;
  }

  return `+${digits}`;
}

export function extractCleanPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const raw = String(phone).replace(/^jid:/, '').trim();
  if (raw.endsWith('@lid') || raw.includes('@g.us')) return null;
  const userPart = (raw.includes('@') ? raw.split('@')[0] : raw).split(':')[0];
  let digits = userPart.replace(/\D/g, '');
  if (digits.length < 5 || /^0+$/.test(digits)) return null;
  if (digits.length === 10 && digits.startsWith('5')) {
    digits = `90${digits}`;
  } else if (digits.length === 11 && digits.startsWith('05')) {
    digits = `90${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export function isRawWhatsAppJid(value?: string | null): boolean {
  if (!value) return false;
  const v = String(value).trim();
  return (
    v.startsWith('jid:') ||
    v.includes('@lid') ||
    v.includes('@g.us') ||
    v.includes('@s.whatsapp.net') ||
    v.includes('@c.us')
  );
}

export function isRealContactName(name?: string | null): boolean {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  if (isRawWhatsAppJid(trimmed)) return false;

  const digitsOnly = trimmed.replace(/\D/g, '');
  const lettersOnly = trimmed.replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ]/g, '');
  if (digitsOnly.length >= 5 && lettersOnly.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower === 'lead' ||
    lower === 'isimsiz müşteri' ||
    lower === 'whatsapp kişisi' ||
    lower === 'whatsapp contact' ||
    lower.includes('kişi kimliği') ||
    lower.includes('resolving identity')
  ) {
    return false;
  }

  return true;
}

export function getConversationDisplayName(
  conv: Conversation,
  t: (key: string) => string
): string {
  const rawPhone =
    conv.lead_phone ||
    (conv as any).phone ||
    (conv as any).jid ||
    (conv as any).phone_number ||
    (conv as any).recipient_phone ||
    (conv as any).sender_phone ||
    null;
  const rawName = conv.lead_name || (conv as any).name || null;

  // 1. Group conversation check
  const isGroup = Boolean(conv.is_group || (rawPhone && rawPhone.includes('@g.us')));
  if (isGroup) {
    if (rawName && !isRawWhatsAppJid(rawName)) {
      return rawName;
    }
    return t('whatsapp.groupFallback') || 'Grup';
  }

  // 2. Saved contact in address book ("Kişi rehberde kayıtlıysa: Ahmet Yılmaz")
  if (isRealContactName(rawName)) {
    return rawName!;
  }

  // 3. Unsaved contact with resolvable phone number ("Kişi rehberde kayıtlı değilse: +90 532 233 49 68")
  // Format according to location / country code (+90 5XX XXX XX XX, +1 XXX XXX XXXX, etc.)
  const cleanPhone = extractCleanPhone(rawPhone) || extractCleanPhone(rawName);
  if (cleanPhone) {
    return formatPhoneNumber(cleanPhone);
  }

  // 4. Transient resolving (ONLY if active resolution is genuinely in-flight)
  // Rehberde kayıt bulunmaması kesinlikle resolving kabul edilmeyecek.
  // Kayıtlı olmayan PN JID için spinner/resolving asla gösterilmez (Case 3 handled above).
  if (conv.identity_state === 'RESOLVING_TRANSIENT') {
    return t('whatsapp.pendingIdentity') || 'Kişi kimliği çözülüyor…';
  }

  // 5. Stable permanent fallback (Never show "Kişi (XXXX)")
  return t('whatsapp.contactFallback') || 'WhatsApp Kişisi';
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
  typingMap,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
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
    // Sorun 4 (WhatsApp paritesi): arsivli sohbetler ANA listeden gizlenir,
    // yalnizca "Arsiv" sekmesinde gorunur. Arsiv = WhatsApp arsiv durumu
    // (is_archived, gateway metadata) VEYA CRM status ARCHIVED (kullanici
    // aksiyonu) — ikisi de ayni sekmede toplanir.
    const archivedLike = Boolean(c.is_archived) || c.status === 'ARCHIVED';
    if (currentFilter === 'ALL' && archivedLike) return false;
    if (currentFilter === 'ACTIVE' && (c.status !== 'ACTIVE' || archivedLike)) return false;
    if (currentFilter === 'GROUPS' && !c.is_group) return false;
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

  // Deduplicate only within the same WhatsApp line. The same contact can be
  // present on multiple user-owned lines and must remain visible separately.
  const deduplicated = React.useMemo(() => {
    const seen = new Map<string, Conversation>();
    for (const c of sorted) {
      let key = '';
      const rawPhone = c.lead_phone || (c as any).phone || (c as any).jid || (c as any).phone_number || '';
      if (c.is_group || rawPhone.endsWith('@g.us')) {
        key = `line_${c.session_id ?? 'legacy'}_grp_${rawPhone || c.id}`;
      } else {
        const digits = rawPhone ? rawPhone.replace(/\D/g, '').slice(-10) : '';
        key = digits ? `line_${c.session_id ?? 'legacy'}_phone_${digits}` : `conv_${c.id}`;
      }

      if (!seen.has(key)) {
        seen.set(key, { ...c });
      } else {
        const existing = seen.get(key)!;
        const existingTime = existing.last_message_at ? parseServerTime(existing.last_message_at)?.getTime() ?? 0 : 0;
        const currentTime = c.last_message_at ? parseServerTime(c.last_message_at)?.getTime() ?? 0 : 0;
        if (currentTime > existingTime || (currentTime === existingTime && c.id > existing.id)) {
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
    { id: 'ALL', label: t('whatsapp.tabAll') || 'Tümü', icon: Inbox },
    { id: 'ACTIVE', label: t('whatsapp.tabActive') || 'Aktif', icon: MessageSquare },
    // Sorun 4: grup sohbetleri ayri sekme (JID @g.us — backend is_group).
    { id: 'GROUPS', label: t('whatsapp.tabGroups') || 'Gruplar', icon: Users },
    { id: 'UNREAD', label: t('whatsapp.tabUnread') || 'Okunmamış', icon: Mail },
    { id: 'ARCHIVED', label: t('whatsapp.tabArchived') || 'Arşiv', icon: Archive },
    { id: 'CLOSED', label: t('whatsapp.tabClosed') || 'Kapatılan', icon: CheckCircle2 },
  ];

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    const target = e.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
      onLoadMore();
    }
  };

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
      <div onScroll={handleScroll} className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.04]">

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
            // Conversation id is globally unique; phone-only selection would
            // select both lines when the same contact exists on multiple lines.
            const isSelected = selectedId === conv.id;
            const rawPhone = conv.lead_phone || (conv as any).phone;
            const isRawJid = isRawWhatsAppJid(rawPhone);
            const cleanPhone = extractCleanPhone(rawPhone);
            const displayName = getConversationDisplayName(conv, t);
            return (
              <button
                key={conv.id}
                type="button"
                data-conv-id={conv.id}
                data-phone={rawPhone}
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
                  phone={cleanPhone || (!isRawJid && rawPhone ? rawPhone : undefined)}
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
                      {conv.last_message_at ? formatTime(conv.last_message_at) : ''}
                    </span>
                  </div>

                  {(() => {
                    const lastMsg = renderLastMessage(conv);
                    if (lastMsg === '__typing__') {
                      // WhatsApp Web: listede yesil "yazıyor..." gosterilir.
                      return (
                        <p className="text-[11px] text-[#25D366] dark:text-[#25D366] font-bold truncate mt-0.5 animate-pulse">
                          {t('whatsapp.peerTyping') || 'yazıyor...'}
                        </p>
                      );
                    }
                    return (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {lastMsg}
                      </p>
                    );
                  })()}

                  {(conv.status !== 'ACTIVE' || conv.unread_count > 0) && (
                    <div className="flex items-center justify-end space-x-1.5 mt-1.5">
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
                  )}
                </div>
              </button>
            );
          })
        )}
        {loadingMore && (
          <div className="p-3 text-center text-xs text-slate-400 dark:text-slate-500 flex items-center justify-center space-x-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#7367F0]" />
            <span>{t('whatsapp.loadingMore') || 'Daha fazla sohbet yükleniyor…'}</span>
          </div>
        )}
      </div>

    </div>
  );
};
