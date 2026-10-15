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
  Inbox,
  ChevronDown,
  ChevronUp
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
import { ExecutiveGuidanceCard } from '../../components/admin/ExecutiveGuidanceCard';
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
  const [showAdvancedInvariants, setShowAdvancedInvariants] = useState<boolean>(true);
  const [showAdvancedTelemetry, setShowAdvancedTelemetry] = useState<boolean>(false);

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
      <AdminShell
        title={t('admin.monitoring.title')}
        subtitle={t('admin.monitoring.subtitle')}
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
      </AdminShell>
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
      cell: (item) => {
        const match = item.id.match(/^R(1[0-3]|[1-9])(?:_|$)/i);
        const descKey = match ? `admin.monitoring.invR${match[1]}Desc` : null;

        return (
          <div className="space-y-0.5 max-w-md py-0.5">
            <span className="font-semibold text-xs text-slate-800 dark:text-white block">
              {item.name}
            </span>
            {descKey && (
              <span className="text-[11px] text-slate-500 dark:text-slate-400 block leading-snug">
                {t(descKey)}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'status',
      header: t('admin.monitoring.colInvariantStatus'),
      cell: (item) => {
        const isPass = item.passed === true;
        const isFail = item.passed === false;
        const variant: StatusVariant = isPass ? 'online' : isFail ? 'danger' : 'offline';
        const label = isPass
          ? t('admin.monitoring.statusPass')
          : isFail
          ? t('admin.monitoring.statusFail')
          : t('admin.monitoring.unknown');
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
          label={item.all_invariants_pass ? t('admin.monitoring.statusPass') : t('admin.monitoring.statusFail')}
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

  const isWindowComplete =
    observation.observation_status === 'OBSERVATION_WINDOW_COMPLETE' ||
    progressPercent >= 100 ||
    (observation.remaining_seconds != null && observation.remaining_seconds <= 0);

  const failingList = invariants.filter((inv) => !inv.passed);
  const hasDeadLetterFail = failingList.some(
    (inv) => inv.id.includes('dead_letter') || inv.name.toLowerCase().includes('dead letter')
  );

  const businessImpactText =
    failingInvariants === 0
      ? t('admin.guidance.zeroCustomerImpact')
      : hasDeadLetterFail
      ? t('admin.monitoring.impactDeadLetter')
      : `${failingInvariants} ${t('admin.monitoring.failingInvariantsAlert')}`;

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
        <ExecutiveGuidanceCard
          status={overall_status === 'OK' ? 'ok' : overall_status === 'WARN' ? 'warn' : 'critical'}
          badgeLabel={overallBadgeText}
          title={t('admin.monitoring.title')}
          subtitle={t('admin.monitoring.subtitle')}
          currentState={
            overall_status === 'OK'
              ? t('admin.guidance.systemHealthyState')
              : (failingInvariants > 0
                ? `${failingInvariants} ${t('admin.monitoring.failing')} (${t('admin.monitoring.statusFail')})`
                : t('admin.guidance.systemWarningState'))
          }
          severity={{
            level: overall_status === 'OK' ? 'normal' : failingInvariants > 0 ? 'high' : 'medium',
            label: overall_status === 'OK'
              ? t('admin.guidance.severityNormal')
              : failingInvariants > 0
              ? t('admin.guidance.severityHigh')
              : t('admin.guidance.severityMedium'),
            description: failingInvariants > 0
              ? `${failingInvariants} / ${totalInvariants} ${t('admin.monitoring.invariantsTitle')}`
              : t('admin.executiveAllGood'),
          }}
          businessImpact={businessImpactText}
          recommendedAction={{
            label: failingInvariants === 0
              ? t('admin.guidance.noActionNeeded')
              : t('admin.monitoring.actionReviewFailing'),
            description: failingInvariants === 0
              ? t('admin.guidance.noActionNeededDesc')
              : t('admin.monitoring.actionReviewDesc'),
            buttonText: (onNavigate && failingInvariants > 0) ? t('admin.actionGoToOps') : undefined,
            onAction: (onNavigate && failingInvariants > 0) ? () => onNavigate('admin-operations') : undefined,
            icon: ShieldCheck,
          }}
          actionOutcome={
            failingInvariants === 0
              ? t('admin.guidance.noActionOutcome')
              : t('admin.monitoring.actionOutcomeOps')
          }
          technicalDetails={
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.monitoring.passing')}</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">{passingInvariants}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.monitoring.failing')}</span>
                  <span className="font-bold text-rose-600 dark:text-rose-400">{failingInvariants}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.monitoring.unknown')}</span>
                  <span className="font-bold text-amber-600 dark:text-amber-400">{unknownInvariants}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.monitoring.obsSampleCount')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{observation.sample_count}</span>
                </div>
              </div>
            </div>
          }
        />

        {/* Prominent Active Failing Invariant Alert */}
        {failingList.length > 0 && (
          <div className="p-4 rounded-xl bg-rose-50/90 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 font-bold text-rose-700 dark:text-rose-400 text-xs">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{t('admin.monitoring.failingInvariantsBoxTitle')} ({failingList.length})</span>
              </div>
              {onNavigate && (
                <Button
                  variant="outline"
                  onClick={() => onNavigate('admin-operations')}
                  className="h-9 px-3.5 rounded-lg text-xs font-semibold border-rose-200 dark:border-rose-900/50 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40 cursor-pointer flex items-center justify-center active:scale-[0.98]"
                >
                  {t('admin.actionGoToOps')}
                </Button>
              )}
            </div>
            <p className="text-[11px] text-rose-600/90 dark:text-rose-300/80">
              {t('admin.monitoring.failingInvariantsBoxDesc')}
            </p>
            <div className="space-y-2 pt-1">
              {failingList.map((fail) => (
                <div key={fail.id} className="text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2.5 bg-white/70 dark:bg-[#2F3349] p-3 rounded-lg border border-rose-100 dark:border-white/[0.06] shadow-xs">
                  <span className="font-mono font-bold text-rose-600 dark:text-rose-400 shrink-0 text-xs mt-0.5">{fail.id}:</span>
                  <div className="min-w-0 flex-1">
                    <span className="font-bold block text-slate-800 dark:text-white">{fail.name}</span>
                    <span className="text-[11px] text-slate-600 dark:text-slate-300 block mt-0.5">{fail.safe_summary || fail.name}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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
                status={isWindowComplete ? 'online' : observation.observation_status === 'OBSERVATION_WINDOW_INCOMPLETE' ? 'warning' : 'pending'}
                label={
                  isWindowComplete
                    ? t('admin.monitoring.stateVerified')
                    : observation.observation_status === 'OBSERVATION_WINDOW_INCOMPLETE'
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
              <div className="font-medium flex items-center gap-1.5">
                {isWindowComplete ? (
                  <div className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 flex-wrap">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>{t('admin.monitoring.obsWindowCompleteNotice')}</span>
                    {failingInvariants > 0 && (
                      <span className="text-amber-600 dark:text-amber-400 text-[11px] font-normal">
                        ({t('admin.monitoring.obsCertificationPending')})
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 shrink-0" />
                    <span>{t('admin.monitoring.verifiedNotice')}</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

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
            iconVariant={failingInvariants > 0 ? 'danger' : 'secondary'}
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

        {/* SECTION: R1-R13 INVARIANT MATRIX (Collapsible) */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardHeader 
            className="pb-3 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between cursor-pointer select-none"
            onClick={() => setShowAdvancedInvariants((prev) => !prev)}
          >
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white flex items-center gap-2">
                  <span>{t('admin.monitoring.advancedInvariants')}</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
                    {passingInvariants}/{totalInvariants} {t('admin.monitoring.passing')}
                  </span>
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.monitoring.advancedInvariantsSubtitle')}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-white cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowAdvancedInvariants((prev) => !prev);
              }}
            >
              <span>{showAdvancedInvariants ? t('admin.monitoring.hideDetails') : t('admin.monitoring.showDetails')}</span>
              {showAdvancedInvariants ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </CardHeader>
          {showAdvancedInvariants && (
            <CardContent className="pt-0 p-0">
              <DataTable<AdminInvariantStatus>
                data={invariants}
                columns={invariantColumns}
                rowKey={(item) => item.id}
              />
            </CardContent>
          )}
        </Card>

        {/* SECTION: ADVANCED TELEMETRY & TIMERS (Collapsible) */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardHeader 
            className="pb-3 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between cursor-pointer select-none"
            onClick={() => setShowAdvancedTelemetry((prev) => !prev)}
          >
            <div className="flex items-center gap-2.5">
              <Activity className="w-5 h-5 text-[#28C76F]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.monitoring.advancedTelemetry')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.monitoring.advancedTelemetrySubtitle')}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-white cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowAdvancedTelemetry((prev) => !prev);
              }}
            >
              <span>{showAdvancedTelemetry ? t('admin.monitoring.hideDetails') : t('admin.monitoring.showDetails')}</span>
              {showAdvancedTelemetry ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </CardHeader>
          {showAdvancedTelemetry && (
            <CardContent className="pt-5 space-y-6">
              {/* Timers Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* System Monitor Timer */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-200/50 dark:border-white/[0.04]">
                    <div>
                      <span className="text-xs font-bold text-slate-800 dark:text-white block">
                        {t('admin.monitoring.systemMonitorTimer')}
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">tezlify-monitor.timer</span>
                    </div>
                    <StatusBadge
                      status={isSystemMonitorActive ? 'online' : 'danger'}
                      label={isSystemMonitorActive ? t('admin.monitoring.timerActive') : t('admin.monitoring.timerInactive')}
                      size="sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/40 dark:border-white/[0.03]">
                      <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerInterval')}</span>
                      <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                        {system_monitor.interval || 'every 3m'}
                      </span>
                    </div>
                    <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/40 dark:border-white/[0.03]">
                      <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerLastRun')}</span>
                      <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                        {formatDateTime(system_monitor.latest_run)}
                      </span>
                    </div>
                  </div>
                  {!isSystemMonitorActive && (
                    <div className="p-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 text-[11px] text-red-700 dark:text-red-300 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0 text-[#EA5455]" />
                      <span>{t('admin.monitoring.timerWarningInactive')}</span>
                    </div>
                  )}
                </div>

                {/* WhatsApp Observer Timer */}
                <div className="p-4 rounded-xl border border-slate-200 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-200/50 dark:border-white/[0.04]">
                    <div>
                      <span className="text-xs font-bold text-slate-800 dark:text-white block">
                        {t('admin.monitoring.waObserverTimer')}
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">tezlify-wa-observer.timer</span>
                    </div>
                    <StatusBadge
                      status={isWaObserverActive ? 'online' : 'danger'}
                      label={isWaObserverActive ? t('admin.monitoring.timerActive') : t('admin.monitoring.timerInactive')}
                      size="sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/40 dark:border-white/[0.03]">
                      <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerInterval')}</span>
                      <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                        {whatsapp_observer.interval || 'every 5m'}
                      </span>
                    </div>
                    <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/40 dark:border-white/[0.03]">
                      <span className="text-[10px] uppercase font-semibold text-slate-400 block">{t('admin.monitoring.timerLastRun')}</span>
                      <span className="font-mono font-medium text-slate-700 dark:text-slate-200 mt-0.5 block truncate">
                        {formatDateTime(whatsapp_observer.latest_run)}
                      </span>
                    </div>
                  </div>
                  {!isWaObserverActive && (
                    <div className="p-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 text-[11px] text-red-700 dark:text-red-300 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0 text-[#EA5455]" />
                      <span>{t('admin.monitoring.timerWarningInactive')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Observation History Table */}
              <div className="rounded-xl border border-slate-200 dark:border-white/[0.06] overflow-hidden">
                <div className="p-3 bg-slate-50 dark:bg-white/[0.02] border-b border-slate-100 dark:border-white/[0.04] text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <Info className="w-3.5 h-3.5 text-[#7367F0] shrink-0" />
                  <span>{t('admin.monitoring.historyDisclaimer')}</span>
                </div>
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
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </AdminShell>
  );
};
