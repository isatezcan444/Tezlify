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
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { Campaign, CampaignGroup } from '../../../types';
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
  onNavigateToGroup,
}) => {
  const { t, language } = useI18n();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'overview' | 'message'>('overview');
  const [targetGroup, setTargetGroup] = useState<CampaignGroup | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState(false);

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
        <div className="grid grid-cols-2 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200/60 dark:border-white/[0.05]">
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
      </div>
    </Drawer>
  );
};
