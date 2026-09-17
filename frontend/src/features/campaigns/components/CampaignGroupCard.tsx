import React from 'react';
import { 
  Play, 
  Eye, 
  Users, 
  Calendar, 
  Trash2,
  Edit2,
  MapPin,
  Tag,
  Check
} from 'lucide-react';
import { CampaignGroup } from '../../../types';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/Progress';
import { Button } from '../../../components/ui/button';
import { IconButton } from '../../../components/ui/IconButton';
import { cn } from '../../../lib/utils';
import { useI18n } from '../../../context/I18nContext';

export interface CampaignGroupCardProps {
  group: CampaignGroup;
  isSelected?: boolean;
  onToggleSelect?: (groupId: number) => void;
  onLaunch?: (group: CampaignGroup) => void;
  onView?: (groupId: number) => void;
  onEdit?: (group: CampaignGroup) => void;
  onDelete?: (group: CampaignGroup) => void;
  className?: string;
}

export const CampaignGroupCard: React.FC<CampaignGroupCardProps> = ({
  group,
  isSelected,
  onToggleSelect,
  onLaunch,
  onView,
  onEdit,
  onDelete,
  className,
}) => {
  const { t } = useI18n();

  const totalCount = group.total_leads_count ?? 0;
  const waCount = group.whatsapp_eligible_count ?? 0;
  const nonWaCount = Math.max(0, totalCount - waCount);
  const waPercent = totalCount > 0 ? Math.round((waCount / totalCount) * 100) : 0;

  return (
    <Card
      className={cn(
        'p-5 space-y-4 hover:shadow-md transition-all flex flex-col justify-between relative',
        isSelected ? 'border-[#7367F0] ring-2 ring-[#7367F0]/20 bg-[#7367F0]/[0.02]' : '',
        className
      )}
    >
      <div>
        {/* Title & Badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start space-x-3 min-w-0">
            {onToggleSelect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(group.id);
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
                {group.name}
              </h4>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {group.target_category && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-[#7E7F96]">
                    <Tag className="w-3 h-3 text-[#7367F0]" />
                    <span className="truncate">{group.target_category}</span>
                  </span>
                )}
                {group.target_location && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                    <MapPin className="w-3 h-3 text-slate-400" />
                    <span className="truncate">{group.target_location}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <Badge variant="primary" className="text-[10px] uppercase font-mono shrink-0">
            {totalCount} {t('campaignGroups.businesses')}
          </Badge>
        </div>

        {/* WhatsApp Readiness Bar */}
        <div className="mt-4 space-y-1.5">
          <div className="flex justify-between text-xs font-bold text-slate-700 dark:text-slate-200">
            <span>{t('campaignGroups.whatsappEligible')}</span>
            <span className="font-mono text-[#28C76F]">
              {waCount} / {totalCount} (%{waPercent})
            </span>
          </div>
          <Progress value={waPercent} variant="success" size="md" />
        </div>

        {/* 3 Metrics Mini Grid (Exact layout as CampaignCard) */}
        <div className="mt-3.5 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400 truncate">{t('campaignGroups.totalLeads')}</div>
            <div className="font-mono font-bold text-[#7367F0] mt-0.5">{totalCount}</div>
          </div>
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400 truncate">{t('campaignGroups.whatsappEligible')}</div>
            <div className="font-mono font-bold text-[#28C76F] mt-0.5">{waCount}</div>
          </div>
          <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.05]">
            <div className="text-[10px] text-slate-400 truncate">{t('campaignGroups.noPhoneOrLandline')}</div>
            <div className="font-mono font-bold text-[#FF9F43] mt-0.5">{nonWaCount}</div>
          </div>
        </div>
      </div>

      {/* Action Footer Controls */}
      <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
        <div className="flex items-center space-x-1.5 text-[11px] text-slate-400 shrink-0">
          <Calendar className="w-3.5 h-3.5" />
          <span>{new Date(group.created_at).toLocaleDateString()}</span>
        </div>

        <div className="flex items-center space-x-1.5 shrink-0 flex-wrap sm:flex-nowrap justify-end gap-y-1">
          {onDelete && (
            <IconButton
              icon={Trash2}
              size="sm"
              variant="ghost"
              data-testid={`delete-group-btn-${group.id}`}
              tooltip={t('campaignGroups.deleteGroup')}
              onClick={() => onDelete(group)}
              className="text-slate-400 hover:text-[#EA5455] hover:bg-[#EA5455]/10"
            />
          )}

          {onEdit && (
            <IconButton
              icon={Edit2}
              size="sm"
              variant="ghost"
              data-testid={`edit-group-btn-${group.id}`}
              tooltip={t('campaignGroups.editGroup')}
              onClick={() => onEdit(group)}
              className="text-slate-400 hover:text-[#7367F0] hover:bg-[#7367F0]/10"
            />
          )}

          {onView && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onView(group.id)}
              className="h-8 text-xs font-bold space-x-1 cursor-pointer border-slate-200 dark:border-white/10 px-2.5 shrink-0"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{t('campaignGroups.viewGroupBtn')}</span>
            </Button>
          )}

          {onLaunch && (
            <Button
              size="sm"
              onClick={() => onLaunch(group)}
              className="bg-[#7367F0] hover:bg-[#685dd8] text-white font-bold space-x-1 cursor-pointer h-8 text-xs shadow-sm shadow-[#7367F0]/25 px-2.5 shrink-0"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>{t('campaignGroups.startCampaignBtn')}</span>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};
