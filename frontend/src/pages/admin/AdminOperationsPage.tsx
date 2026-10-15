/**
 * Server Operations Center — service control, logs, errors and history.
 *
 * WHY THIS IS ITS OWN PAGE
 * ------------------------
 * Restarting a container, redeploying code and restarting the database are not
 * WhatsApp operations. They were briefly hosted as tabs inside the WhatsApp
 * admin page, which made the page header lie about what its controls did and
 * put destructive server actions one click away from a page an operator opens
 * to check their messages. This page owns everything that changes the SERVER;
 * the WhatsApp page is read-only and stays about WhatsApp.
 *
 * Code-affecting operations (pull / build / deploy) deliberately live on the
 * separate Deployment page instead: they are a different risk class from a
 * service restart, and mixing them here would blur that distinction.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { useToast } from '../../context/ToastContext';
import { AdminApi, OpsApi } from '../../api/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, ShieldAlert, X, XCircle, Terminal, Layers, AlertTriangle, Server } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { ServiceStatusPanel } from '../../components/admin/ops/ServiceStatusPanel';
import { OpsLogsPanel } from '../../components/admin/ops/OpsLogsPanel';
import { formatBytes } from '../../components/admin/ops/formatBytes';
import { formatOpsDateTime } from '../../components/admin/ops/formatDate';
import { OpsHistoryPanel } from '../../components/admin/ops/OpsHistoryPanel';
import { ErrorFeed } from '../../components/admin/ops/ErrorFeed';
import { OverviewPanel } from '../../components/admin/ops/OverviewPanel';
import { useOpsEvents } from '../../hooks/useOpsEvents';
import type {
  AdminOverviewResponse,
  AdminWhatsAppResponse,
  AdminDeploymentResponse,
  OpsCatalogueEntry,
  OpsOperation,
  OpsServiceStatus,
  OpsStatusResponse,
} from '../../types/admin';

type OpsTab = 'overview' | 'system' | 'deployment' | 'errors' | 'logs' | 'history';

const OPS_TABS: { id: OpsTab; key: string }[] = [
  { id: 'overview', key: 'admin.ops.tabOverview' },
  { id: 'system', key: 'admin.ops.tabSystem' },
  { id: 'deployment', key: 'admin.ops.tabDeployment' },
  { id: 'errors', key: 'admin.ops.tabErrors' },
  { id: 'logs', key: 'admin.ops.tabLogs' },
  { id: 'history', key: 'admin.ops.tabHistory' },
];

// Stable empty fallback: a literal `[]` in render would be a new reference each
// time and would invalidate every memo downstream of it.
const EMPTY_SERVICES: OpsServiceStatus[] = [];

interface AdminOperationsPageProps {
  onNavigate?: (tab: string) => void;
}

export const AdminOperationsPage: React.FC<AdminOperationsPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();
  const toast = useToast();
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const [tab, setTab] = useState<OpsTab>('overview');
  const [status, setStatus] = useState<OpsStatusResponse | null>(null);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [whatsappRuntime, setWhatsappRuntime] = useState<
    AdminWhatsAppResponse['gateway_runtime'] | null
  >(null);
  // The WhatsApp runtime block is the only place the gateway reports an
  // ORPHANED session (connected, but its DB row is gone). It lives on the
  // admin WhatsApp payload, which this page already has access to through the
  // read-only admin API, so no new call and no new endpoint is needed.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [logService, setLogService] = useState<string>('gateway');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsByService, setLogsByService] = useState<Record<string, string[]>>({});
  const [opLogs, setOpLogs] = useState<OpsOperation | null>(null);
  const [dismissedOpId, setDismissedOpId] = useState<string | null>(null);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [lastUpdated, setLastUpdated] = useState('');
  const [deployment, setDeployment] = useState<AdminDeploymentResponse | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const busyRef = useRef(false);

  const fetchDeployment = useCallback(async () => {
    setDeploymentLoading(true);
    try {
      const res = await AdminApi.getDeployment();
      setDeployment(res);
    } catch {
      // Non-fatal
    } finally {
      setDeploymentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'deployment' && !deployment) {
      void fetchDeployment();
    }
  }, [tab, deployment, fetchDeployment]);

  // History paging + filtering. The panel used to show a fixed newest-20
  // window, so "what did we deploy last Tuesday" was unanswerable even though
  // the record was retained.
  const HISTORY_PAGE = 20;
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyStatus, setHistoryStatus] = useState('ALL');
  const [historyName, setHistoryName] = useState('');
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyRows, setHistoryRows] = useState<OpsOperation[] | null>(null);

  const fetchStatus = useCallback(async (isInitial = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (isInitial) setLoading(true);
    try {
      setStatus(await OpsApi.getStatus(20));
      setError(null);
      setLastUpdated(formatOpsDateTime(new Date()));
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      if (isInitial) setLoading(false);
      busyRef.current = false;
    }
  }, [t]);

  const fetchOverview = useCallback(async () => {
    try {
      setOverview(await AdminApi.getOverview());
    } catch {
      // The overview degrades to service-only data; the page still works.
    }
    // The WhatsApp payload carries the gateway runtime block, which is where an
    // ORPHANED session is reported. Fetched alongside the overview so the
    // warning does not need its own request.
    try {
      setWhatsappRuntime((await AdminApi.getWhatsApp()).gateway_runtime);
    } catch {
      // Non-fatal: the orphan banner simply does not appear.
    }
  }, []);

  // The server pushes operation lifecycle events on the shared /ws stream, so
  // progress is realtime. Polling stays as a fallback: if the socket cannot be
  // established the operator must still see what is happening.
  const handleEvent = useCallback((op: OpsOperation) => {
    setOpLogs(op);
    setStatus((prev) => {
      if (!prev) return prev;
      const rest = prev.operations.filter((o) => o.id !== op.id);
      return {
        ...prev,
        operations: [op, ...rest].slice(0, 20),
        running: op.status === 'running' ? op : null,
      };
    });
    if (op.status !== 'running') {
      setBusyName(null);
      void fetchStatus(false);
    }
  }, [fetchStatus]);

  const realtimeConnected = useOpsEvents(showAdmin, { onOperation: handleEvent });

  useEffect(() => {
    if (!showAdmin) return;
    void fetchStatus(true);
    void fetchOverview();
    const period = realtimeConnected ? 60000 : 15000;
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void fetchStatus(false);
    }, period);
    return () => clearInterval(id);
  }, [showAdmin, fetchStatus, fetchOverview, realtimeConnected]);

  // Re-attach to an operation started elsewhere or before a refresh.
  useEffect(() => {
    const running = status?.running;
    if (!running || realtimeConnected) {
      if (!running) setOpLogs(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const fresh = await OpsApi.getOperation(running.id);
        if (cancelled) return;
        setOpLogs(fresh);
        if (fresh.status === 'running') setTimeout(poll, 3000);
        else void fetchStatus(false);
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [status?.running, fetchStatus, realtimeConnected]);


  // Paged history is fetched separately from the status poll: the poll carries
  // a small newest-first window for context, while this is the full, filterable
  // record an operator actually reads.
  const fetchHistory = useCallback(async () => {
    try {
      const rows = await OpsApi.listOperations({
        limit: HISTORY_PAGE,
        offset: historyOffset,
        status: historyStatus,
        name: historyName,
      });
      setHistoryRows(rows);
      setHistoryTotal(Math.max(rows.length, historyOffset + rows.length));
    } catch {
      // Non-fatal: the panel keeps showing the status poll's window.
    }
  }, [historyOffset, historyStatus, historyName]);

  useEffect(() => {
    if (!showAdmin) return;
    void fetchHistory();
  }, [showAdmin, fetchHistory]);

  // Any filter or page change invalidates the offset: staying on page 3 of a
  // narrower result set shows an empty table and looks like data loss.
  const changeStatusFilter = useCallback((next: string) => {
    setHistoryStatus(next);
    setHistoryOffset(0);
  }, []);
  const changeNameFilter = useCallback((next: string) => {
    setHistoryName(next);
    setHistoryOffset(0);
  }, []);

  const fetchLogs = useCallback(async (service: string) => {
    setLogService(service);
    setLogsLoading(true);
    try {
      const res = await OpsApi.getLogs(service, 200);
      setLogs(res.lines);
      setLogsByService((prev) => ({ ...prev, [service]: res.lines }));
      setError(null);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setLogsLoading(false);
    }
  }, [t]);

  // Seed the logs for all services so the incident engine and error center have complete visibility immediately.
  useEffect(() => {
    if (!showAdmin) return;
    const servicesToSeed = ['gateway', 'backend', 'caddy'];
    void Promise.allSettled(
      servicesToSeed.map(async (svc) => {
        try {
          const res = await OpsApi.getLogs(svc, 200);
          setLogsByService((prev) => ({ ...prev, [svc]: res.lines }));
          if (svc === 'gateway') setLogs(res.lines);
        } catch {
          // Graceful fallback: non-fatal if an individual service log is unreachable
        }
      })
    );
  }, [showAdmin]);

  const runOperation = useCallback(async (entry: OpsCatalogueEntry) => {
    if (entry.destructive) {
      const confirmMsg =
        entry.name.startsWith('deploy')
          ? t('admin.ops.confirmDeployBody')
          : entry.name === 'restart_gateway'
          ? t('admin.ops.confirmRestartGateway')
          : entry.name === 'restart_backend'
          ? t('admin.ops.confirmRestartBackend')
          : entry.name === 'restart_caddy' || entry.name === 'reload_caddy'
          ? t('admin.ops.confirmRestartCaddy')
          : entry.name === 'docker_prune'
          ? t('admin.ops.confirmPrune')
          : t('admin.ops.confirmRestartBody');

      const ok = await toast.confirm({
        title: t('admin.ops.confirmTitle'),
        message: confirmMsg,
        confirmText: t('admin.ops.confirmProceed'),
        cancelText: t('admin.ops.cancel'),
        variant: 'warning',
      });
      if (!ok) return;
    }
    setBusyName(entry.name);
    try {
      await OpsApi.startOperation(entry.name, entry.destructive);
      toast.success(t('admin.ops.operationRunning'), entry.label);
      await fetchStatus(false);
    } catch (err: any) {
      toast.error(err?.message || t('common.error'), entry.label);
    } finally {
      setBusyName(null);
    }
  }, [toast, t, fetchStatus]);

  // `|| []` allocates a NEW array on every render whenever `status` is null or
  // has no services, so it was never referentially stable and defeated the
  // memo entirely. A module-level constant keeps the identity fixed, so the
  // memo actually holds.
  const services = status?.services ?? EMPTY_SERVICES;
  const serviceNames = useMemo(
    () => services.map((s: OpsServiceStatus) => s.name.replace('tezlify-', '')),
    [services],
  );
  const logTabs = serviceNames.length > 0 ? serviceNames : ['gateway'];

  const handleClearLogs = useCallback(async () => {
    const targets = logTabs;
    const ok = await toast.confirm({
      title: t('admin.ops.confirmClearLogsTitle'),
      message: t('admin.ops.confirmClearLogsBody').replace('{services}', targets.join(', ')),
      confirmText: t('admin.ops.confirmClearLogsProceed'),
      cancelText: t('admin.ops.cancel'),
      variant: 'danger',
    });
    if (!ok) return;

    setClearingLogs(true);
    let freed = 0;
    const failed: string[] = [];
    try {
      // Sequential, not parallel: these truncate host files through the docker
      // socket, and firing every service at once gains nothing while making a
      // partial failure much harder to attribute.
      for (const svc of targets) {
        try {
          const res = await OpsApi.clearLogs(svc, true);
          if (res.cleared) freed += res.freed_bytes;
          else failed.push(svc);
        } catch {
          failed.push(svc);
        }
      }
      // Drop the cleared buffers so the panel cannot keep showing lines that
      // no longer exist on disk.
      setLogsByService((prev) => {
        const next = { ...prev };
        for (const svc of targets) next[svc] = [];
        return next;
      });
      await fetchLogs(logService);

      if (failed.length > 0) {
        toast.error(
          t('admin.ops.clearLogsPartial').replace('{services}', failed.join(', ')),
          t('admin.ops.clearLogs'),
        );
      } else {
        toast.success(formatBytes(freed), t('admin.ops.clearLogsDone'));
      }
    } finally {
      setClearingLogs(false);
    }
  }, [toast, t, logTabs, logService, fetchLogs]);

  if (!showAdmin) {
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

  // 1. Initial Loading Skeleton State (Shimmer shine effect, zero mock/dummy flash)
  if (loading && !status) {
    return (
      <AdminShell
        title={t('admin.ops.title')}
        subtitle={t('admin.ops.subtitle')}
        isRefreshing={true}
      >
        <div className="space-y-6">
          {/* Tab bar skeleton */}
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-8 w-24 rounded-lg" />
            ))}
          </div>

          {/* Overview Panel Skeleton */}
          <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 rounded-xl" />
                <div className="space-y-1.5">
                  <Skeleton className="h-5 w-52 rounded-md" />
                  <Skeleton className="h-3.5 w-72 rounded-md" />
                </div>
              </div>
              <Skeleton className="h-4 w-32 rounded-md" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-2">
                  <Skeleton className="h-3 w-20 rounded-md" />
                  <Skeleton className="h-5 w-32 rounded-md" />
                </div>
              ))}
            </div>
          </Card>

          {/* Services list skeleton */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="p-4 bg-white dark:bg-[#2F3349] space-y-3 border border-slate-200/80 dark:border-white/[0.08]">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-28 rounded-md" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-3 w-40 rounded-md" />
              </Card>
            ))}
          </div>
        </div>
      </AdminShell>
    );
  }

  // 2. Error Retry State
  if (error && !status) {
    return (
      <AdminShell
        title={t('admin.ops.title')}
        subtitle={t('admin.ops.subtitle')}
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
            onClick={() => void fetchStatus(true)}
            className="cursor-pointer"
          >
            {t('admin.retry')}
          </Button>
        </Card>
      </AdminShell>
    );
  }

  const tabBar = (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {OPS_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setTab(item.id)}
          className={
            'px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap cursor-pointer ' +
            'transition-all duration-200 ease-out active:scale-[0.97] ' +
            (tab === item.id
              ? 'bg-vuexy-primary text-white shadow-sm'
              : 'bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/[0.1]')
          }
        >
          {t(item.key)}
        </button>
      ))}
      {/* A stale panel must never be mistaken for a live one. */}
      <span
        className={
          'ml-auto pl-2 text-[11px] font-bold whitespace-nowrap ' +
          (realtimeConnected
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400')
        }
        title={t(realtimeConnected ? 'admin.ops.liveHint' : 'admin.ops.pollingHint')}
      >
        {t(realtimeConnected ? 'admin.ops.live' : 'admin.ops.polling')}
      </span>
    </div>
  );

  const activeOp =
    (status?.running || (opLogs && opLogs.status === 'running' ? opLogs : null)) ??
    (opLogs && opLogs.id !== dismissedOpId ? opLogs : null);

  return (
    <AdminShell
      title={t('admin.ops.title')}
      subtitle={t('admin.ops.subtitle')}
      badge={
        <StatusBadge
          status={status?.health?.all_healthy ? 'online' : 'warning'}
          label={status?.health?.all_healthy ? t('admin.ops.healthAllOk') : t('admin.ops.healthSomeDown')}
          size="sm"
        />
      }
      lastUpdated={lastUpdated}
      isRefreshing={loading}
      onRefresh={() => void fetchStatus(false)}
    >
      {tabBar}
      {activeOp && (
        <Card className={`border shadow-sm transition-all duration-200 ${
          activeOp.status === 'running'
            ? 'border-vuexy-primary/40 bg-vuexy-primary/[0.04]'
            : activeOp.status === 'succeeded'
            ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
            : 'border-rose-500/40 bg-rose-500/[0.04]'
        }`}>
          <CardContent className="pt-3.5 pb-3.5 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5 min-w-0">
                {activeOp.status === 'running' ? (
                  <Loader2 className="w-4 h-4 text-vuexy-primary animate-spin shrink-0" />
                ) : activeOp.status === 'succeeded' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-rose-500 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-800 dark:text-white truncate">
                      {activeOp.label}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      activeOp.status === 'running'
                        ? 'bg-vuexy-primary/15 text-vuexy-primary'
                        : activeOp.status === 'succeeded'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                    }`}>
                      {activeOp.status === 'running'
                        ? t('admin.ops.runningOperationBadge')
                        : activeOp.status === 'succeeded'
                        ? t('admin.ops.operationSucceeded')
                        : t('admin.ops.operationFailed')}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {activeOp.status === 'running'
                      ? t('admin.ops.activeOpBannerDesc')
                      : activeOp.status === 'succeeded'
                      ? t('admin.ops.completedOpSuccess')
                      : t('admin.ops.completedOpFailed')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {tab !== 'history' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTab('history')}
                    className="text-xs cursor-pointer h-7"
                  >
                    {t('admin.ops.tabHistory')}
                  </Button>
                )}
                {activeOp.status !== 'running' && (
                  <button
                    type="button"
                    onClick={() => setDismissedOpId(activeOp.id)}
                    className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded cursor-pointer"
                    title={t('admin.ops.dismissBanner')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {activeOp.logs && activeOp.logs.length > 0 && (
              <pre className="max-h-20 overflow-auto rounded bg-slate-900 text-slate-200 p-2 text-[10px] font-mono whitespace-pre-wrap break-all leading-tight">
                {activeOp.logs.slice(-3).join('\n')}
              </pre>
            )}
          </CardContent>
        </Card>
      )}
      <div key={tab} className="animate-fade-in">
      {error && !status && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          </CardContent>
        </Card>
      )}
      {tab === 'overview' && (
        <OverviewPanel
          overview={overview}
          services={services}
          health={status?.health || null}
          operations={status?.operations || []}
          loading={loading && !status}
          persistenceOk={status?.persistence_ok !== false}
          orphanedCount={whatsappRuntime?.orphaned_count ?? 0}
          orphanedDetail={whatsappRuntime?.orphaned_detail ?? []}
          ghostConnected={whatsappRuntime?.ghost_connected ?? []}
          lastUpdated={lastUpdated}
          hasTelemetryError={Boolean(error && !status)}
          onNavigateTab={(nextTab) => setTab(nextTab)}
        />
      )}
      {tab === 'system' && (
        <div className="space-y-6">
          {error && status && (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
          <ServiceStatusPanel
            services={services}
            health={status?.health || null}
            catalogue={status?.catalogue || []}
            loading={loading && !status}
            running={status?.running || null}
            busyName={busyName}
            onRun={runOperation}
          />
        </div>
      )}
      {tab === 'deployment' && (
        <div className="space-y-6">
          <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] p-5">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100 dark:border-white/[0.06]">
              <div>
                <h3 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <Server className="w-4 h-4 text-[#7367F0]" />
                  <span>{t('admin.deployment.title')}</span>
                </h3>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.deployment.subtitle')}
                </p>
              </div>
              {onNavigate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('admin-deployment')}
                  className="text-xs font-semibold gap-1.5 cursor-pointer"
                >
                  <span>Tam Dağıtım Sayfası</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>

            {deploymentLoading && !deployment ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : deployment ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Aktif Git Dalı & Commit</span>
                    <span className="font-mono text-sm font-bold text-slate-800 dark:text-white block">
                      {(deployment.git?.branch || deployment.branch || 'main')} @ {(deployment.git?.commit_hash || deployment.commit_hash)?.slice(0, 7) || '—'}
                    </span>
                    <span className="text-[11px] text-slate-500 block truncate" title={deployment.git?.commit_message || deployment.commit_message || ''}>
                      {deployment.git?.commit_message || deployment.commit_message || '—'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Dağıtılan Frontend Sürümü</span>
                    <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400 block">
                      {deployment.frontend?.current_release || 'v2.4 Pro'}
                    </span>
                    <span className="text-[11px] text-slate-500 block">
                      {deployment.frontend?.deployed_at || deployment.timestamp}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold block">Sürüm Hazırlığı</span>
                    <span className="text-sm font-bold block text-emerald-600 dark:text-emerald-400">
                      {deployment.release_readiness || 'HAZIR ✓'}
                    </span>
                    <span className="text-[11px] text-slate-500 block">
                      Çalışma Ağacı: {(deployment.git?.working_tree_clean ?? deployment.working_tree_clean) ? 'Temiz' : 'Değişiklik Var'}
                    </span>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-[#28C76F]" />
                    <span>Ortam: <strong>{deployment.distro}</strong> ({deployment.host?.architecture || 'aarch64'}) • Çekirdek: {deployment.kernel}</span>
                  </div>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{deployment.environment.toUpperCase()}</span>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      )}
      {tab === 'errors' && (
        <ErrorFeed
          logsByService={logsByService}
          catalogue={status?.catalogue || []}
          runningName={status?.running?.name || null}
          onRun={runOperation}
          onViewLogs={(svc) => { setTab('logs'); void fetchLogs(svc); }}
        />
      )}
      {tab === 'logs' && (
        <OpsLogsPanel
          services={logTabs}
          activeService={logService}
          lines={logs}
          loading={logsLoading}
          error={error}
          onServiceChange={(svc) => void fetchLogs(svc)}
          onReload={() => void fetchLogs(logService)}
          logsByService={logsByService}
          onClearLogs={() => void handleClearLogs()}
          clearing={clearingLogs}
        />
      )}
      {tab === 'history' && (
        <div className="space-y-6">
          {opLogs && (
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2">
                  {opLogs.label}
                </p>
                <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 dark:bg-[#0F1222] p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300">
                  {opLogs.logs && opLogs.logs.length
                    ? opLogs.logs.slice(-200).join('\n')
                    : t('admin.ops.noData')}
                </pre>
              </CardContent>
            </Card>
          )}
          <OpsHistoryPanel
            operations={historyRows ?? status?.operations ?? []}
            audit={status?.audit || []}
            totalOperations={historyTotal}
            offset={historyOffset}
            pageSize={HISTORY_PAGE}
            onPageChange={setHistoryOffset}
            onStatusFilter={changeStatusFilter}
            onNameFilter={changeNameFilter}
            statusFilter={historyStatus}
          />
        </div>
      )}
      </div>
    </AdminShell>
  );
};
