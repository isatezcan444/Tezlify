import { useState, useEffect, useCallback, useRef } from 'react';
import { WhatsAppRepository } from '../data/whatsapp/whatsappRepository';
import { ConversationDetail, Message, ConversationStatus } from '../types';

const numericId = (id: number | string | undefined): number => (typeof id === 'number' && Number.isFinite(id) ? id : 0);

export const sortMessagesChronologically = (list: Message[]): Message[] => {
  return [...list].sort((a, b) => {
    const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
    const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
    if (tA !== tB) return tA - tB;
    return numericId(a.id) - numericId(b.id);
  });
};

interface UseWhatsAppConversationOptions {
  leadId?: number;
  conversationId?: number;
  enabled?: boolean;
  autoMarkAsRead?: boolean;
  initialLimit?: number;
}

export function useWhatsAppConversation({
  leadId,
  conversationId,
  enabled = true,
  autoMarkAsRead = true,
  initialLimit = 50,
}: UseWhatsAppConversationOptions) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const isFetchingOlderRef = useRef(false);

  const fetchConversation = useCallback(async () => {
    if (!enabled || (!leadId && !conversationId)) {
      setConversation(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      let data: ConversationDetail;
      if (leadId) {
        data = await WhatsAppRepository.getLeadConversation(leadId);
      } else if (conversationId) {
        data = await WhatsAppRepository.getConversation(conversationId);
      } else {
        return;
      }
      data.messages = sortMessagesChronologically(data.messages || []);
      setConversation(data);

      // Auto mark as read when opened if there are unread messages
      if (autoMarkAsRead && data.unread_count > 0) {
        try {
          await WhatsAppRepository.markConversationAsRead(data.id);
          setConversation((prev) => (prev ? { ...prev, unread_count: 0 } : null));
        } catch (e) {
          console.warn('[useWhatsAppConversation] Mark as read failed:', e);
        }
      }
    } catch (err: any) {
      console.error('[useWhatsAppConversation] Fetch error:', err);
      setError(err.message || 'Failed to load conversation');
    } finally {
      setLoading(false);
    }
  }, [leadId, conversationId, enabled, autoMarkAsRead, initialLimit]);

  useEffect(() => {
    fetchConversation();
  }, [fetchConversation]);

  // Load older messages for pagination
  const loadOlderMessages = useCallback(async () => {
    if (!conversation || !conversation.has_more || isFetchingOlderRef.current) {
      return;
    }

    // Pagination cursors are always real numeric DB ids; optimistic string
    // rows must never be sent as `before`.
    const firstNumericId = conversation.messages.find((m) => typeof m.id === 'number' && m.id > 0)?.id;
    const oldestId = conversation.oldest_message_id || firstNumericId;
    if (typeof oldestId !== 'number' || oldestId <= 0) return;

    isFetchingOlderRef.current = true;
    setLoadingOlder(true);

    try {
      const res = await WhatsAppRepository.getConversationMessages(conversation.id, {
        limit: 30,
        before: oldestId,
      });

      if (res.messages.length > 0) {
        setConversation((prev) => {
          if (!prev) return prev;
          // Filter out any messages already present in state
          const existingIds = new Set(prev.messages.map((m) => m.id));
          const existingWaIds = new Set(prev.messages.map((m) => m.wa_message_id).filter(Boolean));
          const uniqueNew = res.messages.filter(
            (m) => !existingIds.has(m.id) && (!m.wa_message_id || !existingWaIds.has(m.wa_message_id))
          );

          const merged = sortMessagesChronologically([...uniqueNew, ...prev.messages]);
          const mergedOldest = merged.find((m) => typeof m.id === 'number' && m.id > 0)?.id;
          return {
            ...prev,
            has_more: res.has_more,
            oldest_message_id:
              res.oldest_message_id ??
              (typeof mergedOldest === 'number' ? mergedOldest : prev.oldest_message_id),
            messages: merged,
          };
        });
      } else {
        setConversation((prev) => (prev ? { ...prev, has_more: false } : null));
      }
    } catch (err: any) {
      console.error('[useWhatsAppConversation] Load older messages error:', err);
    } finally {
      setLoadingOlder(false);
      isFetchingOlderRef.current = false;
    }
  }, [conversation]);

  // Explicit mark as read helper
  const markAsRead = useCallback(async () => {
    if (!conversation) return;
    try {
      await WhatsAppRepository.markConversationAsRead(conversation.id);
      setConversation((prev) => (prev ? { ...prev, unread_count: 0 } : null));
    } catch (e) {
      console.warn('[useWhatsAppConversation] Mark as read failed:', e);
    }
  }, [conversation]);

  // Update status helper
  const updateStatus = useCallback(async (status: ConversationStatus) => {
    if (!conversation) return;
    try {
      await WhatsAppRepository.updateConversationStatus(conversation.id, status);
      setConversation((prev) => (prev ? { ...prev, status } : null));
    } catch (e) {
      console.warn('[useWhatsAppConversation] Update status failed:', e);
    }
  }, [conversation]);

  // Send message helper with optimistic instant UI feedback (WhatsApp Web snappy experience)
  // Identity model: optimistic rows carry a client-only string id
  // (`optimistic_cmsg_...`) plus a `client_message_id` idempotency key. The
  // server response carries the REAL numeric DB id, which replaces the
  // optimistic row via client_message_id reconciliation.
  const sendMessage = useCallback(async (text: string) => {
    if (!conversation) return;
    const clientMid = `cmsg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempId = `optimistic_${clientMid}`;
    const tempCreatedAt = new Date().toISOString();
    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: conversation.id,
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      body: text,
      status: 'PENDING',
      client_message_id: clientMid,
      created_at: tempCreatedAt,
      sender_phone: 'ME',
      recipient_phone: conversation.lead_phone || '',
    };

    // 1. Instant append (0ms perceived latency)
    setConversation((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        status: 'ACTIVE',
        last_message_at: tempCreatedAt,
        last_message_preview: text,
        messages: sortMessagesChronologically([...prev.messages, optimisticMsg]),
      };
    });

    try {
      // 2. Dispatch through the frontend-only repository (idempotent via clientMid)
      const resMsg = await WhatsAppRepository.sendMessage(conversation.id, text, clientMid);

      // 3. Reconcile temporary message with real database message
      setConversation((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: 'ACTIVE',
          last_message_at: resMsg.created_at,
          last_message_preview: resMsg.body,
          messages: sortMessagesChronologically(
            prev.messages.map((m) =>
              m.id === tempId || (clientMid && m.client_message_id === clientMid) ? resMsg : m
            )
          ),
        };
      });
      return resMsg;
    } catch (err: any) {
      // 4. Mark optimistic message as failed on error (keeps clientMid for resend)
      setConversation((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === tempId
              ? { ...m, status: 'FAILED', error_message: err.message || 'Gönderilemedi' }
              : m
          ),
        };
      });
      throw err;
    }
  }, [conversation]);

  // Send template helper
  const sendTemplate = useCallback(async (templateKey: string, variables: Record<string, string> = {}) => {
    if (!conversation) return;
    const resMsg = await WhatsAppRepository.sendTemplate(conversation.id, templateKey, variables);
    setConversation((prev) => {
      if (!prev) return prev;
      const isDuplicate = prev.messages.some(
        (m) => (resMsg.wa_message_id && m.wa_message_id === resMsg.wa_message_id) || m.id === resMsg.id
      );
      if (isDuplicate) return prev;
      return {
        ...prev,
        status: 'ACTIVE',
        last_message_at: resMsg.created_at,
        last_message_preview: resMsg.body,
        messages: sortMessagesChronologically([...prev.messages, resMsg]),
      };
    });
    return resMsg;
  }, [conversation]);

  // Retry failed message helper. Optimistic rows (string ids) are never sent
  // to /retry; they are re-POSTed with their existing client_message_id so
  // idempotency is preserved and no fake DB id reaches the backend.
  const retryMessage = useCallback(async (messageId: number | string) => {
    if (!conversation) return;
    const target = conversation.messages.find((m) => m.id === messageId);
    const targetClientMid = target?.client_message_id;
    const isRealDbId = typeof messageId === 'number' && Number.isInteger(messageId) && messageId > 0;
    if (!isRealDbId) {
      if (!target || !targetClientMid || !target.body) {
        throw new Error('Mesaj henüz sunucuya kaydedilmedi. Lütfen önce gönderimin tamamlanmasını bekleyin.');
      }
      const resMsg = await WhatsAppRepository.sendMessage(conversation.id, target.body, targetClientMid);
      setConversation((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: sortMessagesChronologically(
            prev.messages.map((m) =>
              m.id === messageId || (targetClientMid && m.client_message_id === targetClientMid) ? resMsg : m
            )
          ),
        };
      });
      return resMsg;
    }
    const resMsg = await WhatsAppRepository.retryMessage(conversation.id, messageId);
    setConversation((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: sortMessagesChronologically(prev.messages.map((m) => (m.id === messageId ? resMsg : m))),
      };
    });
    return resMsg;
  }, [conversation]);

  // Send outbound media helper
  const sendMedia = useCallback(async (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => {
    if (!conversation) return;
    const resMsg = await WhatsAppRepository.sendMedia(conversation.id, {
      media_type: mediaType,
      media_url: mediaUrl,
      caption,
      filename,
    });
    setConversation((prev) => {
      if (!prev) return prev;
      const isDuplicate = prev.messages.some(
        (m) => (resMsg.wa_message_id && m.wa_message_id === resMsg.wa_message_id) || m.id === resMsg.id
      );
      if (isDuplicate) return prev;
      return {
        ...prev,
        status: 'ACTIVE',
        last_message_at: resMsg.created_at,
        last_message_preview: resMsg.body,
        messages: sortMessagesChronologically([...prev.messages, resMsg]),
      };
    });
    return resMsg;
  }, [conversation]);

  // Event Listener via CustomEvent bus (frontend-only repository events:
  // message_status_updated, conversation_status_updated, conversation_read)
  useEffect(() => {
    const handleWsEvent = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      const eventData = customEvent.detail;
      if (!eventData) return;

      const matchesConv =
        (conversationId && eventData.conversation_id === conversationId) ||
        (conversation && eventData.conversation_id === conversation.id);

      // Handle message status updates (PENDING -> SENT -> DELIVERED -> READ / FAILED).
      // Reconcile by client_message_id first (survives the optimistic phase),
      // then numeric DB id. Merge the real id into the optimistic row instead
      // of appending a duplicate.
      if (eventData.event === 'message_status_updated' && matchesConv) {
        const clientMid = eventData.client_message_id;
        const serverId = eventData.id;
        const numericServerId =
          typeof eventData.message_id === 'number' && eventData.message_id > 0
            ? eventData.message_id
            : typeof serverId === 'number' && serverId > 0
              ? serverId
              : undefined;
        const newStatus = eventData.status;

        setConversation((prev) => {
          if (!prev) return prev;
          let changed = false;
          const updatedMessages = prev.messages.map((m) => {
            const matchesClientMid = clientMid && m.client_message_id === clientMid;
            const matchesId = numericServerId && m.id === numericServerId;
            if (matchesClientMid || matchesId) {
              changed = true;
              return {
                ...m,
                id: numericServerId ?? m.id,
                status: newStatus,
                error_message: eventData.error_message,
              };
            }
            return m;
          });

          if (!changed) return prev;
          return { ...prev, messages: updatedMessages };
        });
      }

      // Handle conversation lifecycle status updates
      if (eventData.event === 'conversation_status_updated' && matchesConv) {
        setConversation((prev) => (prev ? { ...prev, status: eventData.status } : null));
      }

      // Handle conversation read event
      if (eventData.event === 'conversation_read' && matchesConv) {
        setConversation((prev) => (prev ? { ...prev, unread_count: 0 } : null));
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
    };
  }, [leadId, conversationId, conversation, fetchConversation]);

  return {
    conversation,
    messages: conversation?.messages || [],
    hasMore: conversation?.has_more ?? false,
    loading,
    loadingOlder,
    error,
    refresh: fetchConversation,
    loadOlderMessages,
    markAsRead,
    updateStatus,
    sendMessage,
    sendTemplate,
    retryMessage,
    sendMedia,
  };
}
