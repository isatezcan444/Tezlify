import React, { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Smile,
  Users,
  Loader2,
} from 'lucide-react';
import { Conversation, Message } from '../../../types';
import { WhatsAppApi } from '../api/whatsappApi';
import { useI18n } from '../../../context/I18nContext';
import { Avatar } from '../../../components/ui/Avatar';
import {
  formatPhoneNumber,
  canonicalJid,
  extractCleanPhone,
  isRealContactName,
  stripJidPrefix,
} from '../lib/whatsappIdentity';
import { formatMessageDate, formatMessageTime, parseServerTime } from '../../../lib/utils';
import { resolveMediaUrl } from '../../../lib/mediaUrl';

export interface ChatMessageInfoDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  message: Message;
  conversation: Conversation;
  groupParticipants?: Array<{ id: string; name: string; phone?: string; is_me: boolean; admin?: string }>;
  allMessages?: Message[];
}

interface ParticipantReceiptItem {
  id: string;
  name: string;
  phone?: string;
  avatar_url?: string;
  timestamp?: string | null;
  via?: string;
}

export const ChatMessageInfoDrawer: React.FC<ChatMessageInfoDrawerProps> = ({
  isOpen,
  onClose,
  message,
  conversation,
  groupParticipants = [],
  allMessages = [],
}) => {
  const { t, language } = useI18n();
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);
  const [serverInfo, setServerInfo] = useState<{
    sent_at?: string | null;
    delivered_at?: string | null;
    read_at?: string | null;
    status?: string | null;
    read_by?: Array<{ jid: string; name: string; phone?: string; timestamp?: string | null; via?: string }>;
    delivered_to?: Array<{ jid: string; name: string; phone?: string; timestamp?: string | null }>;
  } | null>(null);

  const isGroup = Boolean(conversation.is_group);

  // Fetch detailed receipts from backend on mount or message change
  useEffect(() => {
    if (!isOpen || !conversation.id || !message.id) return;
    let isCancelled = false;
    setLoadingDetails(true);

    void WhatsAppApi.getMessageInfo(conversation.id, message.id)
      .then((res) => {
        if (!isCancelled && res) {
          setServerInfo(res);
        }
      })
      .catch(() => {
        // Fall back gracefully to local message and participants state
      })
      .finally(() => {
        if (!isCancelled) {
          setLoadingDetails(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [isOpen, conversation.id, message.id]);

  // Format full timestamp helper
  const formatFullDateTime = (isoStr?: string | null) => {
    if (!isoStr) return null;
    try {
      const d = parseServerTime(isoStr);
      if (!d || isNaN(d.getTime())) return null;
      return `${formatMessageDate(isoStr, language, t('leads.today'), t('leads.yesterday'))}, ${formatMessageTime(isoStr, language)}`;
    } catch {
      return null;
    }
  };

  // Group receipts calculation
  const { readByList, deliveredToList, remainingList } = useMemo(() => {
    if (!isGroup) {
      return { readByList: [], deliveredToList: [], remainingList: [] };
    }

    // Helper: Determine if two participant records represent the same human contact
    const isSameParticipant = (
      a?: { id?: string | null; phone?: string | null; name?: string | null } | null,
      b?: { id?: string | null; phone?: string | null; name?: string | null } | null
    ): boolean => {
      if (!a || !b) return false;

      // 1. Exact raw ID / phone match
      if (a.id && b.id && a.id === b.id) return true;
      if (a.phone && b.phone && a.phone === b.phone) return true;
      if (a.id && b.phone && a.id === b.phone) return true;
      if (a.phone && b.id && a.phone === b.id) return true;

      // 2. Canonical JID match (stripping jid:, device suffixes, domain normalization)
      const jidA = canonicalJid(a.id || a.phone);
      const jidB = canonicalJid(b.id || b.phone);
      if (jidA && jidB && jidA === jidB) return true;

      // 3. Clean phone digits match (e.g. +905076382749 vs 905076382749)
      const cleanA = extractCleanPhone(a.phone) || extractCleanPhone(a.id);
      const cleanB = extractCleanPhone(b.phone) || extractCleanPhone(b.id);
      if (cleanA && cleanB) {
        if (cleanA === cleanB) return true;
        const digitsA = cleanA.replace(/\D/g, '');
        const digitsB = cleanB.replace(/\D/g, '');
        if (
          digitsA.length >= 7 &&
          digitsB.length >= 7 &&
          (digitsA === digitsB || digitsA.endsWith(digitsB.slice(-10)) || digitsB.endsWith(digitsA.slice(-10)))
        ) {
          return true;
        }
      }

      // 4. Raw digits from user part (in case of LID or PN username match)
      const rawDigits = (val?: string | null) => {
        if (!val) return '';
        const clean = val.replace(/^jid:/, '').split('@')[0].split(':')[0];
        const d = clean.replace(/\D/g, '');
        return d.length >= 7 ? d : '';
      };
      const d1 = rawDigits(a.phone) || rawDigits(a.id);
      const d2 = rawDigits(b.phone) || rawDigits(b.id);
      if (d1 && d2 && (d1 === d2 || (d1.length >= 10 && d2.length >= 10 && (d1.endsWith(d2.slice(-10)) || d2.endsWith(d1.slice(-10)))))) {
        return true;
      }

      // 5. Contact Name match: In a WhatsApp group, names are unique human labels.
      // If two items have the exact same real contact name, they are the same person!
      if (a.name && b.name && isRealContactName(a.name) && isRealContactName(b.name)) {
        if (a.name.trim().toLowerCase() === b.name.trim().toLowerCase()) {
          return true;
        }
      }

      return false;
    };

    const readList: ParticipantReceiptItem[] = [];
    const deliveredList: ParticipantReceiptItem[] = [];

    const addOrMerge = (targetList: ParticipantReceiptItem[], item: ParticipantReceiptItem) => {
      const existingIdx = targetList.findIndex((existing) => isSameParticipant(existing, item));
      if (existingIdx >= 0) {
        targetList[existingIdx] = {
          ...targetList[existingIdx],
          name: isRealContactName(item.name) ? item.name : targetList[existingIdx].name,
          phone: item.phone || targetList[existingIdx].phone,
          timestamp: targetList[existingIdx].timestamp || item.timestamp,
          via: targetList[existingIdx].via || item.via,
          avatar_url: item.avatar_url || targetList[existingIdx].avatar_url,
        };
      } else {
        targetList.push({ ...item });
      }
    };

    // 1. Seed from server receipts if available
    if (serverInfo?.read_by && Array.isArray(serverInfo.read_by)) {
      for (const r of serverInfo.read_by) {
        addOrMerge(readList, {
          id: r.jid,
          name: r.name,
          phone: r.phone,
          timestamp: r.timestamp,
          via: r.via,
        });
      }
    }

    // 2. Add reactions as authoritative read evidence
    if (Array.isArray(message.reactions) && message.reactions.length > 0) {
      for (const rx of message.reactions) {
        if (rx.from_me) continue;
        const candidate = {
          id: rx.reactor_jid || '',
          name: rx.reactor_name || '',
          phone: extractCleanPhone(rx.reactor_jid),
          timestamp: typeof rx.updated_at === 'string' ? rx.updated_at : message.created_at,
          via: 'reaction' as const,
        };
        addOrMerge(readList, candidate);
      }
    }

    // 3. Add subsequent message senders in group as read evidence
    const msgDate = new Date(message.created_at).getTime();
    if (!isNaN(msgDate) && allMessages.length > 0) {
      for (const m of allMessages) {
        if (m.direction === 'INBOUND' && (m.sender_phone || m.sender_name)) {
          const mDate = new Date(m.created_at).getTime();
          if (mDate > msgDate) {
            const candidate = {
              id: m.sender_phone || m.sender_name || '',
              name: m.sender_name || (m.sender_phone ? formatPhoneNumber(m.sender_phone) : ''),
              phone: m.sender_phone,
              timestamp: m.created_at,
              via: 'reply' as const,
            };
            addOrMerge(readList, candidate);
          }
        }
      }
    }

    // 4. Seed server delivered receipts
    if (serverInfo?.delivered_to && Array.isArray(serverInfo.delivered_to)) {
      for (const d of serverInfo.delivered_to) {
        const candidate = {
          id: d.jid,
          name: d.name,
          phone: d.phone,
          timestamp: d.timestamp,
        };
        if (!readList.some((r) => isSameParticipant(r, candidate))) {
          addOrMerge(deliveredList, candidate);
        }
      }
    }

    // 5. Partition known group participants
    const remList: ParticipantReceiptItem[] = [];
    for (const p of groupParticipants) {
      if (p.is_me) continue;
      const participantItem = {
        id: p.id,
        name: p.name || (p.phone ? formatPhoneNumber(p.phone) : p.id),
        phone: p.phone,
      };

      // Check if participant already read the message
      const readIdx = readList.findIndex((r) => isSameParticipant(r, participantItem));
      if (readIdx >= 0) {
        readList[readIdx] = {
          ...readList[readIdx],
          name: isRealContactName(p.name) ? p.name : readList[readIdx].name,
          phone: p.phone || readList[readIdx].phone,
        };
        continue; // MUST NOT be added to delivered or remaining!
      }

      // Check if participant already received the message
      const delivIdx = deliveredList.findIndex((d) => isSameParticipant(d, participantItem));
      if (delivIdx >= 0) {
        deliveredList[delivIdx] = {
          ...deliveredList[delivIdx],
          name: isRealContactName(p.name) ? p.name : deliveredList[delivIdx].name,
          phone: p.phone || deliveredList[delivIdx].phone,
        };
        continue; // MUST NOT be added to remaining!
      }

      // If message itself is delivered/read at group level, mark delivered
      if (message.status === 'READ' || message.status === 'DELIVERED') {
        deliveredList.push({
          id: p.id,
          name: p.name || (p.phone ? formatPhoneNumber(p.phone) : p.id),
          phone: p.phone,
          timestamp: message.delivered_at || message.created_at,
        });
      } else {
        // Participant hasn't received or read yet
        remList.push({
          id: p.id,
          name: p.name || (p.phone ? formatPhoneNumber(p.phone) : p.id),
          phone: p.phone,
        });
      }
    }

    return {
      readByList: readList,
      deliveredToList: deliveredList,
      remainingList: remList,
    };
  }, [isGroup, serverInfo, message, allMessages, groupParticipants]);

  if (!isOpen) return null;

  // Media preview element
  const mediaType = message.message_type;
  const isImage = mediaType === 'IMAGE';
  const isVideo = mediaType === 'VIDEO';
  const isAudio = mediaType === 'AUDIO';
  const isDoc = mediaType === 'DOCUMENT';

  return (
    <div
      data-testid="message-info-drawer"
      className="w-full md:w-[380px] xl:w-[420px] 2xl:w-[460px] h-full flex flex-col bg-[#f0f2f5] dark:bg-[#111b21] border-l border-slate-200/80 dark:border-white/[0.08] overflow-hidden shrink-0 z-20 animate-in slide-in-from-right duration-200 ease-out select-none"
    >
      {/* Header */}
      <div className="h-[60px] px-4 flex items-center gap-4 bg-slate-50 dark:bg-[#202c33] border-b border-slate-200/80 dark:border-white/[0.08] text-slate-800 dark:text-[#e9edef] shrink-0">
        <button
          type="button"
          onClick={onClose}
          data-testid="message-info-close-btn"
          className="p-1.5 -ml-1 rounded-full text-slate-600 dark:text-[#aebac1] hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-medium truncate">
            {t('whatsapp.messageInfoTitle')}
          </h3>
        </div>
      </div>

      {/* Message Preview Banner */}
      <div className="p-4 bg-slate-200/40 dark:bg-[#0b141a]/60 border-b border-slate-200/60 dark:border-white/[0.06] flex justify-end shrink-0">
        <div className="max-w-[85%] rounded-lg px-3 py-2 bg-[#d9fdd3] dark:bg-[#005c4b] text-slate-900 dark:text-[#e9edef] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] text-[13.5px] leading-relaxed break-words">
          {/* Media preview */}
          {message.media_id && (
            <div className="mb-1.5 rounded-md overflow-hidden bg-black/5 dark:bg-black/20">
              {isImage && (
                <img
                  src={resolveMediaUrl(message.media_url || `/api/v1/whatsapp/media/${message.media_id}`)}
                  alt="preview"
                  className="max-h-40 w-full object-cover"
                />
              )}
              {isVideo && (
                <div className="relative aspect-video flex items-center justify-center bg-black/40 text-white">
                  <Film className="w-8 h-8 opacity-75" />
                </div>
              )}
              {isAudio && (
                <div className="flex items-center gap-2 p-2">
                  <Music className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs truncate">{message.media_filename || t('whatsapp.audio')}</span>
                </div>
              )}
              {isDoc && (
                <div className="flex items-center gap-2 p-2 bg-black/5 dark:bg-black/15 rounded">
                  <FileText className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-medium truncate">{message.media_filename || t('whatsapp.document')}</span>
                </div>
              )}
            </div>
          )}

          {/* Text body */}
          {message.body && (
            <p className="whitespace-pre-wrap">{message.body}</p>
          )}

          {message.media_caption && !message.body && (
            <p className="whitespace-pre-wrap">{message.media_caption}</p>
          )}

          {/* Reactions bar preview */}
          {Array.isArray(message.reactions) && message.reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5 pt-1 border-t border-black/5 dark:border-white/10">
              {message.reactions.map((rx, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/70 dark:bg-black/30 text-xs"
                >
                  <span>{rx.emoji}</span>
                  {rx.reactor_name && <span className="text-[10px] opacity-75">{rx.reactor_name}</span>}
                </span>
              ))}
            </div>
          )}

          {/* Footer timestamp & check */}
          <div className="flex items-center justify-end gap-1 mt-1 text-[11px] text-slate-500 dark:text-[#8696a0]">
            <span>{formatMessageTime(message.created_at)}</span>
            {message.status === 'READ' ? (
              <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />
            ) : message.status === 'DELIVERED' ? (
              <CheckCheck className="w-3.5 h-3.5 text-slate-400 dark:text-[#8696a0]" />
            ) : (
              <Check className="w-3.5 h-3.5 text-slate-400 dark:text-[#8696a0]" />
            )}
          </div>
        </div>
      </div>

      {/* Receipts Content */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-200/80 dark:divide-white/[0.08]">
        {/* Loading Spinner Header Indicator */}
        {loadingDetails && (
          <div className="py-2 px-4 flex items-center justify-center gap-2 text-xs text-slate-400 dark:text-[#8696a0] bg-slate-100/50 dark:bg-black/10">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{t('whatsapp.loadingMessages')}</span>
          </div>
        )}

        {isGroup ? (
          /* ==============================================================
             GROUP CHAT MESSAGE INFO ("Okuyanlar" & "Teslim Edilenler")
             ============================================================== */
          <div className="space-y-4 py-3">
            {/* 1. Okuyanlar (Read by) */}
            <div className="space-y-1">
              <div className="px-4 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-[#8696a0] uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <CheckCheck className="w-4 h-4 text-[#53bdeb]" />
                  <span>{t('whatsapp.readBy')}</span>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-[#53bdeb] font-bold text-[11px]">
                  {readByList.length}
                </span>
              </div>

              {readByList.length > 0 ? (
                <div className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                  {readByList.map((item) => (
                    <div
                      key={item.id}
                      className="px-4 py-2.5 flex items-center gap-3 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                    >
                      <Avatar name={item.name} image={item.avatar_url} phone={item.phone} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-[#e9edef] truncate">
                          {item.name}
                        </p>
                        {item.phone && formatPhoneNumber(item.phone) !== item.name && (
                          <p className="text-[11px] text-slate-400 font-mono truncate">
                            {formatPhoneNumber(item.phone)}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-[11px] text-slate-400 dark:text-[#8696a0]">
                          {formatFullDateTime(item.timestamp) || t('whatsapp.readStatus')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500 italic">
                  {t('whatsapp.noReceiptsYet')}
                </div>
              )}
            </div>

            {/* 2. Teslim Edilenler (Delivered to) */}
            <div className="space-y-1">
              <div className="px-4 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-[#8696a0] uppercase tracking-wider">
                <div className="flex items-center gap-2">
                  <CheckCheck className="w-4 h-4 text-slate-400 dark:text-[#8696a0]" />
                  <span>{t('whatsapp.deliveredTo')}</span>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-[#aebac1] font-bold text-[11px]">
                  {deliveredToList.length}
                </span>
              </div>

              {deliveredToList.length > 0 ? (
                <div className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                  {deliveredToList.map((item) => (
                    <div
                      key={item.id}
                      className="px-4 py-2.5 flex items-center gap-3 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                    >
                      <Avatar name={item.name} image={item.avatar_url} phone={item.phone} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-[#e9edef] truncate">
                          {item.name}
                        </p>
                        {item.phone && formatPhoneNumber(item.phone) !== item.name && (
                          <p className="text-[11px] text-slate-400 font-mono truncate">
                            {formatPhoneNumber(item.phone)}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-[11px] text-slate-400 dark:text-[#8696a0]">
                          {formatFullDateTime(item.timestamp) || t('whatsapp.deliveredStatus')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500 italic">
                  {readByList.length > 0 ? '—' : t('whatsapp.notDeliveredYet')}
                </div>
              )}
            </div>

            {/* 3. Kalanlar (Remaining / Pending) */}
            {remainingList.length > 0 && (
              <div className="space-y-1">
                <div className="px-4 py-2 flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-500 uppercase tracking-wider">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-400" />
                    <span>{t('whatsapp.remainingParticipants')}</span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-slate-200 dark:bg-white/5 text-slate-500 font-bold text-[11px]">
                    {remainingList.length}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                  {remainingList.map((item) => (
                    <div
                      key={item.id}
                      className="px-4 py-2 flex items-center gap-3 opacity-60"
                    >
                      <Avatar name={item.name} image={item.avatar_url} phone={item.phone} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                          {item.name}
                        </p>
                      </div>
                      <span className="text-[10px] text-slate-400 italic">
                        {t('whatsapp.notDeliveredYet')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ==============================================================
             DIRECT (1-ON-1) CHAT MESSAGE INFO ("Okundu", "Teslim edildi", "Gönderildi")
             ============================================================== */
          <div className="divide-y divide-slate-200/80 dark:divide-white/[0.08] bg-white dark:bg-[#111b21]">
            {/* Okundu (Read) */}
            <div className="p-4 flex items-start gap-4 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
              <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
                <CheckCheck className="w-4 h-4 text-[#53bdeb]" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-slate-800 dark:text-[#e9edef]">
                  {t('whatsapp.readStatus')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-0.5">
                  {formatFullDateTime(serverInfo?.read_at || message.read_at) ||
                    (message.status === 'READ'
                      ? formatFullDateTime(message.created_at)
                      : '—')}
                </p>
              </div>
            </div>

            {/* Teslim Edildi (Delivered) */}
            <div className="p-4 flex items-start gap-4 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
              <div className="w-8 h-8 rounded-full bg-slate-500/10 flex items-center justify-center shrink-0">
                <CheckCheck className="w-4 h-4 text-slate-500 dark:text-[#8696a0]" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-slate-800 dark:text-[#e9edef]">
                  {t('whatsapp.deliveredStatus')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-0.5">
                  {formatFullDateTime(serverInfo?.delivered_at || message.delivered_at) ||
                    (message.status === 'DELIVERED' || message.status === 'READ'
                      ? formatFullDateTime(serverInfo?.sent_at || message.sent_at || message.created_at)
                      : '—')}
                </p>
              </div>
            </div>

            {/* Gönderildi (Sent) */}
            <div className="p-4 flex items-start gap-4 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
              <div className="w-8 h-8 rounded-full bg-slate-500/10 flex items-center justify-center shrink-0">
                <Check className="w-4 h-4 text-slate-500 dark:text-[#8696a0]" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-slate-800 dark:text-[#e9edef]">
                  {t('whatsapp.sentStatus')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-[#8696a0] mt-0.5">
                  {formatFullDateTime(serverInfo?.sent_at || message.sent_at || message.created_at) ||
                    formatFullDateTime(message.created_at)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
