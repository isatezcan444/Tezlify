import React, { useState } from 'react';
import { 
  AlertTriangle, 
  AlertCircle, 
  Info, 
  ChevronDown, 
  ChevronUp, 
  Loader2,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { StatusBadge, StatusVariant } from '../ui/StatusBadge';

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface IssueAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: 'default' | 'outline' | 'secondary' | 'destructive' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}

export interface AdminActionIssueCardProps {
  id?: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  statusLabel?: string;
  impact: string;
  recommendedAction: string;
  primaryAction?: IssueAction;
  secondaryAction?: IssueAction;
  details?: React.ReactNode;
  className?: string;
}

export const AdminActionIssueCard: React.FC<AdminActionIssueCardProps> = ({
  title,
  description,
  severity,
  statusLabel,
  impact,
  recommendedAction,
  primaryAction,
  secondaryAction,
  details,
  className = '',
}) => {
  const [showDetails, setShowDetails] = useState(false);

  const config = {
    critical: {
      border: 'border-rose-300/80 dark:border-rose-900/50',
      bg: 'bg-rose-50/50 dark:bg-rose-950/15',
      badgeStatus: 'danger' as StatusVariant,
      badgeDefault: 'Kritik',
      icon: <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />,
      accentBg: 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300',
    },
    warning: {
      border: 'border-amber-300/80 dark:border-amber-900/50',
      bg: 'bg-amber-50/50 dark:bg-amber-950/15',
      badgeStatus: 'warning' as StatusVariant,
      badgeDefault: 'Dikkat Gerekiyor',
      icon: <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />,
      accentBg: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    },
    info: {
      border: 'border-blue-300/80 dark:border-blue-900/50',
      bg: 'bg-blue-50/50 dark:bg-blue-950/15',
      badgeStatus: 'info' as StatusVariant,
      badgeDefault: 'Bilgi',
      icon: <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />,
      accentBg: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    },
  }[severity];

  return (
    <Card className={`border shadow-sm overflow-hidden ${config.border} ${config.bg} ${className}`}>
      <CardContent className="p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-xl shrink-0 ${config.accentBg}`}>
              {config.icon}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-sm font-bold text-slate-800 dark:text-white leading-tight">
                  {title}
                </h4>
                <StatusBadge 
                  status={config.badgeStatus} 
                  label={statusLabel || config.badgeDefault} 
                  size="sm" 
                />
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {description}
              </p>
            </div>
          </div>
        </div>

        {/* 3-Part Operational Metadata: Durum, Etkisi, Önerilen İşlem */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 p-3 rounded-xl bg-white/70 dark:bg-[#1E2333]/70 border border-slate-200/60 dark:border-white/[0.04] text-xs">
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] block">
              Durum
            </span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {statusLabel || config.badgeDefault}
            </span>
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] block">
              Etkisi
            </span>
            <span className="text-slate-600 dark:text-slate-300">
              {impact}
            </span>
          </div>
          <div className="space-y-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-[#7E7F96] block">
              Önerilen İşlem
            </span>
            <span className="font-semibold text-slate-800 dark:text-white">
              {recommendedAction}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
          {details ? (
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="min-h-[40px] px-1 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 inline-flex items-center gap-1.5 cursor-pointer select-none transition-colors"
            >
              <span>{showDetails ? 'Ayrıntıları Gizle' : 'Teknik Ayrıntıları Gör'}</span>
              {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          ) : <div className="hidden sm:block" />}

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:justify-end w-full sm:w-auto">
            {secondaryAction && (
              <Button
                variant={secondaryAction.variant || 'outline'}
                disabled={secondaryAction.disabled || secondaryAction.loading}
                onClick={secondaryAction.onClick}
                className="min-h-[44px] h-11 px-5 w-full sm:w-auto text-xs sm:text-sm font-semibold rounded-xl flex items-center justify-center gap-2 border border-slate-300 dark:border-white/[0.12] bg-white dark:bg-[#2F3349] hover:bg-slate-50 dark:hover:bg-[#363B53] text-slate-700 dark:text-slate-200 transition-all active:scale-[0.98] cursor-pointer"
              >
                {secondaryAction.loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {secondaryAction.icon && !secondaryAction.loading && React.createElement(secondaryAction.icon, { className: 'w-4 h-4 shrink-0' })}
                <span className="truncate">{secondaryAction.label}</span>
              </Button>
            )}

            {primaryAction && (
              <Button
                variant={primaryAction.variant || 'default'}
                disabled={primaryAction.disabled || primaryAction.loading}
                onClick={primaryAction.onClick}
                className={`min-h-[44px] h-11 px-5 w-full sm:w-auto text-xs sm:text-sm font-bold rounded-xl flex items-center justify-center gap-2 shadow-sm transition-all active:scale-[0.98] cursor-pointer ${
                  severity === 'critical'
                    ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20'
                    : 'bg-[#7367F0] hover:bg-[#685dd8] text-white shadow-[#7367F0]/30'
                }`}
              >
                {primaryAction.loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {primaryAction.icon && !primaryAction.loading && React.createElement(primaryAction.icon, { className: 'w-4 h-4 shrink-0' })}
                <span className="truncate">{primaryAction.label}</span>
              </Button>
            )}
          </div>
        </div>

        {/* Collapsible Details */}
        {details && showDetails && (
          <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.04] animate-fade-in text-xs">
            {details}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
