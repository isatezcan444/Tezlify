import React, { useState, useEffect } from 'react';
import { 
  Webhook, 
  Plus, 
  Trash2, 
  Send, 
  CheckCircle2, 
  XCircle, 
  History, 
  Loader2,
  ExternalLink,
  ShieldCheck
} from 'lucide-react';
import { Card, Badge, Button, Modal } from '../../../components/ui';
import { FormSection } from '../../../components/forms';
import { ApiClient } from '../../../api/client';
import { WebhookItem, WebhookDeliveryLogItem } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { useI18n } from '../../../context/I18nContext';

export const WebhooksSection: React.FC = () => {
  const toast = useToast();
  const { t, language } = useI18n();
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['lead.created', 'whatsapp.message_received']);
  const [creating, setCreating] = useState(false);

  // Test state
  const [testingId, setTestingId] = useState<number | null>(null);

  // Logs modal
  const [logsSub, setLogsSub] = useState<WebhookItem | null>(null);
  const [logs, setLogs] = useState<WebhookDeliveryLogItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const availableEvents = [
    { 
      id: 'lead.created', 
      label: t('integrations.eventLeadCreated'), 
      desc: t('integrations.eventLeadCreatedDesc') 
    },
    { 
      id: 'lead.status_updated', 
      label: t('integrations.eventLeadStatusUpdated'), 
      desc: t('integrations.eventLeadStatusUpdatedDesc') 
    },
    { 
      id: 'whatsapp.message_received', 
      label: t('integrations.eventWaReceived'), 
      desc: t('integrations.eventWaReceivedDesc') 
    },
    { 
      id: 'campaign.completed', 
      label: t('integrations.eventCampaignCompleted'), 
      desc: t('integrations.eventCampaignCompletedDesc') 
    },
  ];

  const fetchWebhooks = async () => {
    try {
      setLoading(true);
      const data = await ApiClient.getWebhooks();
      setWebhooks(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('integrations.loading');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWebhooks();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !targetUrl.trim()) {
      toast.error(t('integrations.fillRequiredFields'));
      return;
    }
    if (selectedEvents.length === 0) {
      toast.error(t('integrations.selectAtLeastOneEvent'));
      return;
    }
    try {
      setCreating(true);
      await ApiClient.createWebhook({
        name: name.trim(),
        target_url: targetUrl.trim(),
        events: selectedEvents,
      });
      setIsCreateOpen(false);
      setName('');
      setTargetUrl('');
      setSelectedEvents(['lead.created', 'whatsapp.message_received']);
      fetchWebhooks();
      toast.success(t('integrations.webhookCreatedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleTest = async (sub: WebhookItem) => {
    try {
      setTestingId(sub.id);
      const res = await ApiClient.testWebhook(sub.id);
      if (res.success) {
        toast.success(t('integrations.testSuccessToast', {
          status: String(res.status_code || 200),
          duration: String(res.duration_ms || 0),
        }));
      } else {
        toast.error(t('integrations.testErrorToast', {
          error: res.error || `HTTP ${res.status_code}`,
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('integrations.testFailedToast');
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  };

  const openLogs = async (sub: WebhookItem) => {
    setLogsSub(sub);
    try {
      setLoadingLogs(true);
      const data = await ApiClient.getWebhookLogs(sub.id);
      setLogs(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleDelete = async (sub: WebhookItem) => {
    const confirmed = await toast.confirm({
      title: t('integrations.deleteWebhookConfirmTitle'),
      message: t('integrations.deleteWebhookConfirmMsg', { name: sub.name }),
      confirmText: t('integrations.delete'),
      cancelText: t('integrations.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await ApiClient.deleteWebhook(sub.id);
      setWebhooks((prev) => prev.filter((w) => w.id !== sub.id));
      toast.success(t('integrations.webhookDeletedSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('toast.errorTitle');
      toast.error(msg);
    }
  };

  const toggleEventSelection = (eventId: string) => {
    setSelectedEvents((prev) => 
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  const locale = language === 'tr' ? 'tr-TR' : 'en-US';

  return (
    <Card className="p-5 sm:p-6 space-y-4">
      <FormSection
        title={t('integrations.webhooksTitle')}
        subtitle={t('integrations.webhooksSubtitle')}
        icon={Webhook}
        action={
          <Button
            onClick={() => setIsCreateOpen(true)}
            size="sm"
            className="space-x-1.5 font-semibold text-xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('integrations.createNewWebhook')}</span>
          </Button>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center p-8 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2 text-[#7367F0]" />
            <span className="text-xs">{t('integrations.loading')}</span>
          </div>
        ) : webhooks.length === 0 ? (
          <div className="text-center py-8 p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-dashed border-slate-200 dark:border-white/10 space-y-2">
            <Webhook className="w-8 h-8 text-slate-400 mx-auto opacity-40" />
            <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
              {t('integrations.emptyWebhooksTitle')}
            </p>
            <p className="text-[11px] text-slate-400 max-w-md mx-auto leading-relaxed">
              {t('integrations.emptyWebhooksDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-white/[0.04]">
            {webhooks.map((sub) => (
              <div key={sub.id} className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="space-y-1.5 max-w-xl">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs text-slate-800 dark:text-slate-200">{sub.name}</span>
                    {sub.is_active ? (
                      <Badge variant="success">{t('integrations.active')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('integrations.disabled')}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-mono text-[#7367F0] truncate">
                    <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{sub.target_url}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {sub.events.map((evt) => (
                      <span 
                        key={evt} 
                        className="px-2 py-0.5 text-[10px] font-medium font-mono rounded bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 border border-slate-200/50 dark:border-white/5"
                      >
                        {evt}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testingId === sub.id}
                    onClick={() => handleTest(sub)}
                    className="text-xs space-x-1 h-8"
                  >
                    {testingId === sub.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#7367F0]" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>{t('integrations.testWebhookBtn')}</span>
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openLogs(sub)}
                    className="text-xs space-x-1 h-8"
                  >
                    <History className="w-3.5 h-3.5 text-slate-400" />
                    <span>{t('integrations.logsBtn')}</span>
                  </Button>

                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(sub)}
                    className="p-1.5 px-2.5 h-8"
                    title={t('integrations.delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </FormSection>

      {/* Create Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title={t('integrations.createWebhookModalTitle')}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {t('integrations.createWebhookModalDesc')}
          </p>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('integrations.webhookNameLabel')} <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('integrations.webhookNamePlaceholder')}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('integrations.webhookTargetUrlLabel')} <span className="text-rose-500">*</span>
            </label>
            <input
              type="url"
              required
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder={t('integrations.webhookTargetUrlPlaceholder')}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-[#1E2235] text-slate-800 dark:text-slate-200 focus:outline-none focus:border-[#7367F0]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
              {t('integrations.subscribedEventsLabel')} <span className="text-rose-500">*</span>
            </label>
            <div className="space-y-2">
              {availableEvents.map((evt) => {
                const checked = selectedEvents.includes(evt.id);
                return (
                  <div
                    key={evt.id}
                    onClick={() => toggleEventSelection(evt.id)}
                    className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-start gap-2.5 ${
                      checked 
                        ? 'border-[#7367F0] bg-[#7367F0]/5 dark:bg-[#7367F0]/10' 
                        : 'border-slate-200 dark:border-white/5 hover:border-slate-300 dark:hover:border-white/10'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {}}
                      className="mt-0.5 rounded text-[#7367F0] focus:ring-[#7367F0]"
                    />
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-200">{evt.label}</p>
                      <p className="text-[11px] text-slate-400 font-mono">{evt.id}</p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{evt.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-white/[0.05]">
            <Button variant="outline" size="sm" type="button" onClick={() => setIsCreateOpen(false)}>
              {t('integrations.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={creating} className="space-x-1.5 font-bold">
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              <span>{t('integrations.saveWebhookBtn')}</span>
            </Button>
          </div>
        </form>
      </Modal>

      {/* Logs Modal */}
      <Modal
        isOpen={!!logsSub}
        onClose={() => setLogsSub(null)}
        title={t('integrations.logsModalTitle', { name: logsSub?.name || '' })}
      >
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {loadingLogs ? (
            <div className="flex items-center justify-center py-8 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2 text-[#7367F0]" />
              <span className="text-xs">{t('integrations.logsLoading')}</span>
            </div>
          ) : logs.length === 0 ? (
            <p className="text-xs text-center py-6 text-slate-400">
              {t('integrations.emptyLogs')}
            </p>
          ) : (
            logs.map((l) => (
              <div 
                key={l.id} 
                className="p-3 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-50/50 dark:bg-[#1E2235]/50 space-y-1.5 text-xs"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {l.is_success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500" />
                    )}
                    <span className="font-bold text-slate-700 dark:text-slate-200">{l.event_type}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    l.is_success ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                  }`}>
                    {l.status_code ? `HTTP ${l.status_code}` : t('integrations.connError')}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>{new Date(l.created_at).toLocaleString(locale)}</span>
                  {l.duration_ms !== undefined && l.duration_ms !== null && <span>{l.duration_ms} ms</span>}
                </div>
                {l.error_message && (
                  <p className="text-[11px] text-rose-500 font-mono bg-rose-500/5 p-1.5 rounded">{l.error_message}</p>
                )}
                {l.response_body && (
                  <pre className="text-[10px] font-mono text-slate-500 dark:text-slate-400 bg-black/10 p-1.5 rounded truncate">
                    {t('integrations.responseLabel')}: {l.response_body}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </Modal>
    </Card>
  );
};
