import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  Activity, 
  Layers, 
  ArrowLeft, 
  RefreshCw, 
  Info,
  Inbox
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { 
  AdminMonitoringResponse, 
  AdminInvariantStatus, 
  AdminObservationRecord 
} from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';
import { DataTable, ColumnDef } from '../../components/data-display/DataTable';

interface AdminMonitoringPageProps {
  onNavigate?: (tab: string) => void;
}

const formatDuration = (seconds?: number | null): string => {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
};

const formatDateTime = (isoString?: string | null): string => {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return isoString;
  }
};

export const AdminMonitoringPage: React.FC<AdminMonitoringPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminMonitoringResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchMonitoring = useCallback(async (isInitial = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    if (isInitial) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await AdminApi.getMonitoring();
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

    void fetchMonitoring(true);

    const intervalId = setInterval(() => {
      // Pause polling if the tab is hidden
      if (document.visibilityState === 'hidden') return;
      void fetchMonitoring(false);
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchMonitoring(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showAdmin, fetchMonitoring]);

  // 1. Access Denied Guard (Non-Admin)
  if (!showAdmin || error === 'ACCESS_DENIED') {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-4 select-none">
        <Card className="border-red-200 dark:border-red-900/40 bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center text-[#EA5455]">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.accessDeniedTitle')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">HTTP 403 Forbidden</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {t('admin.accessDeniedDesc')}
            </p>
            {onNavigate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate('dashboard')}
                className="flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('titles.dashboard')}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // 2. Error State (Non-403)
  if (error && !data) {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-4 select-none">
        <Card className="border-amber-200 dark:border-amber-900/40 bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-[#FF9F43]">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.errorTitle')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">{error}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t('admin.errorDesc')}
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="default"
                size="sm"
                onClick={() => fetchMonitoring(true)}
                disabled={refreshing}
                className="flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                {t('admin.retry')}
              </Button>
              {onNavigate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('admin-overview')}
                  className="flex items-center gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t('nav.adminOverview')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 3. Loading Skeletons
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200 dark:border-white/[0.06]">
          <div className="space-y-2">
            <Skeleton className="h-8 w-64 rounded-lg" />
            <Skeleton className="h-4 w-96 rounded-md" />
          </div>
          <Skeleton className="h-9 w-32 rounded-lg" />
        </div>
        <Skeleton className="h-44 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) return null;

  const {
    overall_status,
    overall_status_reasons,
    observation,
    system_monitor,
    whatsapp_observer,
    invariants,
    recent_observations
  } = data;

  // Invariant Summary calculation
  const passingInvariants = invariants.filter(i => i.passed === true).length;
  const failingInvariants = invariants.filter(i => i.passed === false).length;
  const totalInvariants = invariants.length;
  const unknownInvariants = totalInvariants - (passingInvariants + failingInvariants);

  // Overall status badge mapping
  const overallBadgeVariant: StatusVariant = 
    overall_status === 'CRITICAL' ? 'danger' : overall_status === 'WARN' ? 'warning' : 'online';

  const overallBadgeText = 
    overall_status === 'CRITICAL' 
      ? t('admin.monitoring.statusCritical')
      : overall_status === 'WARN'
        ? t('admin.monitoring.statusWarn')
        : t('admin.monitoring.statusOk');

  // Invariant Matrix Columns
  const invariantColumns: ColumnDef<AdminInvariantStatus>[] = [
    {
      id: 'id',
      header: t('admin.monitoring.colInvariantId'),
      cell: (item) => (
        <span className="font-mono font-bold text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.06] text-slate-700 dark:text-slate-200">
          {item.id}
        </span>
      ),
    },
    {
      id: 'name',
      header: t('admin.monitoring.colInvariantName'),
      cell: (item) => (
        <div className="font-medium text-xs text-slate-800 dark:text-white">
          {item.name}
        </div>
      ),
    },
    {
      id: 'status',
      header: t('admin.monitoring.colInvariantStatus'),
      cell: (item) => {
        const isPass = item.passed === true;
        const variant: StatusVariant = isPass ? 'online' : 'danger';
        const label = isPass 
          ? t('admin.monitoring.statusPass') 
          : t('admin.monitoring.statusFail');
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge status={variant} label={label} size="sm" />
            <span className="sr-only">{item.id} is {label}</span>
          </div>
        );
      },
    },
    {
      id: 'last_evaluated_at',
      header: t('admin.monitoring.colInvariantEvaluated'),
      cell: (item) => (
        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
          {formatDateTime(item.last_evaluated_at)}
        </span>
      ),
    },
    {
      id: 'summary',
      header: t('admin.monitoring.colInvariantSummary'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
          {item.safe_summary || '—'}
        </span>
      ),
    },
  ];

  // Observation History Columns
  const historyColumns: ColumnDef<AdminObservationRecord>[] = [
    {
      id: 'timestamp',
      header: t('admin.monitoring.colTimestamp'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
          {formatDateTime(item.timestamp)}
        </span>
      ),
    },
    {
      id: 'overall_result',
      header: t('admin.monitoring.colOverallResult'),
      cell: (item) => (
        <StatusBadge 
          status={item.all_invariants_pass ? 'online' : 'danger'}
          label={item.all_invariants_pass ? 'PASS' : 'FAIL'}
          size="sm"
        />
      ),
    },
    {
      id: 'load_average',
      header: t('admin.monitoring.colLoadAvg'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
          {Array.isArray(item.loadavg) && item.loadavg.length > 0
            ? item.loadavg[0].toFixed(2)
            : '—'}
        </span>
      ),
    },
    {
      id: 'active_socket_leases',
      header: t('admin.monitoring.colActiveLeases'),
      cell: (item) => (
        <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-200">
          {item.active_socket_leases ?? 0}
        </span>
      ),
    },
    {
      id: 'outbox_pending',
      header: t('admin.monitoring.colPending'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
          {item.outbox_pending ?? 0}
        </span>
      ),
    },
    {
      id: 'dead_letter',
      header: t('admin.monitoring.colDeadLetters'),
      cell: (item) => (
        <span className={`text-xs font-mono font-semibold ${
          (item.dead_letter || 0) > 0 ? 'text-[#EA5455]' : 'text-slate-600 dark:text-slate-400'
        }`}>
          {item.dead_letter ?? 0}
        </span>
      ),
    },
    {
      id: 'backend_rss_mb',
      header: t('admin.monitoring.colBackendRss'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
          {item.backend_rss_mb != null ? `${item.backend_rss_mb.toFixed(1)} MB` : '—'}
        </span>
      ),
    },
    {
      id: 'gateway_rss_mb',
      header: t('admin.monitoring.colGatewayRss'),
      cell: (item) => (
        <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
          {item.gateway_rss_mb != null ? `${item.gateway_rss_mb.toFixed(1)} MB` : '—'}
        </span>
      ),
    },
  ];

  const progressPercent = Math.min(100, Math.max(0, observation.progress_percent ?? 0));
  const isSystemMonitorActive = system_monitor.timer_status === 'active';
  const isWaObserverActive = whatsapp_observer.timer_status === 'active';

  return (
    <AdminShell
      title={t('admin.monitoring.title')}
      subtitle={t('admin.monitoring.subtitle')}
      badge={<StatusBadge status={overallBadgeVariant} label={overallBadgeText} size="md" />}
      onRefresh={() => fetchMonitoring(false)}
      isRefreshing={refreshing}
      lastUpdated={lastUpdated}
    >
      <div className="space-y-6">
        {/* Read-Only Notice Banner */}
        <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300">
          <Info className="w-4 h-4 text-[#7367F0] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold text-slate-800 dark:text-white">
              {t('admin.monitoring.readOnlyNotice')}
            </span>
            <p className="text-slate-500 dark:text-slate-400">
              {t('admin.monitoring.zeroSessionsNotice')}
            </p>
          </div>
        </div>

        {/* Operational Attention Reasons if WARN or CRITICAL */}
        {overall_status_reasons && overall_status_reasons.length > 0 && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs space-y-1.5">
            <div className="flex items-center gap-2 font-bold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{t('admin.attention')}</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-amber-900/80 dark:text-amber-300/80 pl-1 font-mono text-[11px]">
              {overall_status_reasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* SECTION: WHATSAPP LONG-RUN OBSERVATION WINDOW */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-[#7367F0]" />
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.monitoring.observationWindow')}
                </CardTitle>
              </div>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96] mt-0.5">
                {t('admin.monitoring.observationWindowSubtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge
                status={observation.observation_status === 'OBSERVATION_WINDOW_INCOMPLETE' ? 'warning' : 'online'}
                label={
                  observation.observation_status === 'OBSERVATION_WINDOW_INCOMPLETE'
                    ? t('admin.monitoring.stateIncomplete')
                    : observation.observation_status === 'WHATSAPP_LONG_RUN_PARTIAL'
                      ? t('admin.monitoring.statePartial')
                      : observation.observation_status
                }
                size="md"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-5 space-y-6">
            {/* Progress Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {t('admin.monitoring.obsProgress')}
                </span>
                <span className="font-mono font-bold text-[#7367F0] dark:text-[#A59DF8]">
                  {progressPercent.toFixed(1)}%
                </span>
              </div>
              <div className="w-full h-3 rounded-full bg-slate-100 dark:bg-white/[0.06] overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-[#7367F0] to-[#28C76F] transition-all duration-500 rounded-full"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Metrics 4-Col Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-[#7E7F96] block uppercase tracking-wider">
                  {t('admin.monitoring.obsElapsed')}
                </span>
                <span className="text-lg font-bold font-mono text-slate-800 dark:text-white mt-1 block">
                  {observation.elapsed_seconds != null 
                    ? formatDuration(observation.elapsed_seconds) 
                    : (observation.observed_duration || '—')}
                </span>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-[#7E7F96] block uppercase tracking-wider">
                  {t('admin.monitoring.obsTarget')}
                </span>
                <span className="text-lg font-bold font-mono text-slate-800 dark:text-white mt-1 block">
                  {observation.target_seconds != null 
                    ? formatDuration(observation.target_seconds) 
                    : observation.target_duration}
                </span>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-[#7E7F96] block uppercase tracking-wider">
                  {t('admin.monitoring.obsRemaining')}
                </span>
                <span className="text-lg font-bold font-mono text-slate-800 dark:text-white mt-1 block">
                  {formatDuration(observation.remaining_seconds)}
                </span>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-[#7E7F96] block uppercase tracking-wider">
                  {t('admin.monitoring.obsSampleCount')}
                </span>
                <span className="text-lg font-bold font-mono text-[#7367F0] dark:text-[#A59DF8] mt-1 block">
                  {observation.sample_count}
                </span>
              </div>
            </div>

            {/* Timestamps & Notice */}
            <div className="pt-2 border-t border-slate-100 dark:border-white/[0.06] flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <span className="font-semibold text-slate-600 dark:text-slate-300">{t('admin.monitoring.obsBaselineTime')}: </span>
                  <span className="font-mono">{formatDateTime(observation.baseline_timestamp)}</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-600 dark:text-slate-300">{t('admin.monitoring.obsLatestTime')}: </span>
                  <span className="font-mono">{formatDateTime(observation.latest_observation_timestamp)}</span>
                </div>
              </div>
              <div className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{t('admin.monitoring.verifiedNotice')}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* SECTION: TIMERS GRID */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Card 1: System Monitor Timer */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Activity className="w-5 h-5 text-[#28C76F]" />
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.monitoring.systemMonitorTimer')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    tezlify-monitor.timer
                  </p>
                </div>
              </div>
              <StatusBadge
                status={isSystemMonitorActive ? 'online' : 'danger'}
                label={isSystemMonitorActive ? t('admin.monitoring.timerActive') : t('admin.monitoring.timerInactive')}
                size="sm"
              />
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerInterval')}</span>
                  <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                    {system_monitor.interval || 'every 3m'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerLastRun')}</span>
                  <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                    {formatDateTime(system_monitor.latest_run)}
                  </span>
                </div>
              </div>
              {!isSystemMonitorActive && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 text-[11px] text-red-700 dark:text-red-300 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-[#EA5455]" />
                  <span>{t('admin.monitoring.timerWarningInactive')}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Card 2: WhatsApp Reliability Observer */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.monitoring.waObserverTimer')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    tezlify-wa-observer.timer
                  </p>
                </div>
              </div>
              <StatusBadge
                status={isWaObserverActive ? 'online' : 'danger'}
                label={isWaObserverActive ? t('admin.monitoring.timerActive') : t('admin.monitoring.timerInactive')}
                size="sm"
              />
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerInterval')}</span>
                  <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                    {whatsapp_observer.interval || 'every 5m'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerLastRun')}</span>
                  <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                    {formatDateTime(whatsapp_observer.latest_run)}
                  </span>
                </div>
              </div>
              {!isWaObserverActive && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 text-[11px] text-red-700 dark:text-red-300 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-[#EA5455]" />
                  <span>{t('admin.monitoring.timerWarningInactive')}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* SECTION: INVARIANT SUMMARY STATS */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatsCard
            title={t('admin.monitoring.passing')}
            value={passingInvariants}
            subText={t('admin.monitoring.statusPass')}
            icon={CheckCircle2}
            iconVariant="success"
          />
          <StatsCard
            title={t('admin.monitoring.failing')}
            value={failingInvariants}
            subText={t('admin.monitoring.statusFail')}
            icon={ShieldAlert}
            iconVariant="danger"
          />
          <StatsCard
            title={t('admin.monitoring.unknown')}
            value={unknownInvariants}
            subText={t('admin.monitoring.unknown')}
            icon={AlertTriangle}
            iconVariant="warning"
          />
          <StatsCard
            title={t('admin.monitoring.total')}
            value={`${passingInvariants} / ${totalInvariants}`}
            subText={t('admin.monitoring.invariantsTitle')}
            icon={ShieldCheck}
            iconVariant="primary"
          />
        </div>

        {/* SECTION: R1-R13 INVARIANT MATRIX */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.monitoring.invariantsTitle')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.monitoring.invariantsSubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0 p-0">
            <DataTable<AdminInvariantStatus>
              data={invariants}
              columns={invariantColumns}
              rowKey={(item) => item.id}
            />
          </CardContent>
        </Card>

        {/* SECTION: OBSERVATION HISTORY */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.monitoring.historyTitle')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.monitoring.historySubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0 p-0">
            <DataTable<AdminObservationRecord>
              data={recent_observations}
              columns={historyColumns}
              rowKey={(item) => item.timestamp}
              emptyState={

                <div className="p-8 text-center text-slate-400 dark:text-[#7E7F96] space-y-2">
                  <Inbox className="w-8 h-8 mx-auto text-slate-300 dark:text-white/20" />
                  <p className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                    {t('admin.monitoring.emptyHistoryTitle')}
                  </p>
                  <p className="text-xs">
                    {t('admin.monitoring.emptyHistoryDesc')}
                  </p>
                </div>
              }
            />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
};
