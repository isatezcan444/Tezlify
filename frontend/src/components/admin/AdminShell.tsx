import React from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/button';
import { useI18n } from '../../context/I18nContext';

export interface AdminShellProps {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  lastUpdated?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  children: React.ReactNode;
}

export const AdminShell: React.FC<AdminShellProps> = ({
  title,
  subtitle,
  badge,
  actions,
  lastUpdated,
  onRefresh,
  isRefreshing = false,
  children,
}) => {
  const { t } = useI18n();

  const headerActions = (
    <div className="flex items-center gap-3 flex-wrap">
      {lastUpdated && (
        <div className="flex flex-col text-right">
          <span className="text-[11px] text-slate-500 dark:text-vuexy-dark-muted font-medium flex items-center justify-end gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isRefreshing ? 'bg-amber-400 animate-ping' : 'bg-emerald-500'
              }`}
              title={isRefreshing ? t('admin.staleDataBadge') : t('admin.liveMonitoringBadge')}
            />
            <span className="hidden sm:inline">{t('admin.lastUpdated')}</span>
            <strong className="text-slate-700 dark:text-slate-200">{lastUpdated}</strong>
          </span>
          <span className="hidden sm:inline text-[10px] text-slate-400/80 dark:text-slate-500">
            {t('admin.autoRefresh')}
          </span>
        </div>
      )}
      {onRefresh && (
        <Button
          variant="outline"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="min-h-[40px] h-10 px-4 rounded-xl text-xs font-semibold gap-2 cursor-pointer border-slate-200/80 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors"
          aria-label={t('admin.refreshNow')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-vuexy-primary' : ''}`} />
          <span className="hidden xs:inline">{t('admin.refreshNow')}</span>
        </Button>
      )}
      {actions}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle={subtitle}
        icon={Activity}
        badge={badge}
        actions={headerActions}
      />
      {/* The entrance animation lives here rather than in each admin page so
          every section of the panel transitions identically. `App.tsx` keys the
          <main> on the active tab, which remounts this shell and replays it on
          each navigation. */}
      <div className="space-y-6 animate-fade-in">
        {children}
      </div>
    </div>
  );
};
