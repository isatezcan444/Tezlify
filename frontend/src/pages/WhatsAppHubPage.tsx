import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  Smartphone, 
  QrCode, 
  ShieldCheck, 
  BatteryCharging, 
  Send, 
  Flame, 
  CheckCircle2, 
  Trash2, 
  PowerOff, 
  Loader2, 
  X, 
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
  KeyRound,
  RefreshCw,
  MessageSquarePlus,
  Users
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { WhatsAppSession, MessageLog, Conversation, ConversationStatus, Lead } from '../types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/EmptyState';
import { Avatar } from '../components/ui/Avatar';
import { WhatsAppIcon } from '../components/ui/whatsapp-icon';
import { SessionCard, ConversationList, ChatThread, ChatComposer, LeadDetailDrawer, TemplateSelectModal, NewChatModal } from '../components/domain';
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
import { useWhatsAppConversation } from '../hooks/useWhatsAppConversation';

interface WhatsAppHubPageProps {
  onRefreshStats: () => void;
}

export const WhatsAppHubPage: React.FC<WhatsAppHubPageProps> = ({ onRefreshStats }) => {
  const toast = useToast();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [, setLogs] = useState<MessageLog[]>([]);
  const [, setLoading] = useState(false);

  // Tab State: 'conversations' | 'sessions' | 'antiban'
  const [hubTab, setHubTab] = useState<'conversations' | 'sessions' | 'antiban'>('conversations');

  // Live Conversations State
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
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

  const handleSyncChats = async () => {
    setIsSyncingChats(true);
    try {
      const res = await ApiClient.syncWhatsAppChats();
      toast.success(
        res.synced_count > 0
          ? `${res.synced_count} sohbet WhatsApp'tan başarıyla eşitlendi.`
          : 'WhatsApp sohbetleriniz eşitlendi.',
        t('common.success')
      );
      await fetchConversations();
    } catch (err: any) {
      toast.error(err.message || 'Sohbetler eşitlenemedi', t('common.error'));
    } finally {
      setIsSyncingChats(false);
    }
  };

  // Active chat hook for selected conversation
  const {
    conversation: activeConv,
    messages: activeMessages,
    hasMore: activeHasMore,
    loadingOlder: activeLoadingOlder,
    loading: activeChatLoading,
    loadOlderMessages: activeLoadOlder,
    sendMessage: activeSendMessage,
    sendTemplate: activeSendTemplate,
    retryMessage: activeRetryMessage,
    sendMedia: activeSendMedia,
  } = useWhatsAppConversation({
    conversationId: selectedConv?.id,
    enabled: hubTab === 'conversations' && !!selectedConv,
    autoMarkAsRead: true,
  });

  const handleOpenLead = async (leadId: number) => {
    setLeadLoading(true);
    try {
      const leadData = await ApiClient.getLead(leadId);
      setDrawerLead(leadData);
      setIsLeadDrawerOpen(true);
    } catch (err: any) {
      toast.error(err.message || 'Müşteri bilgisi yüklenemedi', t('common.error'));
    } finally {
      setLeadLoading(false);
    }
  };

  const handleStatusChange = async (convId: number, newStatus: ConversationStatus) => {
    try {
      await ApiClient.updateConversationStatus(convId, newStatus);
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
      );
      if (selectedConv && selectedConv.id === convId) {
        setSelectedConv((prev) => (prev ? { ...prev, status: newStatus } : prev));
      }
      toast.success(t('whatsapp.statusUpdated') || 'Durum güncellendi', t('common.success'));
    } catch (err: any) {
      toast.error(err.message || 'Durum güncellenemedi', t('common.error'));
    }
  };

  const fetchConversations = async () => {
    setConvsLoading(true);
    try {
      const data = await ApiClient.getConversations();
      setConversations(data);
      if (data.length > 0 && !selectedConv) {
        setSelectedConv(data[0]);
      }
    } catch (e) {
      console.warn('Failed to load conversations:', e);
    } finally {
      setConvsLoading(false);
    }
  };

  // Real-time listener for conversation list unread, status and preview updates
  useEffect(() => {
    const handleWsEvent = (e: Event) => {
      const customEvent = e as CustomEvent<any>;
      const eventData = customEvent.detail;
      if (!eventData) return;

      if (eventData.event === 'new_message' || eventData.event === 'inbound_reply') {
        const convId = eventData.conversation_id;
        const isCurrentSelected = selectedConv && selectedConv.id === convId;
        const msgText = eventData.message?.body || eventData.message || '';
        const msgTime = eventData.message?.created_at || eventData.timestamp || new Date().toISOString();
        const isOutbound = eventData.message?.direction === 'OUTBOUND' || eventData.direction === 'OUTBOUND';

        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === convId);
          if (idx !== -1) {
            const existing = prev[idx];
            const updated: Conversation = {
              ...existing,
              status: 'ACTIVE',
              last_message_preview: typeof msgText === 'string' ? msgText : existing.last_message_preview,
              last_message_at: msgTime,
              unread_count: isCurrentSelected || isOutbound ? 0 : (existing.unread_count || 0) + 1,
            };
            if (selectedConv && selectedConv.id === convId) {
              setSelectedConv(updated);
            }
            // Move updated conversation to top of list
            const rest = prev.filter((c) => c.id !== convId);
            return [updated, ...rest];
          } else {
            // New conversation arrived
            fetchConversations();
            return prev;
          }
        });
      }

      if (eventData.event === 'conversations_updated') {
        fetchConversations();
      }

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
      }
    };

    window.addEventListener('tezlify:ws_event', handleWsEvent);
    return () => {
      window.removeEventListener('tezlify:ws_event', handleWsEvent);
    };
  }, [selectedConv]);

  // Anti-Ban Timing & Change-Tracking State
  const [savedConfig, setSavedConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [config, setConfig] = useState<AntiBanConfig>(getStoredAntiBanConfig());
  const [isSavingAntiBan, setIsSavingAntiBan] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // New Line / QR & Pairing Code Modal
  const [isQRModalOpen, setIsQRModalOpen] = useState(false);
  const isQRModalOpenRef = useRef(false);
  useEffect(() => {
    isQRModalOpenRef.current = isQRModalOpen;
  }, [isQRModalOpen]);

  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [pairingSessionId, setPairingSessionId] = useState<number | null>(null);
  const [isPairingSuccess, setIsPairingSuccess] = useState(false);
  const [pairingMode, setPairingMode] = useState<'qr' | 'code'>('qr');
  const [pairingPhone, setPairingPhone] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [isRequestingCode, setIsRequestingCode] = useState(false);
  const [isCopiedCode, setIsCopiedCode] = useState(false);
  const [isRefreshingQr, setIsRefreshingQr] = useState(false);
  const [qrSecondsLeft, setQrSecondsLeft] = useState(25);

  const handleRefreshQr = async (sessionId?: number) => {
    const targetId = sessionId || pairingSessionId;
    if (!targetId || isRefreshingQr) return;
    setIsRefreshingQr(true);
    try {
      const res = await ApiClient.refreshSessionQr(targetId);
      if (res.qr_code) {
        setSessions((prev) =>
          prev.map((s) => (s.id === targetId ? { ...s, qr_code: res.qr_code } : s))
        );
        setQrSecondsLeft(25);
      }
      if (res.status === 'CONNECTED') {
        setIsPairingSuccess(true);
        toast.success(t('whatsapp.qrPairSuccess'), t('common.success'));
        fetchSessionsAndLogs();
        onRefreshStats();
        setTimeout(() => setIsQRModalOpen(false), 1500);
      }
    } catch (e: any) {
      toast.error(e.message || 'QR kod yenilenemedi');
    } finally {
      setIsRefreshingQr(false);
    }
  };

  const handleRequestPairingCode = async () => {
    if (!pairingSessionId || !pairingPhone.trim()) {
      toast.error('Lütfen geçerli bir telefon numarası girin.');
      return;
    }
    setIsRequestingCode(true);
    try {
      const res = await ApiClient.getSessionPairingCode(pairingSessionId, pairingPhone.trim());
      if (res.pairing_code) {
        setPairingCode(res.pairing_code);
        toast.success(t('whatsapp.pairingCodeTitle'));
      }
    } catch (err: any) {
      toast.error(err.message || 'Eşleştirme kodu alınamadı.');
    } finally {
      setIsRequestingCode(false);
    }
  };

  const handleCopyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode);
    setIsCopiedCode(true);
    toast.success(t('whatsapp.codeCopied'));
    setTimeout(() => setIsCopiedCode(false), 2500);
  };

  // Test Sandbox State
  const [testPhone, setTestPhone] = useState('0532 100 20 30');
  const [testMsg, setTestMsg] = useState('Tezlify WhatsApp Gateway test message.');
  const [selectedSessionForTest] = useState<number | undefined>(undefined);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchSessionsAndLogs = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [sessData, logsData] = await Promise.all([
        ApiClient.getWhatsAppSessions(),
        ApiClient.getMessageLogs()
      ]);
      setSessions(sessData);
      setLogs(logsData);
    } catch (err: any) {
      toast.error(err.message, t('common.error'));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessionsAndLogs();
    fetchConversations();

    // Listen to real-time inbound messages and WhatsApp session events
    const handleWs = (e: Event) => {
      const eventData = (e as CustomEvent<any>).detail;
      if (eventData?.event === 'inbound_reply') {
        fetchConversations();
      } else if (eventData?.event === 'session_connected') {
        fetchSessionsAndLogs(true);
        onRefreshStats();
        if (isQRModalOpenRef.current) {
          setIsPairingSuccess(true);
          toast.success(t('whatsapp.qrPairSuccess'), t('common.success'));
          setTimeout(() => {
            setIsQRModalOpen(false);
          }, 1500);
        }
      } else if (eventData?.event === 'session_disconnected') {
        fetchSessionsAndLogs(true);
        onRefreshStats();
      } else if (eventData?.event === 'session_qr_updated') {
        setSessions((prev) =>
          prev.map((s) => (s.id === eventData.session_id ? { ...s, qr_code: eventData.qr_code } : s))
        );
        setQrSecondsLeft(25);
      } else if (eventData?.event === 'conversations_cleared') {
        setConversations([]);
        setSelectedConv(null);
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
  }, []);

  // Countdown timer for QR code validity
  useEffect(() => {
    if (!isQRModalOpen || pairingMode !== 'qr' || isPairingSuccess) return;

    const timer = setInterval(() => {
      setQrSecondsLeft((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isQRModalOpen, pairingMode, isPairingSuccess]);

  // Polling fallback to guarantee state progression when QR modal is open
  useEffect(() => {
    if (!isQRModalOpen || !pairingSessionId || isPairingSuccess) return;

    let isMounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    pollTimer = setInterval(async () => {
      try {
        const res = await ApiClient.getSessionQr(pairingSessionId);
        if (!isMounted) return;
        if (res.status === 'CONNECTED') {
          if (pollTimer) clearInterval(pollTimer);
          setIsPairingSuccess(true);
          toast.success(t('whatsapp.qrPairSuccess'), t('common.success'));
          fetchSessionsAndLogs(true);
          onRefreshStats();
          setTimeout(() => {
            if (isMounted) setIsQRModalOpen(false);
          }, 1500);
        } else if (res.qr_code) {
          setSessions((prev) => {
            const current = prev.find((s) => s.id === pairingSessionId);
            if (current && current.qr_code !== res.qr_code) {
              setQrSecondsLeft(25);
            }
            return prev.map((s) => (s.id === pairingSessionId ? { ...s, qr_code: res.qr_code } : s));
          });
        }
      } catch (e) {
        // ignore transient poll error
      }
    }, 2000);

    return () => {
      isMounted = false;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [isQRModalOpen, pairingSessionId, isPairingSuccess]);

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

  const handleCreateSession = async () => {
    if (isCreatingSession) return;
    setIsCreatingSession(true);

    // Auto-generate unique sequential session name (Line 1, Line 2...)
    const existingNames = new Set(sessions.map((s) => s.session_name));
    let nextIdx = sessions.length + 1;
    let targetName = `Line ${nextIdx}`;
    while (existingNames.has(targetName)) {
      nextIdx++;
      targetName = `Line ${nextIdx}`;
    }

    try {
      const session = await ApiClient.createWhatsAppSession(targetName);
      setPairingSessionId(session.id);
      setIsQRModalOpen(true);
      setIsPairingSuccess(false);
      setPairingMode('qr');
      setPairingCode(null);
      setPairingPhone('');
      setQrSecondsLeft(25);
      // Optimistically add session to state so it shows up instantly
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
      fetchSessionsAndLogs(true);
      onRefreshStats();
      if (!session.qr_code) {
        handleRefreshQr(session.id);
      }
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleSimulateScan = async () => {
    if (!pairingSessionId) return;
    try {
      await ApiClient.simulateConnectSession(pairingSessionId);
      setIsPairingSuccess(true);
      toast.success(t('whatsapp.qrPairSuccess'), t('common.success'));
      fetchSessionsAndLogs(true);
      onRefreshStats();
      setTimeout(() => {
        setIsQRModalOpen(false);
      }, 1200);
    } catch (err: any) {
      toast.error(err.message, t('common.error'));
    }
  };

  const handleDisconnect = async (sessionId: number) => {
    // 1. Instant optimistic state update (0ms perceived latency)
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: 'DISCONNECTED', is_phone_online: false, qr_code: null }
          : s
      )
    );
    toast.info(t('whatsapp.statusDisconnected'), t('common.info'));

    try {
      await ApiClient.disconnectSession(sessionId);
      fetchSessionsAndLogs(true);
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
      fetchSessionsAndLogs(true);
    }
  };

  const handleDelete = async (sessionId: number) => {
    const ok = await toast.confirm({
      title: t('whatsapp.deleteSession'),
      message: t('leads.deleteConfirmMsg'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (!ok) return;

    // 1. Instant optimistic removal of session and live conversations (0ms perceived latency)
    const previousSessions = [...sessions];
    const previousConversations = [...conversations];
    const previousSelected = selectedConv;

    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setConversations([]);
    setSelectedConv(null);
    toast.success(t('common.success'), t('whatsapp.deleteSession'));

    try {
      await ApiClient.deleteSession(sessionId);
      fetchSessionsAndLogs(true);
      fetchConversations();
      onRefreshStats();
    } catch (err: any) {
      // Revert if API failed
      setSessions(previousSessions);
      setConversations(previousConversations);
      setSelectedConv(previousSelected);
      toast.error(err.message || t('common.error'), t('common.error'));
    }
  };

  const handleSendTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPhone || !testMsg) return;
    setTestSending(true);
    setTestResult(null);

    try {
      const res = await ApiClient.sendTestMessage(testPhone, testMsg, selectedSessionForTest);
      setTestResult({ ok: true, message: res.message });
      fetchSessionsAndLogs();
      onRefreshStats();
    } catch (err: any) {
      setTestResult({ ok: false, message: `${t('common.error')}: ${err.message}` });
    } finally {
      setTestSending(false);
    }
  };

  return (
    <div className="space-y-6 pb-16 select-none animate-fade-in">
      {/* Top Header & Tab Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
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

        {/* Segmented Tab Switcher */}
        <div className="flex p-1 rounded-2xl bg-slate-200/80 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] w-full md:w-auto">
          <button
            type="button"
            onClick={() => setHubTab('conversations')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer ${
              hubTab === 'conversations'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>{t('whatsapp.tabConversations')}</span>
            {conversations.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-[#25D366]/20 text-[#25D366] dark:text-[#25D366]">
                {conversations.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setHubTab('sessions')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer ${
              hubTab === 'sessions'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>{t('whatsapp.tabSessions')}</span>
          </button>

          <button
            type="button"
            onClick={() => setHubTab('antiban')}
            className={`flex-1 md:flex-initial py-1.5 px-3.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center space-x-2 cursor-pointer ${
              hubTab === 'antiban'
                ? 'bg-white dark:bg-[#7367F0] text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{t('whatsapp.tabAntiBan')}</span>
            {hasUnsavedChanges && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
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
                  ApiClient.markConversationAsRead(c.id).catch(() => {});
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
      {/* 2. HAT VE OTURUM YÖNETİMİ */}
      {/* ========================================================================= */}
      {hubTab === 'sessions' && (
        <div className="space-y-6">
          <div className="flex justify-end">
            <Button
              onClick={handleCreateSession}
              disabled={isCreatingSession}
              size="sm"
              className="space-x-2 font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              {isCreatingSession ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <QrCode className="w-4 h-4" />
              )}
              <span>{t('whatsapp.addSession')}</span>
            </Button>
          </div>

          {sessions.length === 0 ? (
            <Card className="p-8">
              <EmptyState
                icon={QrCode}
                title={t('whatsapp.noSessions')}
                description={t('whatsapp.noSessionsDesc')}
                action={{
                  label: t('whatsapp.addSession'),
                  onClick: handleCreateSession,
                  icon: QrCode,
                }}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {sessions.map((sess) => (
                <SessionCard
                  key={sess.id}
                  session={sess}
                  onDisconnect={handleDisconnect}
                  onScanQR={(id) => {
                    setPairingSessionId(id);
                    setIsQRModalOpen(true);
                    setIsPairingSuccess(false);
                    setPairingMode('qr');
                    setPairingCode(null);
                    setPairingPhone('');
                    setQrSecondsLeft(25);
                    handleRefreshQr(id);
                  }}
                  onDelete={handleDelete}
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

      {/* Two-Column: Test Sandbox & Anti-Ban Protocols */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Direct Test Sandbox */}
        <div className="lg:col-span-6">
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#FF9F43]" />
                {t('whatsapp.testSandboxTitle')}
              </h3>
              <Badge variant="warning" className="font-mono text-[9px]">SANDBOX</Badge>
            </div>
            <p className="text-xs text-slate-500 dark:text-[#7E7F96] font-medium">
              {t('whatsapp.testSandboxSubtitle')}
            </p>

            <form onSubmit={handleSendTest} className="space-y-3 text-xs">
              <div>
                <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">
                  {t('whatsapp.testRecipient')}
                </label>
                <input
                  type="text"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder={t('whatsapp.testPhonePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg vuexy-input text-xs font-mono font-bold"
                  required
                />
              </div>

              <div>
                <label className="text-slate-700 dark:text-slate-300 font-bold block mb-1">{t('whatsapp.testMessageText')}</label>
                <textarea
                  value={testMsg}
                  onChange={(e) => setTestMsg(e.target.value)}
                  rows={3}
                  className="w-full p-3 rounded-lg vuexy-input text-xs leading-relaxed font-medium"
                  placeholder={t('whatsapp.testMessagePlaceholder')}
                  required
                />
              </div>

              {testResult && (
                <div
                  className={`p-3 rounded-lg text-xs font-bold ${
                    testResult.ok
                      ? 'bg-[#28C76F]/15 border border-[#28C76F]/30 text-[#28C76F]'
                      : 'bg-[#EA5455]/15 border border-[#EA5455]/30 text-[#EA5455]'
                  }`}
                >
                  {testResult.message}
                </div>
              )}

              <Button
                type="submit"
                disabled={testSending || !testPhone || !testMsg}
                size="lg"
                className="w-full font-bold shadow-md shadow-[#7367F0]/30 space-x-2 cursor-pointer"
              >
                {testSending ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('whatsapp.testSending')}</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>{t('whatsapp.sendTestMessage')}</span>
                  </>
                )}
              </Button>
            </form>
          </Card>
        </div>

        {/* Anti-Ban Safeguard Guidelines */}
        <div className="lg:col-span-6">
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

      {/* QR Pairing Modal */}
      {isQRModalOpen && typeof document !== 'undefined' && createPortal(
        <div 
          className="fixed inset-0 z-[99999] bg-slate-900/60 flex items-center justify-center p-4 animate-fade-in select-none"
          onClick={() => setIsQRModalOpen(false)}
        >
          <div 
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#2F3349] p-6 text-center space-y-4 shadow-2xl border border-slate-200/80 dark:border-white/[0.1] animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-1">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-lg bg-[#28C76F]/15 text-[#28C76F] flex items-center justify-center font-bold">
                  <Smartphone className="w-4 h-4" />
                </div>
                <h3 className="text-base font-extrabold text-slate-800 dark:text-white">{t('whatsapp.qrModalTitle')}</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsQRModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Mode Switcher Tabs */}
            <div className="flex rounded-xl bg-slate-100 dark:bg-[#25293C] p-1 text-xs font-semibold gap-1">
              <button
                type="button"
                onClick={() => setPairingMode('qr')}
                className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  pairingMode === 'qr'
                    ? 'bg-white dark:bg-[#2F3349] text-[#7367F0] shadow-sm font-bold'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                }`}
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>{t('whatsapp.tabQrCode')}</span>
              </button>
              <button
                type="button"
                onClick={() => setPairingMode('code')}
                className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  pairingMode === 'code'
                    ? 'bg-white dark:bg-[#2F3349] text-[#7367F0] shadow-sm font-bold'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>{t('whatsapp.tabPairingCode')}</span>
              </button>
            </div>

            {pairingMode === 'qr' ? (
              <>
                {/* 3-Step Instruction Box for QR */}
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-left text-xs space-y-1.5">
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">1</span>
                    <span>{t('whatsapp.qrModalStep1')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">2</span>
                    <span>{t('whatsapp.qrModalStep2')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
                    <span>{t('whatsapp.qrModalStep3')}</span>
                  </div>
                </div>

                {/* QR Code Presentation */}
                <div className="relative p-3.5 bg-white rounded-2xl mx-auto flex flex-col items-center justify-center shadow-lg border border-slate-200/90 w-full max-w-[280px]">
                  {/* Active / Expiration Status Badge */}
                  <div className="w-full flex items-center justify-between mb-2 px-1 text-[11px] font-semibold">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200/60">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      {t('whatsapp.qrLiveBadge')}
                    </span>
                    <span className={`tabular-nums ${qrSecondsLeft <= 5 ? 'text-rose-500 font-bold animate-pulse' : 'text-slate-400'}`}>
                      {qrSecondsLeft} {t('whatsapp.qrSecLeft')}
                    </span>
                  </div>

                  {(() => {
                    const pairingSession = sessions.find((s) => s.id === pairingSessionId);
                    const activeQr = pairingSession?.qr_code;
                    if (activeQr) {
                      const qrSrc = activeQr.startsWith('data:image') || activeQr.startsWith('http')
                        ? activeQr
                        : `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=4&data=${encodeURIComponent(activeQr)}`;
                      return (
                        <div className="relative w-56 h-56 flex items-center justify-center bg-white">
                          <img
                            src={qrSrc}
                            alt="WhatsApp QR Code"
                            className="w-full h-full object-contain select-none rounded-none"
                            style={{ imageRendering: 'pixelated' }}
                          />
                          {/* Expired Overlay if qrSecondsLeft === 0 */}
                          {qrSecondsLeft === 0 && (
                            <div 
                              onClick={() => handleRefreshQr()}
                              className="absolute inset-0 bg-slate-900/80 backdrop-blur-[2px] rounded-lg flex flex-col items-center justify-center p-3 text-white text-center cursor-pointer transition-all hover:bg-slate-900/85 group"
                            >
                              <RefreshCw className="w-8 h-8 mb-2 text-emerald-400 group-hover:rotate-180 transition-transform duration-500" />
                              <span className="text-xs font-bold">{t('whatsapp.qrExpired')}</span>
                              <span className="text-[10px] text-slate-300 mt-1">{t('whatsapp.qrExpiredDesc')}</span>
                            </div>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div className="w-56 h-56 flex flex-col items-center justify-center text-slate-400 gap-3">
                        <Loader2 className="w-8 h-8 animate-spin text-[#7367F0]" />
                        <span className="text-xs font-medium text-slate-500 text-center px-2">
                          {t('whatsapp.qrPreparing')}
                        </span>
                      </div>
                    );
                  })()}

                  {/* Manual Refresh Button */}
                  <button
                    type="button"
                    onClick={() => handleRefreshQr()}
                    disabled={isRefreshingQr}
                    className="mt-2.5 w-full py-1.5 px-3 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-700 bg-slate-100 hover:bg-slate-200 flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingQr ? 'animate-spin text-[#7367F0]' : ''}`} />
                    <span>{isRefreshingQr ? t('whatsapp.refreshingQr') : t('whatsapp.refreshQr')}</span>
                  </button>
                </div>
              </>
            ) : (
              /* Pairing Code Mode */
              <div className="space-y-3 text-left">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.05] text-xs space-y-1.5">
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">1</span>
                    <span>{t('whatsapp.pairingCodeStep1')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">2</span>
                    <span>{t('whatsapp.pairingCodeStep2')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200 font-semibold">
                    <span className="w-4 h-4 rounded-full bg-[#7367F0]/15 text-[#7367F0] text-[10px] flex items-center justify-center font-bold shrink-0">3</span>
                    <span>{t('whatsapp.pairingCodeStep3')}</span>
                  </div>
                </div>

                {!pairingCode ? (
                  <div className="space-y-2.5">
                    <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                      {t('whatsapp.pairingCodeInputLabel')}
                    </label>
                    <input
                      type="tel"
                      value={pairingPhone}
                      onChange={(e) => setPairingPhone(e.target.value)}
                      placeholder={t('whatsapp.pairingCodeInputPlaceholder')}
                      className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-[#25293C] border border-slate-200 dark:border-white/[0.1] text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#7367F0]/40 font-medium"
                    />
                    <Button
                      onClick={handleRequestPairingCode}
                      disabled={isRequestingCode || !pairingPhone.trim()}
                      className="w-full font-bold cursor-pointer"
                    >
                      {isRequestingCode ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          {t('whatsapp.gettingPairingCode')}
                        </>
                      ) : (
                        t('whatsapp.getPairingCodeBtn')
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="p-4 rounded-2xl bg-[#7367F0]/10 border border-[#7367F0]/30 text-center space-y-2.5 animate-scale-in">
                    <span className="text-xs font-bold text-[#7367F0] uppercase tracking-wider block">
                      {t('whatsapp.pairingCodeStep4')}
                    </span>
                    <div className="flex items-center justify-center gap-2">
                      <span className="font-mono text-2xl font-black text-slate-900 dark:text-white tracking-widest bg-white dark:bg-[#2F3349] px-4 py-2.5 rounded-xl shadow-inner border border-slate-200 dark:border-white/[0.1]">
                        {pairingCode}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyPairingCode}
                        className="p-3 rounded-xl bg-white dark:bg-[#2F3349] text-slate-600 dark:text-slate-300 hover:text-[#7367F0] shadow-sm border border-slate-200 dark:border-white/[0.1] transition-colors cursor-pointer"
                        title={t('common.copy')}
                      >
                        {isCopiedCode ? <Check className="w-5 h-5 text-[#28C76F]" /> : <Copy className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isPairingSuccess ? (
              <div className="p-3 rounded-xl bg-[#28C76F]/15 border border-[#28C76F]/30 text-[#28C76F] text-xs font-bold flex items-center justify-center gap-2 animate-fade-in">
                <CheckCircle2 className="w-4 h-4" />
                <span>{t('whatsapp.qrPairSuccess')}</span>
              </div>
            ) : (
              <Button
                onClick={handleSimulateScan}
                size="lg"
                className="w-full font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
              >
                {t('whatsapp.simulateScan')}
              </Button>
            )}
          </div>
        </div>,
        document.body
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
    </div>
  );
};

