import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiClient } from '../api/client';
import { ConversationDetail, Message, ConversationStatus } from '../types';

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
        data = await ApiClient.getLeadConversation(leadId, { limit: initialLimit });
      } else if (conversationId) {
        data = await ApiClient.getConversation(conversationId, { limit: initialLimit });
      } else {
        return;
      }
      setConversation(data);

      // Auto mark as read when opened if there are unread messages
      if (autoMarkAsRead && data.unread_count > 0) {
        try {
          await ApiClient.markConversationAsRead(data.id);
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

    const oldestId = conversation.oldest_message_id || conversation.messages[0]?.id;
    if (!oldestId) return;

    isFetchingOlderRef.current = true;
    setLoadingOlder(true);

    try {
      const res = await ApiClient.getConversationMessages(conversation.id, {
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

          return {
            ...prev,
            has_more: res.has_more,
            oldest_message_id: res.oldest_message_id || (uniqueNew[0]?.id ?? prev.oldest_message_id),
            messages: [...uniqueNew, ...prev.messages],
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
      await ApiClient.markConversationAsRead(conversation.id);
      setConversation((prev) => (prev ? { ...prev, unread_count: 0 } : null));
    } catch (e) {
      console.warn('[useWhatsAppConversation] Mark as read failed:', e);
    }
  }, [conversation]);

  // Update status helper
  const updateStatus = useCallback(async (status: ConversationStatus) => {
    if (!conversation) return;
    try {
      await ApiClient.updateConversationStatus(conversation.id, status);
      setConversation((prev) => (prev ? { ...prev, status } : null));
    } catch (e) {
      console.warn('[useWhatsAppConversation] Update status failed:', e);
    }
  }, [conversation]);

  // Send message helper
  const sendMessage = useCallback(async (text: string) => {
    if (!conversation) return;
    const resMsg = await ApiClient.sendMessage(conversation.id, text);
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
        messages: [...prev.messages, resMsg],
      };
    });
    return resMsg;
  }, [conversation]);

  // Send template helper
  const sendTemplate = useCallback(async (templateKey: string, variables: Record<string, string> = {}) => {
    if (!conversation) return;
    const resMsg = await ApiClient.sendTemplate(conversation.id, templateKey, variables);
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
        messages: [...prev.messages, resMsg],
      };
    });
    return resMsg;
  }, [conversation]);

  // Retry failed message helper
  const retryMessage = useCallback(async (messageId: number) => {
    if (!conversation) return;
    const resMsg = await ApiClient.retryMessage(conversation.id, messageId);
    setConversation((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: prev.messages.map((m) => (m.id === messageId ? resMsg : m)),
      };
    });
    return resMsg;
  }, [conversation]);

  // Send outbound media helper
  const sendMedia = useCallback(async (mediaType: 'IMAGE' | 'DOCUMENT', mediaUrl: string, caption?: string, filename?: string) => {
    if (!conversation) return;
    const resMsg = await ApiClient.sendMedia(conversation.id, {
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
        messages: [...prev.messages, resMsg],
      };
    });
    return resMsg;
  }, [conversation]);

  // Real-time Event Listener via CustomEvent bus
  useEffect(() => {
    const handleWsEvent = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      const eventData = customEvent.detail;
      if (!eventData) return;

      // Handle outbound message sent event
      if (eventData.event === 'outbound_message_sent') {
        const matchesConv =
          (conversationId && eventData.conversation_id === conversationId) ||
          (conversation && eventData.conversation_id === conversation.id);

        if (matchesConv) {
          setConversation((prev) => {
            if (!prev) return prev;
            const msgId = eventData.message_id;
            const waId = eventData.wa_message_id;
            const isDuplicate = prev.messages.some(
              (m) => (waId && m.wa_message_id === waId) || (msgId && m.id === msgId)
            );
            if (isDuplicate) return prev;

            const newMsg: Message = {
              id: eventData.message_id || Date.now(),
              conversation_id: prev.id,
              direction: 'OUTBOUND',
              message_type: 'TEXT',
              status: 'SENT',
              body: eventData.message,
              wa_message_id: eventData.wa_message_id,
              sender_phone: 'BUSINESS',
              recipient_phone: eventData.recipient_phone,
              created_at: eventData.created_at || new Date().toISOString(),
            };

            return {
              ...prev,
              status: 'ACTIVE',
              last_message_at: newMsg.created_at,
              last_message_preview: newMsg.body,
              messages: [...prev.messages, newMsg],
            };
          });
        }
      }

      // Handle incoming message or mirrored outbound message (TEXT or RICH MEDIA)
      if (eventData.event === 'new_message' || eventData.event === 'inbound_reply') {
        const matchesLead = leadId && eventData.lead_id === leadId;
        const matchesConvId = conversationId && eventData.conversation_id === conversationId;
        const matchesCurrentConv =
          conversation && (eventData.conversation_id === conversation.id || eventData.lead_id === conversation.lead_id);

        if (matchesLead || matchesConvId || matchesCurrentConv) {
          setConversation((prev) => {
            if (!prev) return prev;

            const msgObj = eventData.message && typeof eventData.message === 'object' ? eventData.message : null;
            const msgId = msgObj ? msgObj.id : eventData.message_id;
            const waId = msgObj ? msgObj.wa_message_id : eventData.wa_message_id;

            // Idempotency: check if message with this wa_message_id or id already exists
            const isDuplicate = prev.messages.some(
              (m) => (waId && m.wa_message_id === waId) || (msgId && m.id === msgId)
            );

            if (isDuplicate) return prev;

            const newMsg: Message = msgObj ? {
              id: msgObj.id || Date.now(),
              conversation_id: prev.id,
              direction: msgObj.direction || 'INBOUND',
              message_type: msgObj.message_type || 'TEXT',
              status: msgObj.status || 'RECEIVED',
              body: msgObj.body,
              wa_message_id: msgObj.wa_message_id,
              sender_phone: eventData.lead_phone || '',
              created_at: msgObj.created_at || new Date().toISOString(),
            } : {
              id: eventData.message_id || Date.now(),
              conversation_id: prev.id,
              direction: eventData.direction || 'INBOUND',
              message_type: eventData.message_type || 'TEXT',
              status: eventData.status || 'RECEIVED',
              body: eventData.message,
              media_id: eventData.media_id,
              media_mime_type: eventData.media_mime_type,
              media_filename: eventData.media_filename,
              media_caption: eventData.media_caption,
              wa_message_id: eventData.wa_message_id,
              sender_phone: eventData.phone,
              created_at: eventData.created_at || new Date().toISOString(),
            };

            return {
              ...prev,
              status: 'ACTIVE',
              last_message_at: newMsg.created_at,
              last_message_preview: newMsg.body,
              unread_count: autoMarkAsRead || newMsg.direction === 'OUTBOUND' ? 0 : (prev.unread_count || 0) + 1,
              messages: [...prev.messages, newMsg],
            };
          });

          if (autoMarkAsRead && conversation) {
            ApiClient.markConversationAsRead(conversation.id).catch(() => {});
          }
        }
      }

      // Handle message status updates (SENT -> DELIVERED -> READ)
      if (eventData.event === 'message_status_updated') {
        const waId = eventData.message_id;
        const newStatus = eventData.status;

        setConversation((prev) => {
          if (!prev) return prev;
          let changed = false;
          const updatedMessages = prev.messages.map((m) => {
            if (m.wa_message_id === waId) {
              changed = true;
              return { ...m, status: newStatus, error_message: eventData.error_message };
            }
            return m;
          });

          if (!changed) return prev;
          return { ...prev, messages: updatedMessages };
        });
      }

      // Handle conversation lifecycle status updates
      if (eventData.event === 'conversation_status_updated') {
        const matchesConv =
          (conversationId && eventData.conversation_id === conversationId) ||
          (conversation && eventData.conversation_id === conversation.id);

        if (matchesConv) {
          setConversation((prev) => (prev ? { ...prev, status: eventData.status } : null));
        }
      }

      // Handle conversation read event
      if (eventData.event === 'conversation_read') {
        const matchesConv =
          (conversationId && eventData.conversation_id === conversationId) ||
          (conversation && eventData.conversation_id === conversation.id);

        if (matchesConv) {
          setConversation((prev) => (prev ? { ...prev, unread_count: 0 } : null));
        }
      }
    };

    // Reconnect Recovery: silently refresh active conversation if connection drops and recovers
    const handleReconnect = () => {
      if (enabled && (leadId || conversationId)) {
        console.log('[useWhatsAppConversation] WebSocket reconnected. Performing silent sync recovery...');
        fetchConversation();
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    window.addEventListener('tezlify:ws_connected', handleReconnect);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
      window.removeEventListener('tezlify:ws_connected', handleReconnect);
    };
  }, [leadId, conversationId, conversation, autoMarkAsRead, enabled, fetchConversation]);

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
