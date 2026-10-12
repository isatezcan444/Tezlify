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
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  Layers,
  Terminal,
  Activity,
  Archive,
  Lock
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { AdminOverviewResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { ExecutiveGuidanceCard } from '../../components/admin/ExecutiveGuidanceCard';
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
        isRefreshing={true}
      >
        <div className="space-y-6">
          {/* Executive Guidance Skeleton Card */}
          <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardContent className="p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-white/[0.06]">
                <div className="flex items-center gap-3">
                  <Skeleton className="w-9 h-9 rounded-xl" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-5 w-44 rounded-md" />
                    <Skeleton className="h-3 w-64 rounded-md" />
                  </div>
                </div>
                <Skeleton className="h-6 w-28 rounded-full" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-2.5">
                    <Skeleton className="h-3.5 w-24 rounded-md" />
                    <Skeleton className="h-4 w-full rounded-md" />
                    <Skeleton className="h-3 w-3/4 rounded-md" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

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

  const getServiceDescription = (name: string): string => {
    if (name.includes('backend')) return t('admin.serviceBackendDesc');
    if (name.includes('gateway')) return t('admin.serviceGatewayDesc');
    if (name.includes('caddy')) return t('admin.serviceCaddyDesc');
    if (name.includes('db')) return t('admin.serviceDbDesc');
    return t('admin.productionServices');
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
      {/* 4. Executive Status & Action Guidance Card (5 Core Questions) */}
      <ExecutiveGuidanceCard
        status={data.overall_status === 'OK' ? 'ok' : data.overall_status === 'WARN' ? 'warn' : 'critical'}
        badgeLabel={getOverallStatusLabel()}
        title={t('admin.executiveGuidanceTitle')}
        subtitle={t('admin.executiveGuidanceSubtitle')}
        currentState={
          data.overall_status === 'OK'
            ? t('admin.guidance.systemHealthyState')
            : data.overall_status === 'WARN'
            ? t('admin.guidance.systemWarningState')
            : t('admin.guidance.systemCriticalState')
        }
        severity={{
          level: data.overall_status === 'OK' ? 'normal' : data.overall_status === 'WARN' ? 'medium' : 'critical',
          label:
            data.overall_status === 'OK'
              ? t('admin.guidance.severityNormal')
              : data.overall_status === 'WARN'
              ? t('admin.guidance.severityMedium')
              : t('admin.guidance.severityCritical'),
          description:
            data.overall_status_reasons && data.overall_status_reasons.length > 0
              ? data.overall_status_reasons.join(', ')
              : t('admin.executiveAllGood'),
        }}
        businessImpact={
          data.overall_status === 'OK'
            ? t('admin.guidance.zeroCustomerImpact')
            : data.overall_status_reasons?.[0]?.toLowerCase().includes('reboot')
            ? t('admin.rebootRequiredHelp')
            : t('admin.executiveAttentionBody')
        }
        recommendedAction={{
          label:
            data.overall_status === 'OK'
              ? t('admin.guidance.noActionNeeded')
              : t('admin.actionGoToOps'),
          description:
            data.overall_status === 'OK'
              ? t('admin.guidance.noActionNeededDesc')
              : t('admin.executiveAttentionBody'),
          buttonText: data.overall_status !== 'OK' && onNavigate ? t('admin.actionGoToOps') : undefined,
          onAction: data.overall_status !== 'OK' && onNavigate ? () => onNavigate('admin-operations') : undefined,
          icon: Terminal,
        }}
        actionOutcome={
          data.overall_status === 'OK'
            ? t('admin.guidance.noActionOutcome')
            : t('admin.guidance.safeActionTaken')
        }
        extraActions={
          onNavigate && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onNavigate('admin-whatsapp')}
                className="gap-1.5 text-xs font-semibold cursor-pointer border-slate-200 dark:border-white/[0.08]"
              >
                <Layers className="w-3.5 h-3.5 text-emerald-500" />
                {t('admin.actionGoToWhatsApp')}
              </Button>
            </div>
          )
        }
        technicalDetails={
          <div className="space-y-2 text-xs">
            <div className="font-mono text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Load Average: </span>
              {data.system.load_average.join(', ')} | CPU Cores: {data.system.cpu_cores}
            </div>
            <div className="font-mono text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Memory: </span>
              {data.system.memory_used_mb} MB / {data.system.memory_total_mb} MB ({data.system.memory_available_mb} MB avail)
            </div>
            {data.overall_status_reasons && data.overall_status_reasons.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200/50 dark:border-white/[0.05]">
                <span className="font-semibold text-slate-700 dark:text-slate-200">System Warnings:</span>
                <ul className="list-disc list-inside mt-1 space-y-1 text-amber-600 dark:text-amber-400">
                  {data.overall_status_reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        }
      />

      {/* 5. Executive Quick Navigation Hub */}
      {onNavigate && (
        <Card className="border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="p-4 sm:p-5 border-b border-slate-100 dark:border-white/[0.06]">
            <CardTitle className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-vuexy-primary" />
              {t('admin.quickNavTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 sm:p-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { tab: 'admin-operations', label: t('admin.ops.title'), icon: Terminal, color: 'text-vuexy-primary' },
                { tab: 'admin-whatsapp', label: t('admin.whatsapp.title'), icon: Layers, color: 'text-emerald-500' },
                { tab: 'admin-deployment', label: t('admin.deployment.title'), icon: Server, color: 'text-blue-500' },
                { tab: 'admin-monitoring', label: t('admin.monitoring.title'), icon: Activity, color: 'text-purple-500' },
                { tab: 'admin-security', label: t('admin.security.title'), icon: Lock, color: 'text-amber-500' },
                { tab: 'admin-backups', label: t('admin.backups.title'), icon: Archive, color: 'text-teal-500' },
              ].map((item) => {
                const IconComponent = item.icon;
                return (
                  <button
                    key={item.tab}
                    type="button"
                    onClick={() => onNavigate(item.tab)}
                    className="p-3 rounded-xl border border-slate-200/80 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] hover:bg-slate-100/80 dark:hover:bg-white/[0.05] transition-all flex flex-col items-center text-center gap-2 cursor-pointer group"
                  >
                    <div className={`p-2 rounded-lg bg-white dark:bg-white/[0.05] shadow-xs group-hover:scale-105 transition-transform ${item.color}`}>
                      <IconComponent className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 leading-tight">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 6. System Resource Cards (4-col grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* CPU & Load */}
        <StatsCard
          title={t('admin.cpuLoad')}
          value={`${data.system.cpu_cores} ${t('admin.cores')}`}
          subText={`${t('admin.loadAvg')}: ${data.system.load_average.join(' / ')} • ${data.system.load_average[0] < data.system.cpu_cores ? t('admin.loadNormal') : t('admin.loadHigh')}`}
          icon={Cpu}
          iconVariant="primary"
        />

        {/* Memory */}
        <StatsCard
          title={t('admin.memory')}
          value={`${(data.system.memory_used_mb / 1024).toFixed(1)} GB`}
          subText={`${t('admin.ramUsedPercent', { percent: ((data.system.memory_used_mb / Math.max(1, data.system.memory_total_mb)) * 100).toFixed(0) })} • ${(data.system.memory_available_mb / 1024).toFixed(1)} GB ${t('admin.memoryAvail')}`}
          icon={Server}
          iconVariant="info"
        />

        {/* Disk */}
        <StatsCard
          title={t('admin.disk')}
          value={`${data.system.disk_used_percent}%`}
          subText={`${data.system.disk_used_gb} GB / ${data.system.disk_total_gb} GB • ${data.system.disk_used_percent < 85 ? t('admin.diskAdequate') : t('admin.diskCritical')}`}
          icon={HardDrive}
          iconVariant="warning"
        />

        {/* Uptime & Reboot */}
        <StatsCard
          title={t('admin.hostUptime')}
          value={data.system.uptime.replace('up ', '')}
          subText={data.system.reboot_required ? t('admin.rebootRequiredHelp') : t('admin.rebootNotRequiredHelp')}
          icon={Clock}
          iconVariant={data.system.reboot_required ? 'danger' : 'success'}
          badge={
            data.system.reboot_required
              ? { text: t('admin.rebootRequiredBadge'), variant: 'danger' }
              : { text: t('admin.rebootNotRequiredBadge'), variant: 'success' }
          }
        />
      </div>

      {/* 7. Production Services Fleet Cards */}
      <Card className="border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
        <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-vuexy-primary" />
              {t('admin.productionServices')}
            </CardTitle>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-slate-400 dark:text-vuexy-dark-muted">
              {t('admin.coreContainersCount', { count: data.containers.length })}
            </span>
            {onNavigate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onNavigate('admin-operations')}
                className="gap-1.5 text-xs font-medium cursor-pointer"
              >
                <Terminal className="w-3.5 h-3.5" />
                {t('admin.actionGoToOps')}
              </Button>
            )}
          </div>
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
                      <p className="text-[11px] text-slate-500 dark:text-vuexy-dark-muted line-clamp-1 mt-0.5">
                        {getServiceDescription(c.name)}
                      </p>
                      <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 block mt-0.5">
                        {c.name}
                      </span>
                    </div>
                    <StatusBadge
                      status={isRunning ? 'active' : 'danger'}
                      label={isRunning ? t('admin.statusRunning') : c.status}
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

      {/* 8. Database Summary Card */}
      <Card className="border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
        <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between">
          <CardTitle className="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-[#7367F0]" />
            {t('admin.database')}
          </CardTitle>
          <StatusBadge
            status={data.database.health === 'healthy' ? 'active' : 'danger'}
            label={data.database.health === 'healthy' ? t('admin.statusHealthy') : data.database.health}
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
                {t('admin.dbConnectionsLimit', { active: data.database.connections_active, total: data.database.connections_total, max: 100 })}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </AdminShell>
  );
};
