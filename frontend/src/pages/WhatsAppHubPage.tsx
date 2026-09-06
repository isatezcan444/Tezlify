import React, { useState, useEffect } from 'react';
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
  ExternalLink
} from 'lucide-react';
import { ApiClient } from '../api/client';
import { WhatsAppSession, MessageLog, Conversation, ConversationStatus, Lead } from '../types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/EmptyState';
import { Avatar } from '../components/ui/Avatar';
import { WhatsAppIcon } from '../components/ui/whatsapp-icon';
import { SessionCard, ConversationList, ChatThread, ChatComposer, LeadDetailDrawer, TemplateSelectModal } from '../components/domain';
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

      if (eventData.event === 'inbound_reply') {
        const convId = eventData.conversation_id;
        const isCurrentSelected = selectedConv && selectedConv.id === convId;

        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === convId);
          if (idx !== -1) {
            const existing = prev[idx];
            const updated: Conversation = {
              ...existing,
              status: 'ACTIVE',
              last_message_preview: eventData.message,
              last_message_at: eventData.timestamp || new Date().toISOString(),
              unread_count: isCurrentSelected ? 0 : (existing.unread_count || 0) + 1,
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

  // New Line / QR Pairing Modal
  const [isQRModalOpen, setIsQRModalOpen] = useState(false);
  const [newSessionName] = useState('Line 1');
  const [pairingSessionId, setPairingSessionId] = useState<number | null>(null);
  const [isPairingSuccess, setIsPairingSuccess] = useState(false);

  // Test Sandbox State
  const [testPhone, setTestPhone] = useState('0532 100 20 30');
  const [testMsg, setTestMsg] = useState('Tezlify WhatsApp Gateway test message.');
  const [selectedSessionForTest] = useState<number | undefined>(undefined);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchSessionsAndLogs = async () => {
    setLoading(true);
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
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessionsAndLogs();
    fetchConversations();

    // Listen to real-time inbound messages to update conversation previews
    const handleWs = (e: Event) => {
      const eventData = (e as CustomEvent<any>).detail;
      if (eventData?.event === 'inbound_reply') {
        fetchConversations();
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
    if (!newSessionName) return;
    try {
      const session = await ApiClient.createWhatsAppSession(newSessionName);
      setPairingSessionId(session.id);
      setIsQRModalOpen(true);
      setIsPairingSuccess(false);
      fetchSessionsAndLogs();
    } catch (err: any) {
      toast.error(err.message, t('common.error'));
    }
  };

  const handleSimulateScan = async () => {
    if (!pairingSessionId) return;
    try {
      await ApiClient.simulateConnectSession(pairingSessionId);
      setIsPairingSuccess(true);
      toast.success(t('whatsapp.qrPairSuccess'), t('common.success'));
      setTimeout(() => {
        setIsQRModalOpen(false);
        fetchSessionsAndLogs();
        onRefreshStats();
      }, 1500);
    } catch (err: any) {
      toast.error(err.message, t('common.error'));
    }
  };

  const handleDisconnect = async (sessionId: number) => {
    try {
      await ApiClient.disconnectSession(sessionId);
      toast.info(t('whatsapp.statusDisconnected'), t('common.info'));
      fetchSessionsAndLogs();
      onRefreshStats();
    } catch (err: any) {
      toast.error(err.message || t('common.error'), t('common.error'));
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
    try {
      await ApiClient.deleteSession(sessionId);
      toast.success(t('common.success'), t('whatsapp.deleteSession'));
      fetchSessionsAndLogs();
      onRefreshStats();
    } catch (err: any) {
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
                    <Avatar name={selectedConv.lead_name || selectedConv.lead_phone || 'Lead'} size="md" shape="rounded" />
                    <div>
                      <div className="flex items-center space-x-2">
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
                        toast.error(t('whatsapp.msgFailed') || 'Mesaj gönderilemedi', t('common.error'));
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
              size="sm"
              className="space-x-2 font-bold shadow-md shadow-[#7367F0]/30 cursor-pointer"
            >
              <QrCode className="w-4 h-4" />
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

            {/* 3-Step Instruction Box */}
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
            <div className="p-3.5 bg-white rounded-2xl mx-auto inline-block shadow-md border border-slate-200/80 relative">
              <svg viewBox="0 0 100 100" className="w-44 h-44">
                <rect width="100" height="100" fill="white" />
                <rect x="8" y="8" width="26" height="26" fill="#1E293B" rx="3" />
                <rect x="12" y="12" width="18" height="18" fill="white" rx="2" />
                <rect x="15" y="15" width="12" height="12" fill="#1E293B" rx="1.5" />

                <rect x="66" y="8" width="26" height="26" fill="#1E293B" rx="3" />
                <rect x="70" y="12" width="18" height="18" fill="white" rx="2" />
                <rect x="73" y="15" width="12" height="12" fill="#1E293B" rx="1.5" />

                <rect x="8" y="66" width="26" height="26" fill="#1E293B" rx="3" />
                <rect x="12" y="70" width="18" height="18" fill="white" rx="2" />
                <rect x="15" y="73" width="12" height="12" fill="#1E293B" rx="1.5" />

                <rect x="42" y="12" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="52" y="20" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="42" y="32" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="66" y="42" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="46" y="52" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="56" y="62" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="42" y="72" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="76" y="72" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="84" y="52" width="6" height="6" fill="#1E293B" rx="1" />
                <rect x="52" y="82" width="6" height="6" fill="#1E293B" rx="1" />
              </svg>
            </div>

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
    </div>
  );
};
