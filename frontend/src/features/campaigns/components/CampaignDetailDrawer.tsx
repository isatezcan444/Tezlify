import React, { useState, useEffect } from 'react';
import { 
  Send, 
  BarChart3, 
  MessageSquare, 
  Users, 
  ShieldCheck, 
  Clock, 
  Play, 
  Pause, 
  XOctagon, 
  Trash2, 
  Copy, 
  Check, 
  Sparkles,
  Calendar,
  CalendarX,
  AlertTriangle,
  ExternalLink,
  Layers,
  GitFork,
  RotateCw,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { Campaign, CampaignGroup, SequenceLeadItem } from '../../../types';
import { Drawer } from '../../../components/ui/Drawer';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Progress } from '../../../components/ui/Progress';
import { IconButton } from '../../../components/ui/IconButton';
import { SpintaxPreviewCard, countSpintaxVariations } from './SpintaxPreviewCard';
import { ApiClient } from '../../../api/client';
import { useI18n } from '../../../context/I18nContext';
import { useToast } from '../../../context/ToastContext';
import { cn } from '../../../lib/utils';

export interface CampaignDetailDrawerProps {
  campaign: Campaign | null;
  isOpen: boolean;
  onClose: () => void;
  onStart?: (campaignId: number) => void;
  onPause?: (campaignId: number) => void;
  onCancel?: (campaignId: number) => void;
  onDelete?: (campaignId: number) => void;
  onUnschedule?: (campaignId: number) => void;
  onNavigateToGroup?: (groupId: number) => void;
}

export const CampaignDetailDrawer: React.FC<CampaignDetailDrawerProps> = ({
  campaign,
  isOpen,
  onClose,
  onStart,
  onPause,
  onCancel,
  onDelete,
  onUnschedule,
  onNavigateToGroup,
}) => {
  const { t, language } = useI18n();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'overview' | 'message' | 'sequence'>('overview');
  const [targetGroup, setTargetGroup] = useState<CampaignGroup | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState(false);
  const [sequenceLeads, setSequenceLeads] = useState<SequenceLeadItem[]>([]);
  const [loadingSequenceLeads, setLoadingSequenceLeads] = useState(false);
  const [stoppingLeadId, setStoppingLeadId] = useState<number | null>(null);

  const fetchSequenceLeads = React.useCallback(async () => {
    if (!campaign?.id) return;
    setLoadingSequenceLeads(true);
    try {
      const data = await ApiClient.getCampaignSequenceLeads(campaign.id);
      setSequenceLeads(data);
    } catch (err: any) {
      console.error('Failed to fetch sequence leads:', err);
    } finally {
      setLoadingSequenceLeads(false);
    }
  }, [campaign?.id]);

  useEffect(() => {
    if (isOpen && activeTab === 'sequence' && campaign?.id) {
      fetchSequenceLeads();
    }
  }, [isOpen, activeTab, campaign?.id, fetchSequenceLeads]);

  const handleStopSequenceLead = async (seqLeadId: number) => {
    if (!campaign?.id) return;
    const confirmed = await toast.confirm({
      title: t('common.warning') || 'Uyarı',
      message: t('campaigns.sequenceStopConfirm') || 'Bu işletme için kalan takip adımlarını durdurmak istediğinizden emin misiniz?',
      variant: 'warning',
    });
    if (!confirmed) return;

    setStoppingLeadId(seqLeadId);
    try {
      await ApiClient.stopCampaignSequenceLead(campaign.id, seqLeadId);
      toast.success(t('campaigns.sequenceStopSuccess') || 'İşletme için sekans takibi durduruldu.');
      fetchSequenceLeads();
    } catch (err: any) {
      toast.error(err.message || t('common.error'));
    } finally {
      setStoppingLeadId(null);
    }
  };

  // Sync tab on open
  useEffect(() => {
    if (isOpen) {
      setActiveTab('overview');
    }
  }, [isOpen]);

  // Fetch target group details if group_id is present
  useEffect(() => {
    if (isOpen && campaign?.group_id) {
      setLoadingGroup(true);
      ApiClient.getCampaignGroup(campaign.group_id)
        .then((group) => setTargetGroup(group))
        .catch(() => setTargetGroup(null))
        .finally(() => setLoadingGroup(false));
    } else {
      setTargetGroup(null);
    }
  }, [isOpen, campaign?.group_id]);

  if (!campaign) return null;

  const isRunning = campaign.status === 'ACTIVE';
  const isPaused = campaign.status === 'PAUSED';
  const isDraft = campaign.status === 'DRAFT';
  const isScheduled = campaign.status === 'SCHEDULED';
  const isCompleted = campaign.status === 'COMPLETED';

  const progressPercent = campaign.total_leads_target > 0
    ? Math.round((campaign.sent_count / campaign.total_leads_target) * 100)
    : 0;

  const responseRate = campaign.sent_count > 0
    ? ((campaign.replied_count / campaign.sent_count) * 100).toFixed(1)
    : '0.0';

  const statusVariants: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'default'> = {
    ACTIVE: 'success',
    RUNNING: 'success',
    PAUSED: 'warning',
    SCHEDULED: 'warning',
    DRAFT: 'default',
    COMPLETED: 'primary',
    CANCELLED: 'danger',
  };

  const handleCopyTemplate = () => {
    if (!campaign.message_template) return;
    navigator.clipboard.writeText(campaign.message_template);
    setCopiedTemplate(true);
    toast.success(t('campaigns.wizardCopiedSuccess'));
    setTimeout(() => setCopiedTemplate(false), 2000);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  const variationsCount = countSpintaxVariations(campaign.message_template);

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={campaign.name}
      subtitle={campaign.description || t('campaigns.campaignDetails')}
      icon={Send}
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full gap-2">
          {onDelete && (
            <IconButton
              icon={Trash2}
              size="sm"
              variant="ghost"
              data-testid={`drawer-delete-campaign-${campaign.id}`}
              tooltip={t('campaigns.deleteCampaign')}
              onClick={() => {
                onDelete(campaign.id);
                onClose();
              }}
              className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10 shrink-0"
            />
          )}

          <div className="flex items-center space-x-2 shrink-0 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="font-bold border-slate-300 dark:border-white/10 cursor-pointer"
            >
              {t('common.close') || 'Kapat'}
            </Button>

            {isScheduled && onUnschedule && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onUnschedule(campaign.id);
                  onClose();
                }}
                className="text-amber-600 dark:text-amber-400 border-amber-500/40 hover:bg-amber-500/10 font-bold space-x-1.5 cursor-pointer h-9 px-4"
              >
                <CalendarX className="w-3.5 h-3.5" />
                <span>{t('campaigns.cancelSchedule')}</span>
              </Button>
            )}

            {isScheduled && onStart && (
              <Button
                size="sm"
                onClick={() => {
                  onStart(campaign.id);
                  onClose();
                }}
                className="bg-[#28C76F] hover:bg-[#20A159] text-white font-bold space-x-1 cursor-pointer h-9 px-4 shadow-sm"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{t('campaigns.startImmediately')}</span>
              </Button>
            )}

            {(isDraft || isPaused) && onStart && (
              <Button
                size="sm"
                onClick={() => onStart(campaign.id)}
                className="bg-[#28C76F] hover:bg-[#20A159] text-white font-bold space-x-1 cursor-pointer h-9 px-4 shadow-sm"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{isPaused ? t('campaigns.resumeCampaign') : t('campaigns.startCampaign')}</span>
              </Button>
            )}

            {isRunning && onPause && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPause(campaign.id)}
                className="text-[#FF9F43] border-[#FF9F43]/40 hover:bg-[#FF9F43]/10 font-bold space-x-1 cursor-pointer h-9 px-4"
              >
                <Pause className="w-3.5 h-3.5" />
                <span>{t('campaigns.pauseCampaign')}</span>
              </Button>
            )}

            {isRunning && onCancel && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCancel(campaign.id)}
                className="text-[#EA5455] border-[#EA5455]/40 hover:bg-[#EA5455]/10 font-bold space-x-1 cursor-pointer h-9 px-4"
              >
                <XOctagon className="w-3.5 h-3.5" />
                <span>{t('campaigns.cancelCampaign')}</span>
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col h-full space-y-5">
        {/* Subheader Segmented Tabs */}
        <div className={cn("grid p-1 rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200/60 dark:border-white/[0.05]", campaign.sequence_enabled ? "grid-cols-3" : "grid-cols-2")}>
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={cn(
              'py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-2 cursor-pointer',
              activeTab === 'overview'
                ? 'bg-white dark:bg-[#7367F0] text-slate-800 dark:text-white shadow-xs'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
            )}
          >
            <BarChart3 className="w-4 h-4" />
            <span>{t('campaigns.overviewTab')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('message')}
            className={cn(
              'py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-2 cursor-pointer',
              activeTab === 'message'
                ? 'bg-white dark:bg-[#7367F0] text-slate-800 dark:text-white shadow-xs'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
            )}
          >
            <MessageSquare className="w-4 h-4" />
            <span>{t('campaigns.messageTab')}</span>
          </button>

          {campaign.sequence_enabled && (
            <button
              type="button"
              onClick={() => setActiveTab('sequence')}
              className={cn(
                'py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center space-x-2 cursor-pointer',
                activeTab === 'sequence'
                  ? 'bg-white dark:bg-emerald-600 text-slate-800 dark:text-white shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
              )}
            >
              <GitFork className="w-4 h-4" />
              <span>{t('campaigns.sequenceTab')}</span>
              {campaign.sequence_steps && campaign.sequence_steps.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/10 dark:bg-white/20">
                  {campaign.sequence_steps.length}
                </span>
              )}
            </button>
          )}
        </div>

        {/* TAB 1: OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="space-y-5 animate-fade-in">
            {/* Status & Overall Progress Banner */}
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className={cn(
                    'w-2.5 h-2.5 rounded-full',
                    isRunning ? 'bg-[#28C76F] animate-pulse' : isPaused ? 'bg-[#FF9F43]' : 'bg-slate-400'
                  )} />
                  <span className="text-xs font-extrabold text-slate-800 dark:text-white">
                    {t('campaigns.progressSent')}
                  </span>
                </div>
                <Badge variant={statusVariants[campaign.status] || 'default'} className="font-mono text-[10px] uppercase font-bold">
                  {campaign.status}
                </Badge>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-bold text-slate-700 dark:text-slate-200">
                  <span>{campaign.sent_count} / {campaign.total_leads_target} {t('campaigns.progressSent').toLowerCase()}</span>
                  <span className="font-mono text-[#7367F0]">%{progressPercent}</span>
                </div>
                <Progress value={progressPercent} variant={isRunning ? 'primary' : 'success'} size="md" />
              </div>
            </div>

            {/* Metric Tiles 2x2 or 3x2 Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {/* Target */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.estimatedAudience') || 'Toplam Hedef'}
                </span>
                <span className="text-base font-extrabold text-[#7367F0] font-mono mt-1 block">
                  {campaign.total_leads_target}
                </span>
              </div>

              {/* Sent */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.progressSent')}
                </span>
                <span className="text-base font-extrabold text-[#00CFE8] font-mono mt-1 block">
                  {campaign.sent_count}
                </span>
              </div>

              {/* Delivered */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.deliveredCount')}
                </span>
                <span className="text-base font-extrabold text-[#28C76F] font-mono mt-1 block">
                  {campaign.delivered_count || campaign.sent_count}
                </span>
              </div>

              {/* Replied */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.progressReplied')}
                </span>
                <span className="text-base font-extrabold text-[#28C76F] font-mono mt-1 block">
                  {campaign.replied_count}
                </span>
              </div>

              {/* Response Rate */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.responseRate') || 'Yanıt Oranı'}
                </span>
                <span className="text-base font-extrabold text-emerald-500 font-mono mt-1 block">
                  %{responseRate}
                </span>
              </div>

              {/* Failed */}
              <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-center">
                <span className="text-[10px] font-bold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider block">
                  {t('campaigns.progressFailed')}
                </span>
                <span className="text-base font-extrabold text-[#EA5455] font-mono mt-1 block">
                  {campaign.failed_count}
                </span>
              </div>
            </div>

            {/* Target Group Information Card */}
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-7 h-7 rounded-lg bg-[#7367F0]/15 text-[#7367F0] flex items-center justify-center shrink-0">
                    <Users className="w-3.5 h-3.5" />
                  </div>
                  <h5 className="text-xs font-extrabold text-slate-800 dark:text-white">
                    {t('campaigns.targetAudience') || 'Hedef Kitle Grubu'}
                  </h5>
                </div>

                {targetGroup && onNavigateToGroup && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onNavigateToGroup(targetGroup.id);
                      onClose();
                    }}
                    className="text-[11px] font-bold text-[#7367F0] hover:bg-[#7367F0]/10 h-7 px-2"
                  >
                    <span>{t('campaignGroups.viewGroupDetail') || 'Gruba Git'}</span>
                    <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                )}
              </div>

              {targetGroup ? (
                <div className="pt-1 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{t('campaignGroups.groupName')}:</span>
                    <span className="font-extrabold text-slate-800 dark:text-white">{targetGroup.name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{t('campaignGroups.groupTotalLeads')}:</span>
                    <Badge variant="success" className="text-[10px] font-mono font-bold">
                      {t('campaigns.groupLeadsCount', {
                        count: targetGroup.total_leads_count,
                        waCount: targetGroup.whatsapp_eligible_count,
                      })}
                    </Badge>
                  </div>
                  {targetGroup.target_category && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">{t('campaigns.wizardSummaryCategory')}:</span>
                      <span className="font-medium text-slate-700 dark:text-slate-200">{targetGroup.target_category}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {campaign.group_id
                    ? (loadingGroup ? t('common.loading') : `${t('nav.campaignGroups')} #${campaign.group_id}`)
                    : (t('campaigns.wizardNoGroupSelected') || 'Bağımsız (Grup atanmamış)')}
                </p>
              )}
            </div>

            {/* WhatsApp Line & Pool Configuration */}
            <div className="p-4 rounded-xl bg-[#7367F0]/[0.08] dark:bg-[#7367F0]/15 border border-[#7367F0]/25 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[#7367F0] text-white flex items-center justify-center shrink-0 shadow-xs">
                    <Layers className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h5 className="text-xs font-extrabold text-slate-800 dark:text-white">
                      {t('campaigns.poolDetailsTitle')}
                    </h5>
                    <p className="text-[10px] text-slate-500 dark:text-[#7E7F96]">
                      {campaign.whatsapp_session_ids && campaign.whatsapp_session_ids.length > 1
                        ? t('campaigns.poolDistributionInfo')
                        : t('campaigns.poolDistributionStatus')}
                    </p>
                  </div>
                </div>

                {campaign.whatsapp_session_ids && campaign.whatsapp_session_ids.length > 1 ? (
                  <Badge variant="primary" className="text-[10px] font-mono font-bold">
                    {t('campaigns.poolLinesCount', { count: campaign.whatsapp_session_ids.length })}
                  </Badge>
                ) : (
                  <Badge variant="default" className="text-[10px] font-mono">
                    {campaign.whatsapp_session_id ? `Hat #${campaign.whatsapp_session_id}` : 'Varsayılan Hat'}
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-xs">
                <div className="p-2 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#7367F0]/20 flex items-center space-x-2">
                  <Sparkles className="w-3 h-3 text-[#7367F0] shrink-0" />
                  <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    {t('campaigns.poolDistributionStatus')}
                  </span>
                </div>
                <div className="p-2 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#7367F0]/20 flex items-center space-x-2">
                  <ShieldCheck className="w-3 h-3 text-[#28C76F] shrink-0" />
                  <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    {t('campaigns.poolFailoverProtection')}
                  </span>
                </div>
              </div>
            </div>

            {/* Safety & Anti-Ban Runtime Settings */}
            <div className="p-4 rounded-xl bg-[#28C76F]/[0.08] dark:bg-[#28C76F]/15 border border-[#28C76F]/25 space-y-3">
              <div className="flex items-center space-x-2.5">
                <div className="w-7 h-7 rounded-lg bg-[#28C76F] text-white flex items-center justify-center shrink-0 shadow-xs">
                  <ShieldCheck className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h5 className="text-xs font-extrabold text-slate-800 dark:text-white">
                    {t('campaigns.wizardAntibanTitle') || 'Anti-Ban & Mesai Saatleri Koruması'}
                  </h5>
                  <p className="text-[10px] text-slate-500 dark:text-[#7E7F96]">
                    Fail-closed operasyonel koruma aktif
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-xs">
                <div className="p-2 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 flex items-center space-x-2">
                  <Clock className="w-3 h-3 text-[#28C76F] shrink-0" />
                  <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    Jitter: {campaign.min_delay_seconds}s - {campaign.max_delay_seconds}s
                  </span>
                </div>

                <div className="p-2 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 flex items-center space-x-2">
                  <Sparkles className="w-3 h-3 text-[#28C76F] shrink-0" />
                  <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    Yazıyor: {campaign.typing_delay_seconds}s
                  </span>
                </div>

                <div className="p-2 rounded-lg bg-white/80 dark:bg-[#2F3349] border border-[#28C76F]/20 flex items-center space-x-2">
                  <ShieldCheck className="w-3 h-3 text-[#28C76F] shrink-0" />
                  <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    {campaign.working_hours_enabled
                      ? `${campaign.working_hours_start} - ${campaign.working_hours_end}`
                      : (t('campaigns.wizardAntibanWorkingHoursDisabled') || '7/24 Aktif')}
                  </span>
                </div>
              </div>
            </div>

            {/* Campaign Timeline / Dates */}
            <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/60 dark:border-white/[0.06] text-[11px] text-slate-500 dark:text-slate-400 space-y-1.5">
              {campaign.scheduled_at && (
                <div className="flex items-center justify-between text-amber-600 dark:text-amber-400 font-semibold">
                  <span>{t('campaigns.scheduledAt') || 'Planlanan Başlangıç'}:</span>
                  <span className="font-mono">{formatDate(campaign.scheduled_at)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span>{t('campaigns.createdAt') || 'Oluşturulma Tarihi'}:</span>
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{formatDate(campaign.created_at)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t('campaigns.updatedAt') || 'Son Güncelleme'}:</span>
                <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{formatDate(campaign.updated_at)}</span>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: MESSAGE & SPINTAX SIMULATION */}
        {activeTab === 'message' && (
          <div className="space-y-5 animate-fade-in">
            {/* Raw Template Card with Quick Copy */}
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-extrabold text-slate-800 dark:text-white">
                    {t('campaigns.templateLabel') || 'Mesaj Şablonu'}
                  </span>
                  {variationsCount > 1 ? (
                    <Badge variant="success" className="text-[10px] font-bold px-2 py-0.5">
                      {t('campaigns.spintaxCountBadge', { count: variationsCount })}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] font-bold px-2 py-0.5">
                      {t('campaigns.spintaxSingleBadge')}
                    </Badge>
                  )}
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyTemplate}
                  className="h-7 text-xs font-bold space-x-1.5 cursor-pointer border-slate-300 dark:border-white/10"
                >
                  {copiedTemplate ? <Check className="w-3.5 h-3.5 text-[#28C76F]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedTemplate ? (t('common.copied') || 'Kopyalandı') : (t('campaigns.wizardCopyMessage') || 'Kopyala')}</span>
                </Button>
              </div>

              <div className="p-3.5 rounded-lg bg-white dark:bg-[#1F2C34] border border-slate-200/60 dark:border-white/[0.06] text-xs font-sans text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto select-text">
                {campaign.message_template || '-'}
              </div>
            </div>

            {/* Embedded Live WhatsApp Simulation Card */}
            <div>
              <SpintaxPreviewCard
                template={campaign.message_template}
                targetCategory={targetGroup?.target_category}
              />
            </div>
          </div>
        )}

        {/* TAB 3: SEQUENCE DRIP TRACKING */}
        {activeTab === 'sequence' && (
          <div className="space-y-5 animate-fade-in">
            {/* Sequence Steps Timeline Card */}
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold">
                    <GitFork className="w-4 h-4" />
                  </div>
                  <div>
                    <h5 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white leading-tight">
                      {t('campaigns.sequenceModeTitle')}
                    </h5>
                    <p className="text-[11px] text-slate-400">
                      {campaign.sequence_steps?.length || 1} {t('campaigns.sequenceSummaryStepsCount', { count: campaign.sequence_steps?.length || 1 })}
                      {campaign.auto_stop_on_reply && ` • ${t('campaigns.autoStopOnReplyTitle')}`}
                    </p>
                  </div>
                </div>

                <Badge variant="success" className="text-[10px] font-bold">
                  {campaign.sequence_enabled ? t('campaigns.sequenceStatusActive') : 'Pasif'}
                </Badge>
              </div>

              {/* Steps timeline list */}
              <div className="space-y-2.5 pt-1">
                {campaign.sequence_steps?.map((step: any, idx: number) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-slate-200/60 dark:border-white/[0.05] bg-white dark:bg-[#2F3349]/50 flex items-start space-x-3 text-xs"
                  >
                    <span className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                      {step.step_number || idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-extrabold text-slate-800 dark:text-white">
                          {idx === 0
                            ? t('campaigns.sequenceStepRecap1')
                            : t('campaigns.sequenceStepTitle', { step: step.step_number || idx + 1 })}
                        </span>
                        {idx > 0 && (
                          <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                            +{step.delay_days} Gün {step.delay_hours ? `${step.delay_hours}s ` : ''}sonra
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 font-sans whitespace-pre-wrap">
                        {step.message_template || '-'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Live Sequence Leads Table */}
            <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-[#25293C] border border-slate-200/70 dark:border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h5 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-white">
                    {t('campaigns.sequenceLeadsTitle')}
                  </h5>
                  <p className="text-[11px] text-slate-400">
                    {t('campaigns.sequenceLeadsSubtitle')}
                  </p>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={fetchSequenceLeads}
                  disabled={loadingSequenceLeads}
                  className="h-7 text-xs font-bold space-x-1.5 cursor-pointer border-slate-300 dark:border-white/10"
                >
                  <RotateCw className={cn("w-3.5 h-3.5", loadingSequenceLeads && "animate-spin")} />
                  <span>{t('common.refresh') || 'Yenile'}</span>
                </Button>
              </div>

              {loadingSequenceLeads ? (
                <div className="flex items-center justify-center py-8 text-xs text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mr-2 text-[#7367F0]" />
                  <span>{t('common.loading')}</span>
                </div>
              ) : sequenceLeads.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400 rounded-lg bg-white/40 dark:bg-[#1F2C34]/40 border border-slate-200/40 dark:border-white/[0.04]">
                  {t('campaigns.sequenceEmptyLeads')}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200/60 dark:border-white/[0.06]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 dark:bg-white/[0.04] text-[10px] font-extrabold uppercase text-slate-400 border-b border-slate-200/60 dark:border-white/[0.06]">
                      <tr>
                        <th className="py-2.5 px-3">{t('campaigns.sequenceLeadHeaderName')}</th>
                        <th className="py-2.5 px-3">{t('campaigns.sequenceLeadHeaderStep')}</th>
                        <th className="py-2.5 px-3">{t('campaigns.sequenceLeadHeaderStatus')}</th>
                        <th className="py-2.5 px-3">{t('campaigns.sequenceLeadHeaderNextAt')}</th>
                        <th className="py-2.5 px-3 text-right">{t('campaigns.sequenceLeadHeaderActions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/40 dark:divide-white/[0.04]">
                      {sequenceLeads.map((sl) => {
                        const isStoppedReply = sl.status === 'STOPPED_ON_REPLY';
                        const isCompleted = sl.status === 'COMPLETED';
                        const isActive = sl.status === 'ACTIVE';
                        const isManual = sl.status === 'STOPPED_MANUAL';

                        return (
                          <tr key={sl.id} className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01] transition-colors">
                            <td className="py-2.5 px-3 min-w-0">
                              <p className="font-extrabold text-slate-800 dark:text-white truncate max-w-[120px]">
                                {sl.lead_name || `İşletme #${sl.lead_id}`}
                              </p>
                              <p className="font-mono text-[10px] text-slate-400">
                                {sl.lead_phone || '-'}
                              </p>
                            </td>

                            <td className="py-2.5 px-3 font-mono font-bold text-slate-700 dark:text-slate-200">
                              {sl.current_step} / {sl.total_steps}
                            </td>

                            <td className="py-2.5 px-3">
                              {isActive && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                  {t('campaigns.sequenceStatusActive')}
                                </span>
                              )}
                              {isStoppedReply && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                                  <CheckCircle2 className="w-3 h-3" />
                                  {t('campaigns.sequenceStatusStoppedReply')}
                                </span>
                              )}
                              {isCompleted && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                                  {t('campaigns.sequenceStatusCompleted')}
                                </span>
                              )}
                              {isManual && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 dark:text-slate-400 bg-slate-500/10 px-1.5 py-0.5 rounded border border-slate-500/20">
                                  {t('campaigns.sequenceStatusStoppedManual')}
                                </span>
                              )}
                            </td>

                            <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                              {sl.next_step_at
                                ? new Date(sl.next_step_at).toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', {
                                    day: 'numeric',
                                    month: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : sl.stopped_at
                                ? new Date(sl.stopped_at).toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', {
                                    day: 'numeric',
                                    month: 'short',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : '-'}
                            </td>

                            <td className="py-2.5 px-3 text-right">
                              {isActive && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={stoppingLeadId === sl.id}
                                  onClick={() => handleStopSequenceLead(sl.id)}
                                  className="h-6 px-2 text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20 cursor-pointer"
                                >
                                  {stoppingLeadId === sl.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <span>{t('campaigns.sequenceStopBtn')}</span>
                                  )}
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
};
