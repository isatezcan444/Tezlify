import { 
  Play, 
  Pause, 
  XOctagon, 
  Clock, 
  Users, 
  Send, 
  MessageSquareReply, 
  AlertCircle,
  Trash2,
  Check
} from 'lucide-react';
import { Campaign } from '../../../types';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/Progress';
import { Button } from '../../../components/ui/button';
import { IconButton } from '../../../components/ui/IconButton';
import { cn } from '../../../lib/utils';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignCardProps {
  campaign: Campaign;
  isSelected?: boolean;
  onToggleSelect?: (campaignId: number) => void;
  onStart?: (campaignId: number) => void;
  onPause?: (campaignId: number) => void;
  onCancel?: (campaignId: number) => void;
  onDelete?: (campaignId: number) => void;
  className?: string;
}

export const CampaignCard: React.FC<CampaignCardProps> = ({
  campaign,
  isSelected,
  onToggleSelect,
  onStart,
  onPause,
  onCancel,
  onDelete,
  className,
}) => {
  const { t } = useI18n();
  const progressPercent = campaign.total_leads_target > 0
    ? Math.round((campaign.sent_count / campaign.total_leads_target) * 100)
    : 0;

  const isRunning = campaign.status === 'ACTIVE';
  const isPaused = campaign.status === 'PAUSED';
  const isDraft = campaign.status === 'DRAFT';
  const isCompleted = campaign.status === 'COMPLETED';

  const statusVariants: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'default'> = {
    ACTIVE: 'success',
    RUNNING: 'success',
    PAUSED: 'warning',
    DRAFT: 'default',
    COMPLETED: 'primary',
    CANCELLED: 'danger',
  };

  return (
    <Card
      className={cn(
        'p-5 space-y-4 hover:shadow-md transition-all flex flex-col justify-between relative',
        isSelected ? 'border-[#7367F0] ring-2 ring-[#7367F0]/20 bg-[#7367F0]/[0.02]' : '',
        className
      )}
    >
      <div>
        {/* Title & Status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start space-x-3 min-w-0">
            {onToggleSelect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(campaign.id);
                }}
                className={cn(
                  "w-5 h-5 rounded-md border flex items-center justify-center transition-all cursor-pointer shrink-0 mt-0.5",
                  isSelected
                    ? "bg-[#7367F0] border-[#7367F0] text-white shadow-sm shadow-[#7367F0]/30 ring-2 ring-[#7367F0]/20"
                    : "border-slate-300 dark:border-white/20 hover:border-[#7367F0] bg-slate-50 dark:bg-white/[0.04]"
                )}
              >
                {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
              </button>
            )}
            <div className="min-w-0">
              <h4 className="font-extrabold text-sm text-slate-800 dark:text-white leading-tight truncate">
                {campaign.name}
              </h4>
              {campaign.description && (
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] mt-0.5 line-clamp-1">
                  {campaign.description}
                </p>
              )}
            </div>
          </div>

          <Badge variant={statusVariants[campaign.status] || 'default'} className="text-[10px] uppercase font-mono shrink-0">
            {campaign.status}
          </Badge>
        </div>

        {/* Progress Bar */}
        <div className="mt-4 space-y-1.5">
          <div className="flex justify-between text-xs font-bold text-slate-700 dark:text-slate-200">
            <span>{t('campaigns.progressSent')}</span>
            <span className="font-mono text-[#7367F0]">
              {campaign.sent_count} / {campaign.total_leads_target} (%{progressPercent})
            </span>
          </div>
          <Progress value={progressPercent} variant={isRunning ? 'primary' : 'success'} size="md" />
        </div>

        {/* 3 Metrics Mini Grid */}
        <div className="mt-3.5 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400">{t('campaigns.progressSent')}</div>
            <div className="font-mono font-bold text-[#7367F0] mt-0.5">{campaign.sent_count}</div>
          </div>
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400">{t('campaigns.progressReplied')}</div>
            <div className="font-mono font-bold text-[#28C76F] mt-0.5">{campaign.replied_count}</div>
          </div>
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400">{t('campaigns.progressFailed')}</div>
            <div className="font-mono font-bold text-[#EA5455] mt-0.5">{campaign.failed_count}</div>
          </div>
        </div>
      </div>

      {/* Action Footer Controls */}
      <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        <div className="flex items-center space-x-1.5 text-[11px] text-slate-400 shrink-0">
          <Clock className="w-3.5 h-3.5" />
          <span>{campaign.min_delay_seconds}-{campaign.max_delay_seconds}s jitter</span>
        </div>

        <div className="flex items-center space-x-1.5 shrink-0 flex-wrap sm:flex-nowrap justify-end">
          {onDelete && (
            <IconButton
              icon={Trash2}
              size="sm"
              variant="ghost"
              data-testid={`delete-campaign-btn-${campaign.id}`}
              tooltip={t('campaigns.deleteCampaign') || 'Kampanyayı Sil'}
              onClick={() => onDelete(campaign.id)}
              className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
            />
          )}

          {(isDraft || isPaused) && onStart && (
            <Button
              size="sm"
              onClick={() => onStart(campaign.id)}
              className="bg-[#28C76F] hover:bg-[#20A159] text-white font-bold space-x-1 cursor-pointer h-8 text-xs"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>{isPaused ? t('campaigns.resumeCampaign') : t('campaigns.startCampaign')}</span>
            </Button>
          )}

          {isRunning && onPause && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onPause(campaign.id)}
              className="text-[#FF9F43] border-[#FF9F43]/30 hover:bg-[#FF9F43]/10 font-bold space-x-1 cursor-pointer h-8 text-xs"
            >
              <Pause className="w-3 h-3" />
              <span>{t('campaigns.pauseCampaign')}</span>
            </Button>
          )}

          {isRunning && onCancel && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCancel(campaign.id)}
              className="text-[#EA5455] border-[#EA5455]/30 hover:bg-[#EA5455]/10 font-bold space-x-1 cursor-pointer h-8 text-xs"
            >
              <XOctagon className="w-3 h-3" />
              <span>{t('campaigns.cancelCampaign')}</span>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};
