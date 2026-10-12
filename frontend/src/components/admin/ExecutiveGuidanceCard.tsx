import React, { useState } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  AlertTriangle, 
  Info, 
  ChevronDown, 
  ChevronUp, 
  ArrowRight, 
  Terminal,
  Activity,
  CheckCircle2,
  HelpCircle,
  LucideIcon
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { StatusBadge, StatusVariant } from '../ui/StatusBadge';
import { useI18n } from '../../context/I18nContext';

export type GuidanceStatus = 'ok' | 'warn' | 'critical' | 'unknown' | 'info';
export type SeverityLevel = 'normal' | 'low' | 'medium' | 'high' | 'critical';

export interface ExecutiveGuidanceCardProps {
  status: GuidanceStatus;
  badgeLabel?: string;
  title: string;
  subtitle: string;
  /** Soru 1: Şu anda sistemin durumu ne? */
  currentState: string;
  /** Soru 2: Bir sorun varsa ne kadar önemli? */
  severity: {
    level: SeverityLevel;
    label: string;
    description?: string;
  };
  /** Soru 3: Bu sorun beni veya müşterilerimi nasıl etkiliyor? */
  businessImpact: string;
  /** Soru 4: Şimdi ne yapmalıyım? */
  recommendedAction: {
    label: string;
    description: string;
    buttonText?: string;
    onAction?: () => void;
    icon?: LucideIcon;
  };
  /** Soru 5: Bu işlemi yaparsam ne olacak? */
  actionOutcome: string;
  /** Opsiyonel ek aksiyon butonları */
  extraActions?: React.ReactNode;
  /** Opsiyonel açılır teknik ayrıntı katmanı */
  technicalDetails?: React.ReactNode;
  defaultExpandDetails?: boolean;
}

export const ExecutiveGuidanceCard: React.FC<ExecutiveGuidanceCardProps> = ({
  status,
  badgeLabel,
  title,
  subtitle,
  currentState,
  severity,
  businessImpact,
  recommendedAction,
  actionOutcome,
  extraActions,
  technicalDetails,
  defaultExpandDetails = false,
}) => {
  const { t } = useI18n();
  const [showTechnical, setShowTechnical] = useState<boolean>(defaultExpandDetails);

  // Status-based styling
  const getCardStyle = () => {
    switch (status) {
      case 'ok':
        return {
          wrapper: 'border-emerald-200/90 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/50 via-white to-white dark:from-emerald-950/20 dark:via-[#2F3349] dark:to-[#2F3349]',
          iconBg: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
          Icon: ShieldCheck,
          statusBadge: 'active' as StatusVariant,
          pulse: false,
        };
      case 'warn':
        return {
          wrapper: 'border-amber-200/90 dark:border-amber-900/40 bg-gradient-to-br from-amber-50/50 via-white to-white dark:from-amber-950/20 dark:via-[#2F3349] dark:to-[#2F3349]',
          iconBg: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
          Icon: AlertTriangle,
          statusBadge: 'warning' as StatusVariant,
          pulse: true,
        };
      case 'critical':
        return {
          wrapper: 'border-rose-200/90 dark:border-rose-900/40 bg-gradient-to-br from-rose-50/50 via-white to-white dark:from-rose-950/20 dark:via-[#2F3349] dark:to-[#2F3349]',
          iconBg: 'bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400',
          Icon: ShieldAlert,
          statusBadge: 'danger' as StatusVariant,
          pulse: true,
        };
      case 'unknown':
        return {
          wrapper: 'border-slate-300 dark:border-white/10 bg-gradient-to-br from-slate-50/60 via-white to-white dark:from-white/[0.04] dark:via-[#2F3349] dark:to-[#2F3349]',
          iconBg: 'bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-slate-400',
          Icon: HelpCircle,
          statusBadge: 'neutral' as StatusVariant,
          pulse: false,
        };
      default:
        return {
          wrapper: 'border-indigo-200/90 dark:border-indigo-900/40 bg-gradient-to-br from-indigo-50/50 via-white to-white dark:from-indigo-950/20 dark:via-[#2F3349] dark:to-[#2F3349]',
          iconBg: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
          Icon: Info,
          statusBadge: 'primary' as StatusVariant,
          pulse: false,
        };
    }
  };

  const getSeverityBadgeVariant = (level: SeverityLevel): StatusVariant => {
    switch (level) {
      case 'critical':
        return 'danger';
      case 'high':
        return 'warning';
      case 'medium':
        return 'warning';
      case 'low':
        return 'info';
      case 'normal':
      default:
        return 'active';
    }
  };

  const { wrapper, iconBg, Icon, statusBadge, pulse } = getCardStyle();
  const ActionIcon = recommendedAction.icon || ArrowRight;

  return (
    <Card className={`border shadow-sm transition-all overflow-hidden ${wrapper}`}>
      <CardContent className="p-4 sm:p-5 space-y-3.5">
        {/* Header Block: Title, Badges, Direct Actions */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.06] pb-3">
          <div className="flex items-start sm:items-center gap-2.5">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-xs ${iconBg}`}>
              <Icon className="w-4.5 h-4.5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white leading-tight">
                  {title}
                </h3>
                <StatusBadge
                  status={statusBadge}
                  label={badgeLabel || t(`admin.guidance.status_${status}`)}
                  pulse={pulse}
                  size="sm"
                />
              </div>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-vuexy-dark-muted mt-0.5">
                {subtitle}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {extraActions}
            {recommendedAction.onAction && recommendedAction.buttonText && !extraActions && (
              <Button
                size="sm"
                variant="default"
                onClick={recommendedAction.onAction}
                className="gap-1.5 text-xs font-semibold cursor-pointer shadow-sm shadow-vuexy-primary/30"
              >
                <ActionIcon className="w-3.5 h-3.5" />
                <span>{recommendedAction.buttonText}</span>
              </Button>
            )}
          </div>
        </div>

        {/* 5 Core Executive Questions Grid — fully responsive: 1-col mobile, 2-col tablet, 3-col laptop, 5-col desktop */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {/* Soru 1: Şu anda sistemin durumu ne? */}
          <div className="p-3.5 rounded-xl bg-white/80 dark:bg-[#2F3349]/80 border border-slate-200/80 dark:border-white/[0.06] shadow-xs flex flex-col justify-between min-w-0">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] min-w-0">
                <Activity className="w-3.5 h-3.5 text-vuexy-primary shrink-0" />
                <span className="truncate" title={t('admin.guidance.qCurrentState')}>{t('admin.guidance.qCurrentState')}</span>
              </div>
              <p className="text-xs sm:text-[13px] font-semibold text-slate-800 dark:text-slate-100 mt-2 leading-snug break-words">
                {currentState}
              </p>
            </div>
          </div>

          {/* Soru 2: Bir sorun varsa ne kadar önemli? */}
          <div className="p-3.5 rounded-xl bg-white/80 dark:bg-[#2F3349]/80 border border-slate-200/80 dark:border-white/[0.06] shadow-xs flex flex-col justify-between min-w-0">
            <div>
              <div className="flex items-center justify-between gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="truncate" title={t('admin.guidance.qSeverity')}>{t('admin.guidance.qSeverity')}</span>
                </div>
                <StatusBadge
                  status={getSeverityBadgeVariant(severity.level)}
                  label={severity.label}
                  size="sm"
                  className="shrink-0 max-w-[130px] truncate"
                />
              </div>
              <p className="text-xs sm:text-[13px] font-semibold text-slate-800 dark:text-slate-100 mt-2 leading-snug break-words">
                {severity.description || severity.label}
              </p>
            </div>
          </div>

          {/* Soru 3: Bu sorun beni veya müşterilerimi nasıl etkiliyor? */}
          <div className="p-3.5 rounded-xl bg-white/80 dark:bg-[#2F3349]/80 border border-slate-200/80 dark:border-white/[0.06] shadow-xs flex flex-col justify-between min-w-0">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] min-w-0">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="truncate" title={t('admin.guidance.qImpact')}>{t('admin.guidance.qImpact')}</span>
              </div>
              <p className="text-xs sm:text-[13px] font-semibold text-slate-800 dark:text-slate-100 mt-2 leading-snug break-words">
                {businessImpact}
              </p>
            </div>
          </div>

          {/* Soru 4: Şimdi ne yapmalıyım? */}
          <div className="p-3.5 rounded-xl bg-white/80 dark:bg-[#2F3349]/80 border border-slate-200/80 dark:border-white/[0.06] shadow-xs flex flex-col justify-between min-w-0">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] min-w-0">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span className="truncate" title={t('admin.guidance.qRecommendedAction')}>{t('admin.guidance.qRecommendedAction')}</span>
              </div>
              <div className="mt-2 space-y-0.5">
                <span className="text-xs sm:text-[13px] font-bold text-slate-800 dark:text-white block leading-snug">
                  {recommendedAction.label}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-snug break-words">
                  {recommendedAction.description}
                </p>
              </div>
            </div>
          </div>

          {/* Soru 5: Bu işlemi yaparsam ne olacak? */}
          <div className="p-3.5 rounded-xl bg-white/80 dark:bg-[#2F3349]/80 border border-slate-200/80 dark:border-white/[0.06] shadow-xs flex flex-col justify-between min-w-0">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] min-w-0">
                <Terminal className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                <span className="truncate" title={t('admin.guidance.qOutcome')}>{t('admin.guidance.qOutcome')}</span>
              </div>
              <p className="text-xs sm:text-[13px] font-semibold text-slate-800 dark:text-slate-100 mt-2 leading-snug break-words">
                {actionOutcome}
              </p>
            </div>
          </div>
        </div>

        {/* Expandable Technical Details Disclosure */}
        {technicalDetails && (
          <div className="pt-2 border-t border-slate-100 dark:border-white/[0.06]">
            <button
              type="button"
              onClick={() => setShowTechnical(!showTechnical)}
              className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-vuexy-dark-muted hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer"
            >
              <Terminal className="w-3.5 h-3.5 text-slate-400" />
              <span>
                {showTechnical
                  ? t('admin.guidance.hideTechnicalDetails')
                  : t('admin.guidance.showTechnicalDetails')}
              </span>
              {showTechnical ? (
                <ChevronUp className="w-3.5 h-3.5 ml-0.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 ml-0.5" />
              )}
            </button>
            {showTechnical && (
              <div className="mt-3 p-4 rounded-xl bg-slate-50/70 dark:bg-black/20 border border-slate-200/60 dark:border-white/[0.05] animate-fade-in space-y-3">
                {technicalDetails}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
