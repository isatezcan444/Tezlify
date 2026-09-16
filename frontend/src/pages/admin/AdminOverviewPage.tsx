import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  AlertTriangle, 
  Cpu, 
  HardDrive, 
  Clock, 
  Database, 
  Server, 
  ShieldAlert, 
  CheckCircle2, 
  ArrowLeft
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { AdminOverviewResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminOverviewPageProps {
  onNavigate?: (tab: string) => void;
}

export const AdminOverviewPage: React.FC<AdminOverviewPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchOverview = useCallback(async (isInitial = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    if (isInitial) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await AdminApi.getOverview();
      setData(res);
      setError(null);
      const now = new Date();
      setLastUpdated(now.toLocaleTimeString());
    } catch (err: any) {
      if (err.message === 'ACCESS_DENIED') {
        setError('ACCESS_DENIED');
      } else {
        setError(err.message || t('admin.errorDesc'));
      }
    } finally {
      if (isInitial) setLoading(false);
      setRefreshing(false);
      fetchingRef.current = false;
    }
  }, [t]);

  // Initial fetch and 30s polling
  useEffect(() => {
    if (!showAdmin) {
      setLoading(false);
      return;
    }

    void fetchOverview(true);

    const intervalId = setInterval(() => {
      // Pause polling if the tab is hidden
      if (document.visibilityState === 'hidden') return;
      void fetchOverview(false);
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchOverview(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showAdmin, fetchOverview]);

  // 1. Access Denied Guard (Non-Admin)
  if (!showAdmin || error === 'ACCESS_DENIED') {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-4 select-none">
        <Card className="border-red-200 dark:border-red-900/40 bg-white dark:bg-[#2F3349] shadow-sm">
          <CardContent className="p-8 text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center justify-center">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold text-slate-800 dark:text-white">
              {t('admin.accessDeniedTitle')}
            </h3>
            <p className="text-sm text-slate-500 dark:text-vuexy-dark-muted max-w-md mx-auto">
              {t('admin.accessDeniedDesc')}
            </p>
            {onNavigate && (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('dashboard')}
                  className="gap-2 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t('common.back')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // 2. Loading State (Initial Skeleton)
  if (loading) {
    return (
      <AdminShell
        title={t('admin.operationsCenter')}
        subtitle={t('titles.adminOverviewSub')}
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="p-5 space-y-3 bg-white dark:bg-[#2F3349]">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-3 w-40" />
              </Card>
            ))}
          </div>
          <Card className="p-6 space-y-4 bg-white dark:bg-[#2F3349]">
            <Skeleton className="h-6 w-48" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          </Card>
        </div>
      </AdminShell>
    );
  }

  // 3. Error State (Retryable)
  if (error && !data) {
    return (
      <AdminShell
        title={t('admin.operationsCenter')}
        subtitle={t('titles.adminOverviewSub')}
      >
        <Card className="border-amber-200 dark:border-amber-900/40 bg-white dark:bg-[#2F3349] p-8 text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">
            {t('admin.errorTitle')}
          </h3>
          <p className="text-sm text-slate-500 dark:text-vuexy-dark-muted max-w-md mx-auto">
            {error}
          </p>
          <Button
            variant="default"
            size="sm"
            onClick={() => void fetchOverview(true)}
            className="cursor-pointer"
          >
            {t('admin.retry')}
          </Button>
        </Card>
      </AdminShell>
    );
  }

  if (!data) return null;

  // Status mapping
  const getOverallStatusVariant = (): StatusVariant => {
    switch (data.overall_status) {
      case 'OK':
        return 'active';
      case 'WARN':
        return 'warning';
      case 'CRITICAL':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const getOverallStatusLabel = (): string => {
    switch (data.overall_status) {
      case 'OK':
        return t('admin.statusOk');
      case 'WARN':
        return t('admin.statusWarn');
      case 'CRITICAL':
        return t('admin.statusCritical');
      default:
        return data.overall_status;
    }
  };

  const getServiceDisplayName = (name: string): string => {
    if (name.includes('backend')) return t('admin.serviceBackend');
    if (name.includes('gateway')) return t('admin.serviceGateway');
    if (name.includes('caddy')) return t('admin.serviceCaddy');
    if (name.includes('db')) return t('admin.serviceDb');
    return name;
  };

  return (
    <AdminShell
      title={t('admin.operationsCenter')}
      subtitle={t('titles.adminOverviewSub')}
      lastUpdated={lastUpdated}
      onRefresh={() => void fetchOverview(false)}
      isRefreshing={refreshing}
      badge={
        <StatusBadge
          status={getOverallStatusVariant()}
          label={getOverallStatusLabel()}
          pulse={data.overall_status !== 'OK'}
          size="sm"
        />
      }
    >
      {/* 4. Attention / Operational Warnings Section */}
      {data.overall_status_reasons && data.overall_status_reasons.length > 0 && data.overall_status !== 'OK' && (
        <Card className="border-l-4 border-l-[#FF9F43] bg-amber-50/50 dark:bg-amber-950/10 border-slate-200 dark:border-white/[0.08] shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start gap-3.5">
              <div className="p-2 rounded-lg bg-[#FF9F43]/15 text-[#FF9F43] shrink-0 mt-0.5">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 flex-1">
                <h4 className="text-sm font-bold text-slate-800 dark:text-white">
                  {t('admin.attention')}
                </h4>
                <p className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium">
                  {t('admin.attentionSubtitle')}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2">
                  {data.overall_status_reasons.map((reason, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-[#2F3349] p-2.5 rounded-lg border border-slate-200/80 dark:border-white/[0.06]"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[#FF9F43] shrink-0" />
                      <span className="truncate">{reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 5. System Resource Cards (4-col grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* CPU & Load */}
        <StatsCard
          title={t('admin.cpuLoad')}
          value={`${data.system.cpu_cores} ${t('admin.cores')}`}
          subText={`${t('admin.loadAvg')}: ${data.system.load_average.join(' / ')}`}
          icon={Cpu}
          iconVariant="primary"
        />

        {/* Memory */}
        <StatsCard
          title={t('admin.memory')}
          value={`${(data.system.memory_used_mb / 1024).toFixed(1)} GB`}
          subText={`${t('admin.memoryAvail')}: ${(data.system.memory_available_mb / 1024).toFixed(1)} GB / ${(data.system.memory_total_mb / 1024).toFixed(1)} GB`}
          icon={Server}
          iconVariant="info"
        />

        {/* Disk */}
        <StatsCard
          title={t('admin.disk')}
          value={`${data.system.disk_used_percent}%`}
          subText={`${data.system.disk_used_gb} GB ${t('admin.diskUsed')} / ${data.system.disk_total_gb} GB`}
          icon={HardDrive}
          iconVariant="warning"
        />

        {/* Uptime & Reboot */}
        <StatsCard
          title={t('admin.hostUptime')}
          value={data.system.uptime.replace('up ', '')}
          subText={data.system.reboot_required ? t('admin.rebootPending') : t('admin.rebootNotRequiredBadge')}
          icon={Clock}
          iconVariant={data.system.reboot_required ? 'danger' : 'success'}
          badge={
            data.system.reboot_required
              ? { text: t('admin.rebootRequiredBadge'), variant: 'danger' }
              : { text: t('admin.rebootNotRequiredBadge'), variant: 'success' }
          }
        />
      </div>

      {/* 6. Production Services Fleet Cards */}
      <Card className="border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
        <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-vuexy-primary" />
              {t('admin.productionServices')}
            </CardTitle>
          </div>
          <span className="text-xs font-semibold text-slate-400 dark:text-vuexy-dark-muted">
            {data.containers.length} Core Containers
          </span>
        </CardHeader>
        <CardContent className="p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {data.containers.map((c) => {
              const isRunning = c.status.toLowerCase() === 'running';
              return (
                <div
                  key={c.name}
                  className="p-4 rounded-xl border border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] flex flex-col justify-between space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h5 className="text-xs font-bold text-slate-800 dark:text-white truncate" title={c.name}>
                        {getServiceDisplayName(c.name)}
                      </h5>
                      <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
                        {c.name}
                      </span>
                    </div>
                    <StatusBadge
                      status={isRunning ? 'active' : 'danger'}
                      label={isRunning ? 'Running' : c.status}
                      size="sm"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px] border-t border-slate-100 dark:border-white/[0.06] pt-2.5">
                    <div>
                      <span className="text-slate-400 dark:text-slate-500 block">{t('admin.restarts')}</span>
                      <strong className="text-slate-700 dark:text-slate-200 font-semibold">{c.restart_count}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 dark:text-slate-500 block">{t('admin.rssMemory')}</span>
                      <strong className="text-slate-700 dark:text-slate-200 font-semibold">{c.rss_mb} MB</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 dark:text-slate-500 block">{t('admin.oomKilled')}</span>
                      <strong className={c.oom_killed ? 'text-red-500 font-bold' : 'text-slate-700 dark:text-slate-200 font-semibold'}>
                        {c.oom_killed ? t('admin.oomYes') : t('admin.oomNo')}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-400 dark:text-slate-500 block">{t('common.status')}</span>
                      <strong className="text-slate-700 dark:text-slate-200 font-semibold uppercase text-[10px]">
                        {c.status}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* 7. Database Summary Card */}
      <Card className="border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
        <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between">
          <CardTitle className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-[#7367F0]" />
            {t('admin.database')}
          </CardTitle>
          <StatusBadge
            status={data.database.health === 'healthy' ? 'active' : 'danger'}
            label={data.database.health === 'healthy' ? 'Healthy' : data.database.health}
            size="sm"
          />
        </CardHeader>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
              <span className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium block">
                {t('admin.dbSize')}
              </span>
              <span className="text-lg font-bold text-slate-800 dark:text-white mt-1 block">
                {data.database.database_size_mb} MB
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
              <span className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium block">
                {t('admin.activeConnections')}
              </span>
              <span className="text-lg font-bold text-[#28C76F] mt-1 block">
                {data.database.connections_active}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
              <span className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium block">
                {t('admin.idleConnections')}
              </span>
              <span className="text-lg font-bold text-slate-600 dark:text-slate-300 mt-1 block">
                {data.database.connections_idle}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
              <span className="text-xs text-slate-500 dark:text-vuexy-dark-muted font-medium block">
                {t('admin.totalConnections')}
              </span>
              <span className="text-lg font-bold text-slate-800 dark:text-white mt-1 block">
                {data.database.connections_total} / 100
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </AdminShell>
  );
};
