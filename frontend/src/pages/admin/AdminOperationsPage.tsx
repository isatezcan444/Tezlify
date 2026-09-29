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
import { Card, CardContent } from '../../components/ui/card';
import { ServiceStatusPanel } from '../../components/admin/ops/ServiceStatusPanel';
import { OpsLogsPanel } from '../../components/admin/ops/OpsLogsPanel';
import { OpsHistoryPanel } from '../../components/admin/ops/OpsHistoryPanel';
import { ErrorFeed } from '../../components/admin/ops/ErrorFeed';
import { OverviewPanel } from '../../components/admin/ops/OverviewPanel';
import { useOpsEvents } from '../../hooks/useOpsEvents';
import type {
  AdminOverviewResponse,
  OpsCatalogueEntry,
  OpsOperation,
  OpsServiceStatus,
  OpsStatusResponse,
} from '../../types/admin';

type OpsTab = 'overview' | 'system' | 'errors' | 'logs' | 'history';

const OPS_TABS: { id: OpsTab; key: string }[] = [
  { id: 'overview', key: 'admin.ops.tabOverview' },
  { id: 'system', key: 'admin.ops.tabSystem' },
  { id: 'errors', key: 'admin.ops.tabErrors' },
  { id: 'logs', key: 'admin.ops.tabLogs' },
  { id: 'history', key: 'admin.ops.tabHistory' },
];

export const AdminOperationsPage: React.FC = () => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();
  const toast = useToast();
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const [tab, setTab] = useState<OpsTab>('overview');
  const [status, setStatus] = useState<OpsStatusResponse | null>(null);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [logService, setLogService] = useState<string>('gateway');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsByService, setLogsByService] = useState<Record<string, string[]>>({});
  const [opLogs, setOpLogs] = useState<OpsOperation | null>(null);
  const [lastUpdated, setLastUpdated] = useState('');
  const busyRef = useRef(false);

  const fetchStatus = useCallback(async (isInitial = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (isInitial) setLoading(true);
    try {
      setStatus(await OpsApi.getStatus(20));
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());
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
  }, [status?.running?.id, fetchStatus, realtimeConnected]);

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

  // Seed the error feed once so it is not empty on first visit.
  useEffect(() => {
    if (!showAdmin) return;
    void fetchLogs('gateway');
  }, [showAdmin, fetchLogs]);

  const runOperation = useCallback(async (entry: OpsCatalogueEntry) => {
    if (entry.destructive) {
      const ok = await toast.confirm({
        title: t('admin.ops.confirmTitle'),
        message: entry.name.startsWith('deploy')
          ? t('admin.ops.confirmDeployBody')
          : t('admin.ops.confirmRestartBody'),
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

  const services = status?.services || [];
  const serviceNames = useMemo(
    () => services.map((s: OpsServiceStatus) => s.name.replace('tezlify-', '')),
    [services],
  );
  const logTabs = serviceNames.length > 0 ? serviceNames : ['gateway'];

  if (!showAdmin) {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">
              {t('admin.accessDeniedTitle')}
            </p>
          </CardContent>
        </Card>
      </div>
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
            'px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors cursor-pointer ' +
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

  return (
    <AdminShell
      title={t('admin.ops.title')}
      subtitle={t('admin.ops.subtitle')}
      lastUpdated={lastUpdated}
      isRefreshing={loading}
      onRefresh={() => void fetchStatus(false)}
    >
      {tabBar}
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
                  {opLogs.logs.length
                    ? opLogs.logs.slice(-200).join('\n')
                    : t('admin.ops.noData')}
                </pre>
              </CardContent>
            </Card>
          )}
          <OpsHistoryPanel
            operations={status?.operations || []}
            audit={status?.audit || []}
          />
        </div>
      )}
    </AdminShell>
  );
};
