import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  Smartphone, 
  QrCode, 
  ShieldCheck, 
  Flame, 
  CheckCircle2, 
  Loader2, 
  Zap,
  Clock,
  Sliders,
  Check,
  RotateCcw,
  AlertTriangle,
  Shield,
  Building2,
  Save,
  Undo2,
  MessageSquare,
  Archive,
  ExternalLink,
  Copy,
  MessageSquarePlus,
  Users
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { WhatsAppRepository } from '../data/whatsapp/whatsappRepository';
import { WhatsAppSession, Conversation, ConversationStatus, ConversationMessageStatus, Lead, Message, LiveModeStatus } from '../types';
import { WhatsAppApi, useLiveMode, probeLive, invalidateLiveProbe, isLiveCached } from '../api/whatsappApi';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/EmptyState';
import { Avatar } from '../components/ui/Avatar';
import { WhatsAppIcon } from '../components/ui/whatsapp-icon';
import { 
  SessionCard,
  WhatsAppQrConnectModal,
  ConversationList, 
  ChatThread, 
  ChatComposer, 
  LeadDetailDrawer, 
  TemplateSelectModal, 
  NewChatModal 
} from '../components/domain';
import { FilterTab } from '../components/domain/ConversationList';
import { Slider, Switch } from '../components/forms';
import { 
  AntiBanConfig, 
  DEFAULT_ANTI_BAN_CONFIG, 
  ANTI_BAN_PRESETS, 
  getStoredAntiBanConfig, 
  saveAntiBanConfig, 
  calculateRiskLevel,
  isConfigEqual,
  resolvePresetFromConfig
} from '../utils/antiBanSettings';
import { useToast } from '../context/ToastContext';
import { useI18n } from '../context/I18nContext';


interface WhatsAppHubPageProps {
  onRefreshStats: () => void;
}

export const WhatsAppHubPage: React.FC<WhatsAppHubPageProps> = ({ onRefreshStats }) => {
  const toast = useToast();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [isQrConnectModalOpen, setIsQrConnectModalOpen] = useState<boolean>(false);
  const [reconnectSessionId, setReconnectSessionId] = useState<number | undefined>(undefined);
  const [disconnectingSessionId, setDisconnectingSessionId] = useState<number | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<number | null>(null);

  // Tab State: 'conversations' | 'sessions' | 'antiban'
  const [hubTab, setHubTab] = useState<'conversations' | 'sessions' | 'antiban'>('conversations');

  // Live Conversations State (connected directly to WhatsApp session)
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<number, Message[]>>({});
  const [convsLoading, setConvsLoading] = useState<boolean>(false);
  const [convSearch, setConvSearch] = useState<string>('');
  const [convFilter, setConvFilter] = useState<FilterTab>('ALL');

  // Lead Detail Drawer State for Conversation -> Lead navigation
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [isLeadDrawerOpen, setIsLeadDrawerOpen] = useState<boolean>(false);
  const [leadLoading, setLeadLoading] = useState<boolean>(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState<boolean>(false);
  const [isSyncingChats, setIsSyncingChats] = useState<boolean>(false);
  const conversationsGenerationRef = useRef(0);

  // 'yazıyor...' durumu: conversation_id -> bool (gateway presence_updated ile)
  const [peerTypingMap, setPeerTypingMap] = useState<Record<number, boolean>>({});
  const peerTypingTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // Live mode: probes backend WhatsApp gateway health on mount & periodically
  const { status: liveStatus, probe: probeLiveMode } = useLiveMode();
  const isLive = liveStatus === LiveModeStatus.LIVE_CONNECTED;

  const activeMessages = selectedConv ? (messagesMap[selectedConv.id] || []) : [];
  const activeChatLoading = false;
  const activeHasMore = false;
  const activeLoadingOlder = false;
  const activeConv = selectedConv;

  const activeLoadOlder = async () => {};

  const loadConversations = useCallback(async (isSilent: boolean = false) => {
    const generation = conversationsGenerationRef.current;
    if (!isSilent) setConvsLoading(true);
    try {
      const list = await WhatsAppRepository.getConversations({
        status: convFilter === 'ALL' ? undefined : (convFilter as ConversationStatus),
        unread_only: convFilter === 'UNREAD',
        search: convSearch.trim() || undefined,
      });
      if (generation !== conversationsGenerationRef.current) return;
      setConversations(list);
      setSelectedConv((prev) => {
        if (!prev && list.length > 0) return list[0];
        if (prev) {
          const updated = list.find((c) => c.id === prev.id);
          return updated || (list.length > 0 ? list[0] : null);
        }
        return null;
      });
    } catch (err: any) {
      console.error('Failed to load conversations:', err);
    } finally {
      if (!isSilent && generation === conversationsGenerationRef.current) setConvsLoading(false);
    }
  }, [convFilter, convSearch]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadConversations();
    }, convSearch ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadConversations, convSearch]);

  // Load messages whenever selected conversation changes (with race condition mitigation)
  useEffect(() => {
    if (!selectedConv?.id) return;
    let isMounted = true;
    const convId = selectedConv.id;

    // Faz 5: secilen sohbeti acmak okundu sayilir (WhatsApp Web paritesi) —
    // tiklama ya da otomatik secim yoluyla gelmesi farketmez; okundu boylece
    // telefona da geri yazilir.
    if ((selectedConv.unread_count ?? 0) > 0) {
      WhatsAppRepository.markConversationAsRead(convId).catch(() => {});
      setConversations((prev) =>
        prev.map((item) => (item.id === convId ? { ...item, unread_count: 0 } : item))
      );
    }

    WhatsAppRepository.getConversationMessages(convId, { limit: 50 })
      .then((res) => {
        if (isMounted && res?.messages) {
          setMessagesMap((prev) => {
            const existing = prev[convId] || [];
            // Merge strategy: prevent wiping messages received via realtime while GET was in flight
            const fetchedIds = new Set(res.messages.map((m) => m.id));
            const fetchedWaIds = new Set(res.messages.map((m) => m.wa_message_id).filter(Boolean));
            const fetchedClientIds = new Set(res.messages.map((m) => m.client_message_id).filter(Boolean));

            const inFlightOrRealtime = existing.filter((m) => {
              if (m.id && fetchedIds.has(m.id)) return false;
              if (m.wa_message_id && fetchedWaIds.has(m.wa_message_id)) return false;
              if (m.client_message_id && fetchedClientIds.has(m.client_message_id)) return false;
              return true;
            });

            const merged = [...res.messages, ...inFlightOrRealtime].sort((a, b) => {
              const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
              const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
              if (tA !== tB) return tA - tB;
              const nA = typeof a.id === 'number' ? a.id : 0;
              const nB = typeof b.id === 'number' ? b.id : 0;
              return nA - nB;
            });

            return {
              ...prev,
              [convId]: merged,
            };
          });
        }
      })
      .catch((err) => {
        console.error('Failed to fetch messages for conversation', convId, err);
      });
    return () => {
      isMounted = false;
    };
  }, [selectedConv?.id]);

  // Authoritative sync: pull chats & history from the WhatsApp gateway via the
  // Tezlify backend (sync=true), then refresh the list and active thread.
  const handleSyncChats = async () => {
    setIsSyncingChats(true);
    try {
      const list = await WhatsAppRepository.getConversations({
        status: convFilter === 'ALL' ? undefined : (convFilter as ConversationStatus),
        unread_only: convFilter === 'UNREAD',
        search: convSearch.trim() || undefined,
        sync: true,
      });
      setConversations(list);
      if (selectedConv?.id) {
        const res = await WhatsAppRepository.getConversationMessages(selectedConv.id, { limit: 50 });
        if (res?.messages) {
          setMessagesMap((prev) => ({
            ...prev,
            [selectedConv.id]: res.messages,
          }));
        }
      }
      if (list.length === 0) {
        toast.info(
          t('whatsapp.syncEmpty') || 'Eşitlenecek yeni sohbet yok.',
          t('common.success')
        );
      } else {
        toast.success(
          t('whatsapp.syncSuccess', { count: list.length }) || 'Sohbetler eşitlendi',
          t('common.success')
        );
      }
    } catch (err: any) {
      toast.error(err.message || 'Sohbetler eşitlenemedi', t('common.error'));
    } finally {
      setIsSyncingChats(false);
    }
  };

  const handleOpenLead = async (leadId: number) => {
    setDrawerLead({
      id: leadId,
      name: selectedConv?.lead_name || 'Müşteri',
      phone: selectedConv?.lead_phone || '',
      category: 'WhatsApp Sohbeti',
      status: 'NEW',
    } as any);
    setIsLeadDrawerOpen(true);
  };

  const handleStatusChange = async (convId: number, newStatus: ConversationStatus) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
    );
    if (selectedConv && selectedConv.id === convId) {
      setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
    }
    toast.success(t('whatsapp.statusUpdated') || 'Durum güncellendi', t('common.success'));
  };

  const activeSendMessage = async (text: string) => {
    if (!selectedConv || !text.trim()) return;
    const trimmed = text.trim();
    const tempClientMid = `cmsg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      status: 'PENDING',
      body: trimmed,
      client_message_id: tempClientMid,
      sender_name: 'Siz',
      created_at: nowIso,
    };

    // Optimistic UI feedback (0ms perceived delay)
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), optimisticMsg],
    }));
    setConversations((prev) =>
      prev.map((c) =>
        c.id === selectedConv.id
          ? { ...c, last_message_preview: trimmed, last_message_at: nowIso }
          : c
      )
    );

    try {
      const res = await WhatsAppRepository.sendMessage(selectedConv.id, trimmed, tempClientMid);
      // Reconcile temporary message with backend response (which has status 'PENDING', real id, client_message_id)
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? {
                ...m,
                id: res.id,
                client_message_id: res.client_message_id || tempClientMid,
                wa_message_id: res.wa_message_id ?? m.wa_message_id,
                status: res.status,
              }
            : m
        ),
      }));
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message || 'Gönderilemedi' }
            : m
        ),
      }));
      const msg = (err?.message || '').toLowerCase();
      if (msg.includes('24 saat') || msg.includes('window') || msg.includes('expired')) {
        toast.error(t('whatsapp.windowExpiredNotice') || 'Bu konuşmaya devam etmek için bir WhatsApp şablonu kullanın.', t('common.error'));
      } else {
        toast.error(err?.message || t('whatsapp.msgFailed') || 'Mesaj gönderilemedi', t('common.error'));
      }
      throw err;
    }
  };

  const activeRetryMessage = async (msgId: number | string) => {
    if (!selectedConv) return;
    // Optimistic rows (client-only string ids) must never hit /retry. Re-POST
    // with the existing client_message_id so idempotency holds and the row is
    // reconciled with the real numeric DB id.
    const convId = selectedConv.id;
    const target = (messagesMap[convId] || []).find((m) => m.id === msgId);
    const isRealDbId = typeof msgId === 'number' && Number.isInteger(msgId) && msgId > 0;
    try {
      if (!isRealDbId) {
        const clientMid = target?.client_message_id;
        if (!target || !clientMid || !target.body) {
          throw new Error(
            t('whatsapp.msgNotPersisted') ||
              'Mesaj henüz sunucuya kaydedilmedi. Lütfen önce gönderimin tamamlanmasını bekleyin.'
          );
        }
        const res = await WhatsAppRepository.sendMessage(convId, target.body, clientMid);
        setMessagesMap((prev) => ({
          ...prev,
          [convId]: (prev[convId] || []).map((m) =>
            m.id === msgId || (clientMid && m.client_message_id === clientMid)
              ? {
                  ...m,
                  id: res.id,
                  client_message_id: res.client_message_id || clientMid,
                  wa_message_id: (res as any).wa_message_id ?? m.wa_message_id,
                  status: res.status,
                  error_message: undefined,
                }
              : m
          ),
        }));
        toast.success(t('whatsapp.messageSent') || 'Mesaj tekrar gönderildi', t('common.success'));
        return;
      }
      const res = await WhatsAppRepository.retryMessage(convId, msgId);
      setMessagesMap((prev) => ({
        ...prev,
        [convId]: (prev[convId] || []).map((m) =>
          m.id === msgId ? { ...m, status: res.status, error_message: undefined } : m
        ),
      }));
      toast.success(t('whatsapp.messageSent') || 'Mesaj tekrar gönderildi', t('common.success'));
    } catch (err: any) {
      toast.error(err?.message || t('whatsapp.msgFailed') || 'Tekrar gönderim başarısız', t('common.error'));
      throw err;
    }
  };

  const activeSendMedia = async (type: string, url: string, caption?: string, filename?: string) => {
    if (!selectedConv) return;
    const tempClientMid = `media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const newMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: (type === 'IMAGE' ? 'IMAGE' : 'DOCUMENT') as any,
      status: 'PENDING',
      body: caption || filename || url || `[${type}]`,
      client_message_id: tempClientMid,
      media_url: url,
      media_filename: filename,
      media_caption: caption,
      sender_name: 'Siz',
      created_at: nowIso,
    };
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), newMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendMedia(
        selectedConv.id,
        {
          media_type: type.toLowerCase(),
          media_url: url,
          caption,
          filename,
        },
        tempClientMid
      );
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, id: res.id, client_message_id: res.client_message_id || tempClientMid, status: res.status }
            : m
        ),
      }));
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message }
            : m
        ),
      }));
      throw err;
    }
  };

  const activeSendMediaFile = async (file: File, caption?: string) => {
    if (!selectedConv) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mt = file.type || '';
    let msgType: Message['message_type'] = 'DOCUMENT';
    if (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) msgType = 'IMAGE';
    else if (mt.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) msgType = 'VIDEO';
    else if (mt.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) msgType = 'AUDIO';

    const tempClientMid = `file_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const newMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: msgType,
      status: 'PENDING',
      body: caption || file.name,
      client_message_id: tempClientMid,
      media_filename: file.name,
      media_mime_type: file.type || undefined,
      media_caption: caption,
      sender_name: 'Siz',
      created_at: nowIso,
    };
    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), newMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendMediaFile(selectedConv.id, file, caption, tempClientMid);
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? {
                ...m,
                id: res.id,
                client_message_id: res.client_message_id || tempClientMid,
                wa_message_id: res.wa_message_id ?? m.wa_message_id,
                media_url: res.media_url ?? m.media_url,
                status: res.status,
              }
            : m
        ),
      }));
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message }
            : m
        ),
      }));
      throw err;
    }
  };

  const activeSendTemplate = async (templateKey: string, variables: Record<string, string> = {}) => {
    if (!selectedConv) return;
    const tempClientMid = `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${tempClientMid}`;
    const nowIso = new Date().toISOString();

    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: selectedConv.id,
      direction: 'OUTBOUND',
      message_type: 'TEMPLATE',
      status: 'PENDING',
      body: `[Şablon: ${templateKey}]`,
      client_message_id: tempClientMid,
      sender_name: 'Siz',
      created_at: nowIso,
    };

    setMessagesMap((prev) => ({
      ...prev,
      [selectedConv.id]: [...(prev[selectedConv.id] || []), optimisticMsg],
    }));

    try {
      const res = await WhatsAppRepository.sendTemplate(selectedConv.id, templateKey, variables, tempClientMid);
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, id: res.id, body: res.body || m.body, status: res.status }
            : m
        ),
      }));
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedConv.id
            ? { ...c, last_message_preview: res.body || optimisticMsg.body, last_message_at: nowIso }
            : c
        )
      );
    } catch (err: any) {
      setMessagesMap((prev) => ({
        ...prev,
        [selectedConv.id]: (prev[selectedConv.id] || []).map((m) =>
          m.id === tempId || m.client_message_id === tempClientMid
            ? { ...m, status: 'FAILED', error_message: err.message || 'Şablon gönderilemedi' }
            : m
        ),
      }));
      toast.error(err?.message || t('whatsapp.templateFailed') || 'Şablon gönderilemedi', t('common.error'));
      throw err;
    }
  };

  const fetchConversations = () => {
    loadConversations(true);
  };

  // Real-time listener for conversation list unread, status and preview updates
  useEffect(() => {
    const handleWsEvent = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      const eventData = customEvent.detail;
      if (!eventData) return;

      // 1. INBOUND MESSAGE & OUTBOUND CONFIRMATION
      if (
        eventData.event === 'inbound_reply' ||
        eventData.event === 'new_message' ||
        eventData.event === 'outbound_message_sent'
      ) {
        const convId = eventData.conversation_id;
        const rawPhone = eventData.lead_phone || eventData.phone || eventData.recipient_phone || eventData.sender_phone || '';
        const eventDigits = rawPhone.replace(/\D/g, '').slice(-10);

        const msgText = eventData.message?.body || (typeof eventData.message === 'string' ? eventData.message : '') || eventData.body || '';
        const msgTime = eventData.message?.created_at || eventData.created_at || eventData.timestamp || new Date().toISOString();
        const isOutbound =
          eventData.event === 'outbound_message_sent' ||
          eventData.message?.direction === 'OUTBOUND' ||
          eventData.direction === 'OUTBOUND';

        // Update Conversation in list
        setConversations((prev) => {
          const idx = prev.findIndex(
            (c) => c.id === convId || (eventDigits && c.lead_phone && c.lead_phone.replace(/\D/g, '').slice(-10) === eventDigits)
          );

          if (idx !== -1) {
            const existing = prev[idx];
            const isCurrentSelected = selectedConv && (selectedConv.id === existing.id || selectedConv.id === convId);
            const updated: Conversation = {
              ...existing,
              status: 'ACTIVE',
              last_message_preview: typeof msgText === 'string' && msgText ? msgText : existing.last_message_preview,
              last_message_at: msgTime,
              unread_count: isCurrentSelected || isOutbound ? 0 : (existing.unread_count || 0) + 1,
              is_window_open: true, // Inbound message opens the 24h customer window!
              last_inbound_at: !isOutbound ? msgTime : existing.last_inbound_at,
            };
            if (isCurrentSelected) {
              setSelectedConv(updated);
            }
            // Move updated conversation to top of list
            const rest = prev.filter((_, i) => i !== idx);
            return [updated, ...rest];
          } else {
            loadConversations(true);
            return prev;
          }
        });

        // If active conversation matches, append message to thread with deduplication
        if (convId && selectedConv && (selectedConv.id === convId || (eventDigits && selectedConv.lead_phone && selectedConv.lead_phone.replace(/\D/g, '').slice(-10) === eventDigits))) {
          const msgObj = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
          const waId = msgObj?.wa_message_id || eventData.wa_message_id || eventData.message_id;
          const clientMid = msgObj?.client_message_id || eventData.client_message_id;
          const msgId = msgObj?.id || eventData.id;

          const newMsg: Message = {
            id: msgId || Date.now(),
            conversation_id: convId,
            direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
            message_type: (msgObj?.message_type || eventData.message_type || 'TEXT').toUpperCase() as any,
            status: isOutbound ? 'SENT' : 'RECEIVED',
            body: typeof msgText === 'string' ? msgText : '',
            wa_message_id: waId,
            client_message_id: clientMid,
            sender_name: msgObj?.sender_name || eventData.sender_name || (isOutbound ? 'Siz' : undefined),
            sender_phone: msgObj?.sender_phone || eventData.phone || '',
            media_id: msgObj?.media_id || eventData.media_id,
            media_mime_type: msgObj?.media_mime_type || eventData.media_mime_type,
            media_filename: msgObj?.media_filename || eventData.media_filename,
            media_caption: msgObj?.media_caption || eventData.media_caption,
            created_at: msgTime,
          };

          setMessagesMap((prev) => {
            const list = prev[convId] || [];
            // Check for duplicate by wa_message_id, client_message_id, or id
            const existingIdx = list.findIndex((m) =>
              (waId && m.wa_message_id === waId) ||
              (clientMid && m.client_message_id === clientMid) ||
              (msgId && m.id === msgId)
            );
            if (existingIdx !== -1) {
              const updatedList = [...list];
              updatedList[existingIdx] = { ...updatedList[existingIdx], ...newMsg };
              return { ...prev, [convId]: updatedList };
            }
            return {
              ...prev,
              [convId]: [...list, newMsg].sort((a, b) => {
                const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
                const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
                if (tA !== tB) return tA - tB;
                const nA = typeof a.id === 'number' ? a.id : 0;
                const nB = typeof b.id === 'number' ? b.id : 0;
                return nA - nB;
              }),
            };
          });

          // Auto-mark conversation as read if user is actively viewing it
          if (!isOutbound) {
            // Mesaj geldi → 'yazıyor...' göstergesini kapat
            setPeerTypingMap((prev) => {
              if (!(convId in prev)) return prev;
              const n = { ...prev };
              delete n[convId];
              return n;
            });
            clearTimeout(peerTypingTimersRef.current[convId as number]);
            WhatsAppRepository.markConversationAsRead(convId).catch(() => {});
          }
        }
      }

      // 2. MESSAGE STATUS UPDATE (PENDING -> SENT -> DELIVERED -> READ / FAILED)
      if (eventData.event === 'message_status_updated') {
        const convId = eventData.conversation_id;
        const waId = eventData.wa_message_id;
        const clientMid = eventData.client_message_id;
        const serverId = eventData.id;
        const numericServerId =
          typeof eventData.message_id === 'number' && eventData.message_id > 0
            ? eventData.message_id
            : typeof serverId === 'number' && serverId > 0
              ? serverId
              : undefined;
        const newStatus = eventData.status as ConversationMessageStatus;
        const errorMsg = eventData.error_message;

        if (convId) {
          setMessagesMap((prev) => {
            const list = prev[convId];
            if (!list) return prev;
            let changed = false;
            const updated = list.map((m) => {
              const matchesWaId = waId && m.wa_message_id === waId;
              const matchesClientMid = clientMid && m.client_message_id === clientMid;
              const matchesId = numericServerId && m.id === numericServerId;
              if (matchesWaId || matchesClientMid || matchesId) {
                changed = true;
                return {
                  ...m,
                  id: numericServerId ?? m.id,
                  wa_message_id: waId || m.wa_message_id,
                  status: newStatus,
                  error_message: errorMsg || m.error_message,
                };
              }
              return m;
            });
            if (!changed) return prev;
            return { ...prev, [convId]: updated };
          });
        }
      }

      // 3. CONVERSATION STATUS / READ EVENTS
      if (eventData.event === 'conversation_status_updated') {
        const convId = eventData.conversation_id;
        const newStatus = eventData.status;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
        );
        if (selectedConv && selectedConv.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
        }
      }

      if (eventData.event === 'conversation_read') {
        const convId = eventData.conversation_id;
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        );
        if (selectedConv && selectedConv.id === convId) {
          setSelectedConv((prev) => (prev ? { ...prev, unread_count: 0 } : prev));
        }
      }

      // Faz 5: gateway'den canlı sohbet metadata'sı (isim/avatar/preview/unread)
      // — backend jid'yi sayısal conversation_id'ye çevirerek ileri iletir.
      if (eventData.event === 'conversation_updated') {
        const convId = eventData.conversation_id;
        const payload = eventData.conversation || {};
        if (typeof convId === 'number') {
          const patch = (c: Conversation): Conversation => ({
            ...c,
            lead_name: payload.name || c.lead_name,
            lead_avatar_url: payload.avatar_url || c.lead_avatar_url,
            last_message_preview: payload.last_message_preview || c.last_message_preview,
            last_message_at: payload.last_message_at || c.last_message_at,
            unread_count:
              payload.unread_count != null ? Math.max(c.unread_count || 0, payload.unread_count) : c.unread_count,
          });
          setConversations((prev) => prev.map((c) => (c.id === convId ? patch(c) : c)));
          setSelectedConv((prev) => (prev && prev.id === convId ? patch(prev) : prev));
        }
      }

      if (eventData.event === 'new_conversation' || eventData.event === 'conversations_updated') {
        loadConversations(true);
      }

      // Faz 4: gateway gecmis senkronunu tamamladiginda listeyi ve aktif
      // konusmeyi sessizce tazele (telefonun RECENT history'si DB'ye yazildi).
      if (eventData.event === 'history_sync_completed') {
        loadConversations(true);
        if (selectedConv?.id) {
          WhatsAppRepository.getConversationMessages(selectedConv.id, { limit: 50 })
            .then((res) => {
              if (res?.messages) {
                setMessagesMap((prev) => ({ ...prev, [selectedConv.id]: res.messages }));
              }
            })
            .catch(() => {});
        }
      }

      // 4. PRESENCE UPDATE ('yazıyor...' göstergesi) — backend jid'yi sayısal
      // conversation_id'ye çevirip `typing` boolean'ı ekler.
      if (eventData.event === 'presence_updated') {
        const rawId = eventData.conversation_id;
        const convId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10);
        if (!Number.isNaN(convId)) {
          const typing = !!eventData.typing;
          setPeerTypingMap((prev) => {
            const next = { ...prev };
            if (typing) {
              next[convId] = true;
              // Güvenlik ağı: paused kaybolursa 10 sn sonra kendiliğinden sönsün
              clearTimeout(peerTypingTimersRef.current[convId]);
              peerTypingTimersRef.current[convId] = setTimeout(() => {
                setPeerTypingMap((p) => {
                  const n = { ...p };
                  delete n[convId];
                  return n;
                });
              }, 10000);
            } else {
              delete next[convId];
              clearTimeout(peerTypingTimersRef.current[convId]);
            }
            return next;
          });
        }
      }
    };

    // Reconnect Recovery: silently refresh active conversation if connection drops and recovers
    const handleReconnect = () => {
      console.log('[WhatsAppHubPage] WebSocket reconnected. Performing silent reconciliation...');
      loadConversations(true);
      if (selectedConv?.id) {
        WhatsAppRepository.getConversationMessages(selectedConv.id, { limit: 50 })
          .then((res) => {
            if (res?.messages) {
              setMessagesMap((prev) => ({
                ...prev,
                [selectedConv.id]: res.messages,
              }));
            }
          })
          .catch(() => {});
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    window.addEventListener('tezlify:ws_connected', handleReconnect);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
      window.removeEventListener('tezlify:ws_connected', handleReconnect);
    };
  }, [selectedConv, loadConversations]);

  // Anti-Ban Timing & Change-Tracking State
  const [savedConfig, setSavedConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [config, setConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [isSavingAntiBan, setIsSavingAntiBan] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchSessions = useCallback(async (silent = false) => {
    try {
      setSessions(await WhatsAppRepository.getWhatsAppSessions());
    } catch (err: any) {
      if (!silent) toast.error(err?.message || t('common.error'), t('common.error'));
    }
  }, [t, toast]);

  const handleQrSuccess = useCallback(() => {
    fetchSessions(true);
    onRefreshStats();
  }, [fetchSessions, onRefreshStats]);

  const handleOpenQrConnect = useCallback(() => {
    setReconnectSessionId(undefined);
    setIsQrConnectModalOpen(true);
  }, []);

  useEffect(() => {
    fetchSessions();

    // Listen to real-time inbound messages and WhatsApp session events
    const handleWs = (e: Event) => {
      const eventData = (e as CustomEvent<any>).detail;
      if (eventData?.event === 'inbound_reply') {
        // Handled locally
      } else if (
        eventData?.event === 'session_connected' ||
        eventData?.event === 'session_disconnected' ||
        eventData?.event === 'number_updated'
      ) {
        fetchSessions(true);
        onRefreshStats();
      } else if (eventData?.event === 'conversations_cleared') {
        conversationsGenerationRef.current += 1;
        setConversations([]);
        setSelectedConv(null);
        setMessagesMap({});
      }
    };
    window.addEventListener('tezlify:ws_event', handleWs);

    // Load persisted Anti-Ban configuration from backend database
    ApiClient.getAntiBanSettings()
      .then((remote) => {
        if (remote) {
          const resolvedPreset = resolvePresetFromConfig(remote);
          const normalized = { ...remote, preset: remote.preset || resolvedPreset };
          setConfig(normalized);
          setSavedConfig(normalized);
          saveAntiBanConfig(normalized);
        }
      })
      .catch((e) => {
        console.warn('Anti-ban config failed to load from backend, using local storage:', e);
      });

    return () => {
      window.removeEventListener('tezlify:ws_event', handleWs);
    };
  }, [fetchSessions, onRefreshStats]);

  const handlePresetSelect = (presetKey: 'ultra_safe' | 'standard_balanced' | 'fast_warmed') => {
    const presetData = ANTI_BAN_PRESETS[presetKey];
    setConfig((prev) => ({
      ...prev,
      preset: presetKey,
      ...presetData
    }));
  };

  const handleCustomChange = (field: keyof AntiBanConfig, value: any) => {
    setConfig((prev) => {
      const updated = {
        ...prev,
        [field]: value
      };
      updated.preset = resolvePresetFromConfig(updated);
      return updated;
    });
  };

  const handleSaveAntiBan = async () => {
    setIsSavingAntiBan(true);
    try {
      const updated = await ApiClient.updateAntiBanSettings(config);
      setSavedConfig(updated);
      setConfig(updated);
      saveAntiBanConfig(updated);
      setSaveSuccess(true);
      toast.success(t('whatsapp.policySavedSuccess'), t('toast.policySavedTitle'));
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('toast.errorTitle'));
    } finally {
      setIsSavingAntiBan(false);
    }
  };

  const handleRevertChanges = () => {
    setConfig(savedConfig);
    toast.info(t('whatsapp.discardChanges'), t('common.info'));
  };

  const handleResetDefaults = async () => {
    const confirmed = await toast.confirm({
      title: t('whatsapp.resetDefaults') + '?',
      message: t('whatsapp.presetBalancedDesc'),
      confirmText: t('common.save'),
      cancelText: t('common.cancel'),
      variant: 'warning'
    });
    if (!confirmed) return;

    setIsSavingAntiBan(true);
    try {
      const updated = await ApiClient.updateAntiBanSettings(DEFAULT_ANTI_BAN_CONFIG);
      setSavedConfig(updated);
      setConfig(updated);
      saveAntiBanConfig(updated);
      setSaveSuccess(true);
      toast.success(t('whatsapp.policySavedSuccess'), t('toast.policySavedTitle'));
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
    } finally {
      setIsSavingAntiBan(false);
    }
  };

  const hasUnsavedChanges = !isConfigEqual(config, savedConfig);
  const riskInfo = calculateRiskLevel(config.min_delay_seconds, config.daily_message_limit);

  const handleDisconnectSession = async (sessionId: number) => {
    if (disconnectingSessionId) return;
    const ok = await toast.confirm({
      title: t('whatsapp.disconnect'),
      message: t('whatsapp.disconnectConfirm'),
      confirmText: t('whatsapp.disconnect'),
      cancelText: t('common.cancel'),
      variant: 'warning',
    });
    if (!ok) return;

    setDisconnectingSessionId(sessionId);
    try {
      await WhatsAppRepository.disconnectSession(sessionId);
      await fetchSessions(true);
      toast.success(t('whatsapp.disconnectedSuccess'), t('common.success'));
      onRefreshStats();
    } catch (err: any) {
      toast.error(err?.message || t('common.error'), t('common.error'));
    } finally {
      setDisconnectingSessionId(null);
    }
  };

  const handleDeleteSession = async (sessionId: number) => {
    if (deletingSessionId) return;
    const ok = await toast.confirm({
      title: t('whatsapp.deleteSession'),
      message: t('whatsapp.deleteSessionConfirm'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!ok) return;

    setDeletingSessionId(sessionId);
    try {
      await WhatsAppRepository.deleteSession(sessionId);
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      // Product rule: deleting a line wipes live dialogs. Clear immediately
      // and reload from the server instead of relying solely on the realtime
      // event (which can be missed on a reconnecting socket).
      setConversations([]);
      setSelectedConv(null);
      setMessagesMap({});
      await loadConversations(true);
      toast.success(t('whatsapp.deletedSuccess'), t('common.success'));
      onRefreshStats();
    } catch (err: any) {
      toast.error(err?.message || t('common.error'), t('common.error'));
      await loadConversations(true);
    } finally {
      setDeletingSessionId(null);
    }
  };

  return (
    <div className="space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Tab Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
            {hubTab === 'conversations' ? (
              <>
                <MessageSquare className="w-5 h-5 text-[#25D366]" />
                {t('whatsapp.conversationsTitle')}
              </>
            ) : hubTab === 'sessions' ? (
              <>
                <Smartphone className="w-5 h-5 text-[#28C76F]" />
                {t('whatsapp.sessionsTitle')}
              </>
            ) : (
              <>
                <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
                {t('whatsapp.antiBanTitle')}
              </>
            )}
          </h2>
          <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5 font-medium">
            {hubTab === 'conversations'
              ? t('whatsapp.conversationsSubtitle')
              : hubTab === 'sessions'
              ? t('whatsapp.sessionsSubtitle')
              : t('whatsapp.antiBanSubtitle')}
          </p>
        </div>

        {/* Live Gateway Status Badge */}
        <div className="shrink-0">
          <Badge
            className={`text-[10px] font-extrabold px-2.5 py-1 rounded-xl transition-all ${
              liveStatus === LiveModeStatus.LIVE_CONNECTED
                ? 'bg-[#25D366]/20 text-[#25D366] dark:bg-[#25D366]/15'
                : liveStatus === LiveModeStatus.LIVE_CONNECTING
                ? 'bg-amber-400/20 text-amber-600 dark:bg-amber-400/15'
                : 'bg-slate-400/20 text-slate-500 dark:bg-slate-400/15'
            }`}
          >
            {liveStatus === LiveModeStatus.LIVE_CONNECTED
              ? t('whatsapp.liveBadgeConnected')
              : liveStatus === LiveModeStatus.LIVE_CONNECTING
              ? t('whatsapp.liveBadgeConnecting')
              : t('whatsapp.liveBadgeDisconnected')}
          </Badge>
        </div>

        {/* Segmented Tab Switcher */}
        <div className="flex p-1 rounded-2xl bg-slate-200/80 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] w-full md:w-auto shrink-0">
          <button
            type="button"
            onClick={() => setHubTab('conversations')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'conversations'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabConversations')}</span>
            {conversations.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-[#25D366]/20 text-[#25D366] dark:text-[#25D366] shrink-0">
                {conversations.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setHubTab('sessions')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'sessions'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabSessions')}</span>
          </button>

          <button
            type="button"
            onClick={() => setHubTab('antiban')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer whitespace-nowrap ${
              hubTab === 'antiban'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('whatsapp.tabAntiBan')}</span>
            {hasUnsavedChanges && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            )}
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 1. CANLI DİYALOGLAR (CONVERSATIONS) PANELİ */}
      {/* ========================================================================= */}
      {hubTab === 'conversations' && (
        <Card className="h-[650px] p-0 flex flex-col md:flex-row overflow-hidden border border-slate-200/80 dark:border-white/[0.08] shadow-sm">
          {/* Left: Conversation List */}
          <div className="w-full md:w-80 lg:w-96 shrink-0 h-full flex flex-col">
            <ConversationList
              conversations={conversations}
              selectedId={selectedConv?.id}
              loading={convsLoading}
              searchQuery={convSearch}
              onSearchChange={setConvSearch}
              activeFilter={convFilter}
              onFilterChange={setConvFilter}
              onNewChat={() => setIsNewChatModalOpen(true)}
              onSync={handleSyncChats}
              isSyncing={isSyncingChats}
              onSelect={(c) => {
                setSelectedConv(c);
                if (c.unread_count > 0) {
                  WhatsAppRepository.markConversationAsRead(c.id).catch(() => {});
                  setConversations((prev) =>
                    prev.map((item) => (item.id === c.id ? { ...item, unread_count: 0 } : item))
                  );
                }
              }}
            />
          </div>

          {/* Right: Active Chat View */}
          <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#181C28]">
            {selectedConv ? (
              <>
                {/* Active Chat Header */}
                <div className="p-3.5 border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-black/20 flex items-center justify-between shrink-0">
                  <div className="flex items-center space-x-3">
                    <Avatar
                      name={selectedConv.lead_name || selectedConv.lead_phone || 'Lead'}
                      image={selectedConv.lead_avatar_url}
                      size="md"
                      shape="rounded"
                    />
                    <div>
                      <div className="flex items-center space-x-2">
                        {selectedConv.is_group && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#7367F0]/15 text-[#7367F0] dark:bg-[#7367F0]/25">
                            <Users className="w-3 h-3" />
                            <span>{t('whatsapp.group') || 'Grup'}</span>
                          </span>
                        )}
                        <h4 className="font-extrabold text-sm text-slate-800 dark:text-white">
                          {selectedConv.lead_name || selectedConv.lead_phone || t('common.unnamedLead') || 'İsimsiz Müşteri'}
                        </h4>
                        {selectedConv.status !== 'ACTIVE' && (
                          <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                            {selectedConv.status === 'ARCHIVED' ? (t('whatsapp.statusArchived') || 'Arşiv') : (t('whatsapp.statusClosed') || 'Kapalı')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] font-mono text-slate-400 font-medium">
                        {selectedConv.lead_phone}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    {/* Lifecycle Status Action */}
                    {selectedConv.status === 'ACTIVE' ? (
                      <div className="flex items-center space-x-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange(selectedConv.id, 'ARCHIVED')}
                          className="space-x-1 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
                        >
                          <Archive className="w-3.5 h-3.5" />
                          <span>{t('whatsapp.archive') || 'Arşivle'}</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange(selectedConv.id, 'CLOSED')}
                          className="space-x-1 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" />
                          <span>{t('whatsapp.close') || 'Kapat'}</span>
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusChange(selectedConv.id, 'ACTIVE')}
                        className="space-x-1 text-xs font-bold text-[#7367F0] border-[#7367F0]/30 hover:bg-[#7367F0]/10 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>{t('whatsapp.reopen') || 'Yeniden Aç'}</span>
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenLead(selectedConv.lead_id)}
                      disabled={leadLoading}
                      className="space-x-1.5 text-xs font-bold border-slate-200 dark:border-white/[0.1] hover:bg-slate-100 dark:hover:bg-white/[0.06] cursor-pointer"
                    >
                      <Building2 className="w-3.5 h-3.5 text-[#7367F0]" />
                      <span>{t('leads.openLeadDetail') || 'Müşteri Detayı'}</span>
                    </Button>

                    <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full bg-[#25D366]/15 text-[#25D366] font-bold text-xs">
                      <WhatsAppIcon className="w-3.5 h-3.5" />
                      <span>{t('leads.whatsappActive')}</span>
                    </span>
                  </div>
                </div>

                {/* Chat Thread with Pagination */}
                <ChatThread
                  messages={activeMessages}
                  loading={activeChatLoading}
                  hasMore={activeHasMore}
                  loadingOlder={activeLoadingOlder}
                  onLoadOlder={activeLoadOlder}
                  leadName={selectedConv.lead_name}
                  leadPhone={selectedConv.lead_phone}
                  peerTyping={!!peerTypingMap[selectedConv.id]}
                  onRetry={async (msgId) => {
                    try {
                      await activeRetryMessage(msgId);
                      toast.success(t('whatsapp.messageSent') || 'Mesaj tekrar gönderildi', t('common.success'));
                    } catch (err: any) {
                      toast.error(t('whatsapp.msgFailed') || 'Tekrar gönderim başarısız', t('common.error'));
                      throw err;
                    }
                  }}
                />

                {/* Active Chat Composer */}
                <ChatComposer
                  onSend={async (text) => {
                    try {
                      await activeSendMessage(text);
                      toast.success(t('whatsapp.messageSent') || 'Mesaj başarıyla gönderildi', t('common.success'));
                    } catch (err: any) {
                      const msg = (err?.message || '').toLowerCase();
                      if (msg.includes('24 saat') || msg.includes('window')) {
                        toast.error(t('whatsapp.windowExpiredNotice') || 'Bu konuşmaya devam etmek için bir WhatsApp şablonu kullanın.', t('common.error'));
                      } else {
                        toast.error(err?.message || t('whatsapp.msgFailed') || 'Mesaj gönderilemedi', t('common.error'));
                      }
                      throw err;
                    }
                  }}
                  onSendTemplate={() => setIsTemplateModalOpen(true)}
                  onSendMediaFile={async (file, caption) => {
                    try {
                      await activeSendMediaFile(file, caption);
                      toast.success(t('whatsapp.mediaSent') || 'Medya başarıyla gönderildi', t('common.success'));
                    } catch (err: any) {
                      toast.error(err?.message || t('whatsapp.mediaFailed') || 'Medya gönderilemedi', t('common.error'));
                      throw err;
                    }
                  }}
                  onTyping={(typing) => {
                    if (selectedConv) {
                      WhatsAppRepository.sendTyping(selectedConv.id, typing);
                    }
                  }}
                  onSendMedia={async (type, url, caption, filename) => {
                    try {
                      await activeSendMedia(type, url, caption, filename);
                      toast.success(t('whatsapp.mediaSent') || 'Medya başarıyla gönderildi', t('common.success'));
                    } catch (err: any) {
                      toast.error(t('whatsapp.mediaFailed') || 'Medya gönderilemedi', t('common.error'));
                      throw err;
                    }
                  }}
                  onReopenConversation={() => handleStatusChange(selectedConv.id, 'ACTIVE')}
                  isClosed={selectedConv.status === 'CLOSED'}
                  isWindowOpen={activeConv?.is_window_open ?? selectedConv.is_window_open ?? true}
                />

                {/* Template Select Modal */}
                <TemplateSelectModal
                  isOpen={isTemplateModalOpen}
                  onClose={() => setIsTemplateModalOpen(false)}
                  leadName={selectedConv.lead_name}
                  onSendTemplate={async (templateKey, variables) => {
                    try {
                      await activeSendTemplate(templateKey, variables);
                      toast.success(t('whatsapp.templateSent') || 'Şablon mesajı başarıyla gönderildi', t('common.success'));
                    } catch (err: any) {
                      toast.error(t('whatsapp.templateFailed') || 'Şablon gönderilemedi', t('common.error'));
                      throw err;
                    }
                  }}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon={MessageSquare}
                  title={
                    conversations.length > 0
                      ? (t('whatsapp.selectConversationTitle') || 'Bir Konuşma Seçin')
                      : (t('whatsapp.noConversations') || 'Henüz Konuşma Yok')
                  }
                  description={
                    conversations.length > 0
                      ? (t('whatsapp.selectConversation') || 'Mesaj geçmişini görüntülemek ve yanıt vermek için soldaki listeden bir konuşma seçin.')
                      : (t('whatsapp.noConversationsDesc') || 'Gelen müşteri yanıtları veya başlatılan diyaloglar burada listelenir.')
                  }
                  action={
                    conversations.length === 0
                      ? {
                          label: t('whatsapp.newChat') || 'Yeni Sohbet Başlat',
                          onClick: () => setIsNewChatModalOpen(true),
                          icon: MessageSquarePlus,
                        }
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ========================================================================= */}
      {/* 2. BAILEYS QR OTURUM YÖNETİMİ */}
      {/* ========================================================================= */}
      {hubTab === 'sessions' && (
        <div className="space-y-6">
          <div className="flex items-center gap-3 justify-end flex-wrap">
            <Button
              onClick={handleOpenQrConnect}
              size="sm"
              className="space-x-2 font-bold shadow-md shadow-[#28C76F]/20 cursor-pointer bg-[#28C76F] hover:bg-[#24B263] text-white"
            >
              <QrCode className="w-4 h-4" />
              <span>{t('whatsapp.connectWithQr') || 'QR ile Bağla'}</span>
            </Button>

          </div>

          {sessions.length === 0 ? (
            <Card className="p-8">
              <EmptyState
                icon={Smartphone}
                title={t('whatsapp.noSessions')}
                description={t('whatsapp.noSessionsDesc')}
                action={{
                  label: t('whatsapp.connectWithQr') || 'QR ile Bağla',
                  onClick: handleOpenQrConnect,
                  icon: QrCode,
                }}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onDisconnect={handleDisconnectSession}
                  onDelete={handleDeleteSession}
                  onScanQR={(sessionId) => {
                    setReconnectSessionId(sessionId);
                    setIsQrConnectModalOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. WHATSAPP ANTI-BAN YAPILANDIRMASI SUITE */}
      {/* ========================================================================= */}
      {hubTab === 'antiban' && (
        <div className="space-y-6">
          <Card className="p-4 sm:p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.08] pb-4">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-extrabold text-slate-800 dark:text-white">
                  {t('whatsapp.antiBanTitle')}
                </h3>
                {hasUnsavedChanges ? (
                  <Badge variant="warning" className="text-[10px] animate-pulse">
                    ⚠️ {t('whatsapp.unsavedChanges')}
                  </Badge>
                ) : (
                  <Badge variant="success" className="text-[10px]">
                    ✅ {t('whatsapp.synchronized')}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] font-medium">
                {t('whatsapp.antiBanSubtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {hasUnsavedChanges && (
              <button
                type="button"
                onClick={handleRevertChanges}
                className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
                title={t('whatsapp.discardChanges')}
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>{t('whatsapp.revertChanges')}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleResetDefaults}
              className="text-xs font-bold text-slate-500 hover:text-[#7367F0] dark:text-[#7E7F96] dark:hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all cursor-pointer"
              title={t('whatsapp.resetDefaults')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('whatsapp.resetDefaults')}</span>
            </button>
          </div>
        </div>

        {/* Preset Selector Tabs */}
        <div>
          <label className="text-xs font-bold text-slate-700 dark:text-slate-200 block mb-2">
            {t('whatsapp.antiBanPresetLabel')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {/* Preset 1: Ultra Safe */}
            <button
              type="button"
              onClick={() => handlePresetSelect('ultra_safe')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'ultra_safe'
                  ? 'border-[#28C76F] bg-[#28C76F]/10 ring-1 ring-[#28C76F]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-[#28C76F]" />
                  {t('whatsapp.presetUltraSafe')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#28C76F]/15 text-[#28C76F]">
                  {t('whatsapp.presetUltraSafeTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetUltraSafeDesc')}
              </p>
            </button>

            {/* Preset 2: Standard Balanced (Default) */}
            <button
              type="button"
              onClick={() => handlePresetSelect('standard_balanced')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'standard_balanced'
                  ? 'border-[#7367F0] bg-[#7367F0]/10 ring-1 ring-[#7367F0]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#7367F0]" />
                  {t('whatsapp.presetBalanced')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#7367F0]/15 text-[#7367F0]">
                  {t('whatsapp.presetBalancedTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetBalancedDesc')}
              </p>
            </button>

            {/* Preset 3: Fast Warmed */}
            <button
              type="button"
              onClick={() => handlePresetSelect('fast_warmed')}
              className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                config.preset === 'fast_warmed'
                  ? 'border-[#FF9F43] bg-[#FF9F43]/10 ring-1 ring-[#FF9F43]/50 shadow-sm'
                  : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100 dark:hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-extrabold text-slate-800 dark:text-white flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-[#FF9F43]" />
                  {t('whatsapp.presetFast')}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#FF9F43]/15 text-[#FF9F43]">
                  {t('whatsapp.presetFastTag')}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                {t('whatsapp.presetFastDesc')}
              </p>
            </button>
          </div>
        </div>

        {/* Detailed Sliders */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <Slider
            label={t('whatsapp.minDelay')}
            icon={Clock}
            value={config.min_delay_seconds}
            min={10}
            max={120}
            step={5}
            unit="s"
            helperText={t('whatsapp.minDelayHelp')}
            onChange={(val) => {
              handleCustomChange('min_delay_seconds', val);
              if (val >= config.max_delay_seconds) {
                handleCustomChange('max_delay_seconds', val + 15);
              }
            }}
          />

          <Slider
            label={t('whatsapp.maxDelay')}
            icon={Clock}
            value={config.max_delay_seconds}
            min={config.min_delay_seconds + 5}
            max={240}
            step={5}
            unit="s"
            helperText={t('whatsapp.maxDelayHelp')}
            onChange={(val) => handleCustomChange('max_delay_seconds', val)}
          />

          <Slider
            label={t('whatsapp.typingDelay')}
            icon={Sliders}
            value={config.typing_delay_seconds}
            min={1}
            max={15}
            step={1}
            unit="s"
            helperText={t('whatsapp.typingDelayHelp')}
            onChange={(val) => handleCustomChange('typing_delay_seconds', val)}
          />

          <Slider
            label={t('whatsapp.dailyLimitSlider')}
            icon={Shield}
            value={config.daily_message_limit}
            min={10}
            max={250}
            step={5}
            helperText={t('whatsapp.dailyLimitHelp')}
            onChange={(val) => handleCustomChange('daily_message_limit', val)}
          />
        </div>

        {/* Working Hours Protection & Smooth Risk Gauge */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          {/* Working Hours Box */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-3 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Building2 className="w-4 h-4 text-[#7367F0]" />
                <div>
                  <span className="text-xs font-extrabold text-slate-800 dark:text-white block">
                    {t('whatsapp.workingHoursTitle')}
                  </span>
                  <span className="text-[10px] text-slate-400">{t('whatsapp.workingHoursSubtitle')}</span>
                </div>
              </div>

              <Switch
                checked={config.working_hours_enabled !== false}
                onChange={(checked) => handleCustomChange('working_hours_enabled', checked)}
              />
            </div>

            {config.working_hours_enabled !== false && (
              <div className="space-y-2.5 pt-1 animate-fade-in">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '18:00');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '18:00'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetStandardHours')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '18:30');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '18:30'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetCorporateHours')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      handleCustomChange('working_hours_start', '09:00');
                      handleCustomChange('working_hours_end', '20:00');
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                      config.working_hours_start === '09:00' && config.working_hours_end === '20:00'
                        ? 'bg-[#7367F0]/15 text-[#7367F0] border-[#7367F0]/40'
                        : 'bg-white dark:bg-white/[0.04] text-slate-500 border-slate-200 dark:border-white/[0.08] hover:bg-slate-100'
                    }`}
                  >
                    {t('whatsapp.presetFlexibleHours')}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                      {t('whatsapp.startTime')}
                    </label>
                    <input
                      type="time"
                      value={config.working_hours_start || '09:00'}
                      onChange={(e) => handleCustomChange('working_hours_start', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 dark:text-[#7E7F96] block mb-1">
                      {t('whatsapp.endTime')}
                    </label>
                    <input
                      type="time"
                      value={config.working_hours_end || '18:30'}
                      onChange={(e) => handleCustomChange('working_hours_end', e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg vuexy-input text-xs font-mono font-bold"
                    />
                  </div>
                </div>
              </div>
            )}
            <p className="text-[10px] text-slate-400">
              {t('whatsapp.workingHoursHelp')}
            </p>
          </div>

          {/* Smooth Animated Risk Meter */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] flex flex-col justify-between space-y-3 shadow-sm">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <AlertTriangle className={`w-4 h-4 ${riskInfo.color}`} />
                  {t('whatsapp.riskTitle')}
                </span>
                <span className={`text-[11px] font-extrabold px-2.5 py-0.5 rounded-lg border font-mono uppercase transition-all duration-300 ${riskInfo.badgeBg} ${riskInfo.badgeText}`}>
                  {riskInfo.title} (%{riskInfo.score})
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                {riskInfo.desc}
              </p>
            </div>

            <div className="space-y-1.5 pt-1">
              <div className="relative w-full h-3 rounded-full bg-slate-200 dark:bg-slate-700 overflow-visible p-0.5">
                <div 
                  className="w-full h-full rounded-full bg-gradient-to-r from-[#28C76F] via-[#FF9F43] to-[#EA5455] opacity-90"
                />
                <div 
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white dark:bg-slate-900 border-2 rounded-full shadow-md transition-all duration-500 ease-out z-10 flex items-center justify-center"
                  style={{ 
                    left: `${Math.max(4, Math.min(96, riskInfo.score))}%`,
                    borderColor: riskInfo.color 
                  }}
                >
                  <div 
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: riskInfo.color }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-[9px] font-bold text-slate-400 font-mono px-0.5">
                <span className="text-[#28C76F]">{t('whatsapp.riskSafe')}</span>
                <span className="text-[#FF9F43]">{t('whatsapp.riskBalanced')}</span>
                <span className="text-[#EA5455]">{t('whatsapp.riskHigh')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Save Actions */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
          <div className="flex items-center gap-2">
            {saveSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#28C76F] bg-[#28C76F]/15 px-3 py-1.5 rounded-lg border border-[#28C76F]/30 animate-fade-in">
                <Check className="w-3.5 h-3.5" />
                <span>{t('whatsapp.policySavedSuccess')}</span>
              </span>
            ) : hasUnsavedChanges ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#FF9F43] bg-[#FF9F43]/15 px-3 py-1.5 rounded-lg border border-[#FF9F43]/30 animate-fade-in">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{t('whatsapp.unsavedChangesDesc')}</span>
              </span>
            ) : (
              <span className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {savedConfig.updated_at
                  ? `${t('whatsapp.synchronized')}: ${new Date(savedConfig.updated_at).toLocaleTimeString()}`
                  : t('whatsapp.synchronized')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {hasUnsavedChanges && (
              <Button
                variant="outline"
                onClick={handleRevertChanges}
                className="space-x-1.5 font-bold text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                <Undo2 className="w-4 h-4" />
                <span>{t('whatsapp.revertChanges')}</span>
              </Button>
            )}

            <Button
              onClick={handleSaveAntiBan}
              disabled={isSavingAntiBan || !hasUnsavedChanges}
              className={`space-x-2 font-bold justify-center cursor-pointer transition-all duration-300 ${
                hasUnsavedChanges
                  ? 'bg-[#7367F0] hover:bg-[#5E50EE] text-white shadow-lg shadow-[#7367F0]/30 ring-2 ring-[#7367F0]/30'
                  : 'bg-slate-200 dark:bg-white/[0.08] text-slate-400 dark:text-slate-500 cursor-not-allowed'
              }`}
            >
              {isSavingAntiBan ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('whatsapp.saving')}</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>{hasUnsavedChanges ? t('whatsapp.savePolicy') : t('whatsapp.savedStatus')}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Anti-Ban Safeguard Guidelines */}
      <div className="grid grid-cols-1">
        <div>
          <Card className="p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#28C76F]" />
              {t('whatsapp.guidelinesTitle')}
            </h3>

            <div className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 font-medium">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#28C76F]">{t('whatsapp.guideline1Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline1Desc')}
                </p>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#00CFE8]">{t('whatsapp.guideline2Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline2Desc')}
                </p>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] space-y-1">
                <span className="font-bold text-[#7367F0]">{t('whatsapp.guideline3Title')}</span>
                <p className="text-slate-500 dark:text-[#7E7F96] text-[11px]">
                  {t('whatsapp.guideline3Desc')}
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
      </div>
      )}

      {/* Lead Detail Drawer for Conversation -> Lead Navigation */}
      <LeadDetailDrawer
        lead={drawerLead}
        isOpen={isLeadDrawerOpen}
        onClose={() => {
          setIsLeadDrawerOpen(false);
          setDrawerLead(null);
        }}
        initialTab="overview"
      />

      {/* New WhatsApp Conversation Modal */}
      <NewChatModal
        isOpen={isNewChatModalOpen}
        onClose={() => setIsNewChatModalOpen(false)}
        onSuccess={(newConv) => {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === newConv.id);
            if (exists) {
              return prev.map((c) => (c.id === newConv.id ? newConv : c));
            }
            return [newConv, ...prev];
          });
          setSelectedConv(newConv);
        }}
      />

      {/* WhatsApp QR Connect & Pairing Modal */}
      <WhatsAppQrConnectModal
        isOpen={isQrConnectModalOpen}
        onClose={() => {
          setIsQrConnectModalOpen(false);
          setReconnectSessionId(undefined);
        }}
        existingSessionId={reconnectSessionId}
        onSuccess={handleQrSuccess}
      />
    </div>
  );
};
