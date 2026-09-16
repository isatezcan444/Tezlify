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
        <div className="hidden sm:flex flex-col text-right">
          <span className="text-[11px] text-slate-400 dark:text-vuexy-dark-muted font-medium">
            {t('admin.lastUpdated')} <strong className="text-slate-600 dark:text-slate-200">{lastUpdated}</strong>
          </span>
          <span className="text-[10px] text-slate-400/80 dark:text-slate-500">
            {t('admin.autoRefresh')}
          </span>
        </div>
      )}
      {onRefresh && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="gap-2 cursor-pointer border-slate-200 dark:border-white/[0.08]"
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
      <div className="space-y-6">
        {children}
      </div>
    </div>
  );
};
