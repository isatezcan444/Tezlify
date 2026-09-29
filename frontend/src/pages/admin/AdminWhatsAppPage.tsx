import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Radio, 
  Layers, 
  Send, 
  ShieldAlert, 
  CheckCircle2, 
  AlertTriangle,
  ArrowLeft,
  Smartphone,
  RefreshCw,
  Info
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { 
  AdminWhatsAppResponse, 
  AdminWhatsAppSessionSummary,
  OverallSystemStatus 
} from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';
import { DataTable, ColumnDef } from '../../components/data-display/DataTable';
import { ServiceStatusPanel } from '../../components/admin/ops/ServiceStatusPanel';
import { OpsLogsPanel } from '../../components/admin/ops/OpsLogsPanel';
import { OpsHistoryPanel } from '../../components/admin/ops/OpsHistoryPanel';
import { ErrorFeed } from '../../components/admin/ops/ErrorFeed';
import { OpsApi } from '../../api/admin';
import { useToast } from '../../context/ToastContext';
import {
  OpsAuditEntry,
  OpsCatalogueEntry,
  OpsOperation,
  OpsServiceStatus,
  OpsStatusResponse,
} from '../../types/admin';

type OpsTab = 'session' | 'system' | 'errors' | 'logs' | 'operations';

const OPS_TABS: { id: OpsTab; key: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'session', key: 'admin.ops.tabSession', icon: Smartphone },
  { id: 'system', key: 'admin.ops.tabSystem', icon: Radio },
  { id: 'errors', key: 'admin.ops.tabErrors', icon: ShieldAlert },
  { id: 'logs', key: 'admin.ops.tabLogs', icon: Layers },
  { id: 'operations', key: 'admin.ops.tabDeployment', icon: Send },
];

interface AdminWhatsAppPageProps {
  onNavigate?: (tab: string) => void;
}

export const AdminWhatsAppPage: React.FC<AdminWhatsAppPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminWhatsAppResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  // ---- Operations Center state ------------------------------------------
  // Kept separate from the WhatsApp read model on purpose: opening the panel
  // must not trigger a WhatsApp history/contact/avatar sync (§ performance).
  const toast = useToast();
  const [opsTab, setOpsTab] = useState<OpsTab>('system');
  const [opsStatus, setOpsStatus] = useState<OpsStatusResponse | null>(null);
  const [opsLoading, setOpsLoading] = useState<boolean>(false);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [logService, setLogService] = useState<string>('gateway');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [logsByService, setLogsByService] = useState<Record<string, string[]>>({});
  const [opLogs, setOpLogs] = useState<OpsOperation | null>(null);

  const opsRefreshing = useRef<boolean>(false);

  const fetchOpsStatus = useCallback(async (isInitial = false) => {
    if (opsRefreshing.current) return;
    opsRefreshing.current = true;
    if (isInitial) setOpsLoading(true);
    try {
      const res = await OpsApi.getStatus(20);
      setOpsStatus(res);
      setOpsError(null);
    } catch (err: any) {
      setOpsError(err?.message || t('common.error'));
    } finally {
      if (isInitial) setOpsLoading(false);
      opsRefreshing.current = false;
    }
  }, [t]);

  // Poll only the lightweight status endpoint, and only while the tab is
  // visible. Logs are fetched on demand, never in a loop.
  useEffect(() => {
    if (!showAdmin) return;
    void fetchOpsStatus(true);
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void fetchOpsStatus(false);
    }, 15000);
    return () => clearInterval(id);
  }, [showAdmin, fetchOpsStatus]);

  // Follow a running operation by id: the server keeps working after a tab
  // close or refresh, so re-attaching is the normal path, not an edge case.
  useEffect(() => {
    const running = opsStatus?.running;
    if (!running) {
      setOpLogs(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const fresh = await OpsApi.getOperation(running.id);
        if (cancelled) return;
        setOpLogs(fresh);
        if (fresh.status === 'running') setTimeout(poll, 3000);
        else void fetchOpsStatus(false);
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [opsStatus?.running?.id, fetchOpsStatus]);

  const fetchLogs = useCallback(async (service: string) => {
    setLogService(service);
    setLogsLoading(true);
    try {
      const res = await OpsApi.getLogs(service, 200);
      setLogs(res.lines);
      setLogsByService((prev) => ({ ...prev, [service]: res.lines }));
      setOpsError(null);
    } catch (err: any) {
      setOpsError(err?.message || t('common.error'));
    } finally {
      setLogsLoading(false);
    }
  }, [t]);

  // Load the gateway buffer on first visit so the error feed is not empty.
  useEffect(() => {
    if (!showAdmin) return;
    if (Object.keys(logsByService).length === 0) void fetchLogs('gateway');
  }, [showAdmin, logsByService, fetchLogs]);

  const runOperation = useCallback(async (entry: OpsCatalogueEntry) => {
    // Confirmation is mandatory for destructive operations. The server enforces
    // this too — the dialog is a safety rail, not the control.
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
      await fetchOpsStatus(false);
    } catch (err: any) {
      toast.error(err?.message || t('common.error'), entry.label);
    } finally {
      setBusyName(null);
    }
  }, [toast, t, fetchOpsStatus]);

  const fetchingRef = useRef<boolean>(false);

  const fetchWhatsApp = useCallback(async (isInitial = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    if (isInitial) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await AdminApi.getWhatsApp();
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

    void fetchWhatsApp(true);

    const intervalId = setInterval(() => {
      // Pause polling if the tab is hidden
      if (document.visibilityState === 'hidden') return;
      void fetchWhatsApp(false);
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchWhatsApp(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showAdmin, fetchWhatsApp]);

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
          <CardContent className="pt-4">
            <Button
              variant="default"
              size="sm"
              onClick={() => void fetchWhatsApp(true)}
              className="flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              {t('admin.retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Calculate Overall Status
  let overallStatus: OverallSystemStatus = 'OK';
  if (data) {
    if (!data.gateway_bridge.connected) {
      overallStatus = 'CRITICAL';
    } else if (
      data.socket_leases.duplicate_count > 0 ||
      data.socket_leases.stale_count > 0 ||
      data.db_session_summary.relink_required > 0
    ) {
      overallStatus = 'WARN';
    }
  }

  // Helper date formatter
  const formatDateTime = (dateStr?: string | null) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? dateStr : d.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  // Helper status badge mapper
  const renderSessionStatusBadge = (status: string) => {
    switch (status) {
      case 'CONNECTED':
        return <StatusBadge status="online" label={t('admin.whatsapp.statusConnected')} size="sm" />;
      case 'SCAN_QR':
        return <StatusBadge status="warning" label={t('admin.whatsapp.statusScanQr')} size="sm" />;
      case 'RELINK_REQUIRED':
        return <StatusBadge status="danger" label={t('admin.whatsapp.statusRelinkRequired')} size="sm" />;
      case 'CONNECTING':
        return <StatusBadge status="pending" label={t('admin.whatsapp.statusConnecting')} size="sm" />;
      case 'RESTORING':
        return <StatusBadge status="info" label={t('admin.whatsapp.statusRestoring')} size="sm" />;
      case 'BANNED':
        return <StatusBadge status="danger" label={t('admin.whatsapp.statusBanned')} size="sm" />;
      case 'ERROR':
        return <StatusBadge status="failed" label={t('admin.whatsapp.statusError')} size="sm" />;
      case 'UNAVAILABLE':
        return <StatusBadge status="neutral" label={t('admin.whatsapp.statusUnavailable')} size="sm" />;
      case 'DISCONNECTED':
        return <StatusBadge status="offline" label={t('admin.whatsapp.statusDisconnected')} size="sm" />;
      default:
        return <StatusBadge status="neutral" label={status || t('admin.whatsapp.statusUnknown')} size="sm" />;
    }
  };

  // DataTable Column Definitions
  const columns: ColumnDef<AdminWhatsAppSessionSummary>[] = [
    {
      id: 'id',
      header: t('admin.whatsapp.colId'),
      cell: (item) => (
        <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
          #{item.id}
        </span>
      ),
      width: '80px',
    },
    {
      id: 'session_name',
      header: t('admin.whatsapp.colSessionName'),
      cell: (item) => (
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-slate-400 shrink-0" />
          <span className="font-medium text-xs text-slate-800 dark:text-white truncate max-w-[140px]">
            {item.session_name}
          </span>
        </div>
      ),
    },
    {
      id: 'phone_number_masked',
      header: t('admin.whatsapp.colPhone'),
      cell: (item) => (
        <span className="font-mono text-xs font-medium text-slate-600 dark:text-slate-300">
          {item.phone_number_masked || '—'}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('admin.whatsapp.colStatus'),
      cell: (item) => renderSessionStatusBadge(item.status),
    },
    {
      id: 'is_phone_online',
      header: t('admin.whatsapp.colOnline'),
      cell: (item) => (
        <StatusBadge 
          status={item.is_phone_online ? 'online' : 'offline'}
          label={item.is_phone_online ? t('admin.whatsapp.phoneOnline') : t('admin.whatsapp.phoneOffline')}
          size="sm"
        />
      ),
    },
    {
      id: 'is_active',
      header: t('admin.whatsapp.colActive'),
      cell: (item) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${
          item.is_active 
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40' 
            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
        }`}>
          {item.is_active ? t('common.active') : t('common.inactive')}
        </span>
      ),
    },
    {
      id: 'updated_at',
      header: t('admin.whatsapp.colUpdatedAt'),
      cell: (item) => (
        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
          {formatDateTime(item.updated_at)}
        </span>
      ),
    },
  ];


  // ---- Operations Center tab bar ----------------------------------------
  const opsTabBar = (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {OPS_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = opsTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setOpsTab(tab.id)}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap ' +
              'transition-colors cursor-pointer ' +
              (active
                ? 'bg-vuexy-primary text-white shadow-sm'
                : 'bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/[0.1]')
            }
          >
            <Icon className="w-3.5 h-3.5" />
            {t(tab.key)}
          </button>
        );
      })}
    </div>
  );

  const serviceNames = (opsStatus?.services || []).map((s: OpsServiceStatus) =>
    s.name.replace('tezlify-', ''),
  );
  const logServiceTabs = serviceNames.length > 0 ? serviceNames : ['gateway'];

  const opsTabContent = (() => {
    if (opsError && !opsStatus) {
      return (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-rose-600 dark:text-rose-400">{opsError}</p>
          </CardContent>
        </Card>
      );
    }
    if (opsTab === 'session') {
      // The pre-existing WhatsApp session view (bridge, sessions, outbox) is
      // unchanged; the operations tabs are additive.
      return null;
    }
    if (opsTab === 'system') {
      return (
        <div className="space-y-6">
          <ServiceStatusPanel
            services={opsStatus?.services || []}
            health={opsStatus?.health || null}
            catalogue={opsStatus?.catalogue || []}
            loading={opsLoading && !opsStatus}
            running={opsStatus?.running || null}
            busyName={busyName}
            onRun={runOperation}
          />
        </div>
      );
    }
    if (opsTab === 'errors') {
      return (
        <ErrorFeed
          logsByService={logsByService}
          catalogue={opsStatus?.catalogue || []}
          runningName={opsStatus?.running?.name || null}
          onRun={runOperation}
          onViewLogs={(svc) => { void fetchLogs(svc); setOpsTab('logs'); }}
        />
      );
    }
    if (opsTab === 'logs') {
      return (
        <OpsLogsPanel
          services={logServiceTabs}
          activeService={logService}
          lines={logs}
          loading={logsLoading}
          error={opsError}
          onServiceChange={(svc) => void fetchLogs(svc)}
          onReload={() => void fetchLogs(logService)}
        />
      );
    }
    return (
      <div className="space-y-6">
        {opLogs && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-slate-800 dark:text-white">
                {opLogs.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 dark:bg-[#0F1222] p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300">
                {opLogs.logs.length ? opLogs.logs.slice(-200).join('\n') : t('admin.ops.noData')}
              </pre>
            </CardContent>
          </Card>
        )}
        <OpsHistoryPanel
          operations={opsStatus?.operations || []}
          audit={opsStatus?.audit || []}
        />
      </div>
    );
  })();

  const overallBadgeStatus: StatusVariant = 
    overallStatus === 'CRITICAL' ? 'danger' : overallStatus === 'WARN' ? 'warning' : 'active';
  const overallBadgeLabel = 
    overallStatus === 'CRITICAL' ? t('admin.statusCritical') : overallStatus === 'WARN' ? t('admin.statusWarn') : t('admin.statusOk');

  return (
    <AdminShell
      title={t('admin.whatsapp.title')}
      subtitle={t('admin.whatsapp.subtitle')}
      badge={
        <StatusBadge
          status={overallBadgeStatus}
          label={overallBadgeLabel}
          pulse={overallStatus !== 'OK'}
          size="sm"
        />
      }
      lastUpdated={lastUpdated}
      isRefreshing={refreshing}
      onRefresh={() => void fetchWhatsApp(false)}
    >
      {opsTabBar}
      {opsTabContent}
      {opsTab === 'session' && (
      <div className="space-y-6">
        {/* Read-only Advisory Banner */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-800/40 text-xs text-indigo-700 dark:text-indigo-300">
          <Info className="w-4 h-4 shrink-0" />
          <span>{t('admin.whatsapp.readOnlyNotice')}</span>
        </div>

        {/* 1. Gateway Bridge & Runtime Card */}
        <Card className="bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <Radio className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <CardTitle className="text-sm font-semibold text-slate-800 dark:text-white">
                    {t('admin.whatsapp.gatewayBridge')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
                    {t('admin.whatsapp.gatewaySubtitle')}
                  </p>
                </div>
              </div>

              {loading ? (
                <Skeleton className="h-6 w-28 rounded-full" />
              ) : (
                <StatusBadge 
                  status={data?.gateway_bridge.connected ? 'online' : 'danger'}
                  label={data?.gateway_bridge.connected 
                    ? t('admin.whatsapp.bridgeConnected') 
                    : t('admin.whatsapp.bridgeDisconnected')
                  }
                  size="sm"
                />
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.reconnectCount')}
                    </span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200 font-mono">
                      {data?.gateway_bridge.reconnect_count ?? 0}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.gatewayHealth')}
                    </span>
                    <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 uppercase font-mono">
                      {data?.gateway_runtime.health_status ?? 'unknown'}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.lastConnected')}
                    </span>
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      {formatDateTime(data?.gateway_bridge.last_connected_at)}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.lastEvent')}
                    </span>
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      {formatDateTime(data?.gateway_bridge.last_event_at)}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] italic">
                  💡 {t('admin.whatsapp.gatewayBridgeNote')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2. Session Fleet Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard
            title={t('admin.whatsapp.totalSessions')}
            value={loading ? '...' : String(data?.db_session_summary.total ?? 0)}
            subText="Database Registered"
            icon={Smartphone}
            iconVariant="primary"
          />
          <StatsCard
            title={t('admin.whatsapp.connectedSessions')}
            value={loading ? '...' : String(data?.db_session_summary.connected ?? 0)}
            subText="Live & Online"
            icon={CheckCircle2}
            iconVariant="success"
          />
          <StatsCard
            title={t('admin.whatsapp.scanQrSessions')}
            value={loading ? '...' : String(data?.db_session_summary.scan_qr ?? 0)}
            subText="Awaiting Authentication"
            icon={AlertTriangle}
            iconVariant="warning"
          />
          <StatsCard
            title={t('admin.whatsapp.relinkRequiredSessions')}
            value={loading ? '...' : String(data?.db_session_summary.relink_required ?? 0)}
            subText="Session Key Expired"
            icon={ShieldAlert}
            iconVariant="danger"
          />
        </div>

        {/* 3. Socket Ownership & Leases Card */}
        <Card className="bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <CardTitle className="text-sm font-semibold text-slate-800 dark:text-white">
                    {t('admin.whatsapp.socketOwnership')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
                    {t('admin.whatsapp.socketOwnershipSubtitle')}
                  </p>
                </div>
              </div>

              {loading ? (
                <Skeleton className="h-6 w-24 rounded-full" />
              ) : (
                <StatusBadge
                  status={
                    (data?.socket_leases.duplicate_count ?? 0) > 0 || (data?.socket_leases.stale_count ?? 0) > 0
                      ? 'warning'
                      : 'active'
                  }
                  label={
                    (data?.socket_leases.duplicate_count ?? 0) > 0 || (data?.socket_leases.stale_count ?? 0) > 0
                      ? t('admin.whatsapp.socketStatusWarning')
                      : t('admin.whatsapp.socketStatusNormal')
                  }
                  size="sm"
                />
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <div className="grid grid-cols-3 gap-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                    {t('admin.whatsapp.activeLeases')}
                  </span>
                  <span className="text-base font-bold text-slate-800 dark:text-white font-mono">
                    {data?.socket_leases.active_count ?? 0}
                  </span>
                </div>

                <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                    {t('admin.whatsapp.duplicateLeases')}
                  </span>
                  <span className={`text-base font-bold font-mono ${
                    (data?.socket_leases.duplicate_count ?? 0) > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-white'
                  }`}>
                    {data?.socket_leases.duplicate_count ?? 0}
                  </span>
                </div>

                <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                    {t('admin.whatsapp.staleLeases')}
                  </span>
                  <span className={`text-base font-bold font-mono ${
                    (data?.socket_leases.stale_count ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-white'
                  }`}>
                    {data?.socket_leases.stale_count ?? 0}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 4. Message Pipeline (Outbox / Retry / Dead Letter) */}
        <Card className="bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <Send className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <div>
                <CardTitle className="text-sm font-semibold text-slate-800 dark:text-white">
                  {t('admin.whatsapp.messagePipeline')}
                </CardTitle>
                <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
                  {t('admin.whatsapp.pipelineSubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.delivered')}
                    </span>
                    <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                      {(data?.outbox.delivered ?? 0).toLocaleString()}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.pending')}
                    </span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300 font-mono">
                      {(data?.outbox.pending ?? 0).toLocaleString()}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.inFlight')}
                    </span>
                    <span className="text-sm font-bold text-indigo-600 dark:text-indigo-400 font-mono">
                      {(data?.outbox.in_flight ?? 0).toLocaleString()}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.deadLetters')}
                    </span>
                    <span className={`text-sm font-bold font-mono ${
                      (data?.outbox.dead_letter ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'
                    }`}>
                      {(data?.outbox.dead_letter ?? 0).toLocaleString()}
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                    <span className="text-slate-400 dark:text-[#7E7F96] block mb-1">
                      {t('admin.whatsapp.retryBacklog')}
                    </span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300 font-mono">
                      {(data?.retry.retry_backlog ?? 0).toLocaleString()}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] italic">
                  ℹ️ {t('admin.whatsapp.deadLetterNote')}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 5. WhatsApp Sessions Fleet Table */}
        <Card className="bg-white dark:bg-[#2F3349] border-slate-200/80 dark:border-white/[0.08] shadow-sm overflow-hidden">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Smartphone className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <CardTitle className="text-sm font-semibold text-slate-800 dark:text-white">
                    {t('admin.whatsapp.sessionsTableTitle')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
                    {t('admin.whatsapp.sessionsTableSubtitle')}
                  </p>
                </div>
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
                {data?.sessions.length ?? 0} {t('admin.whatsapp.totalSessions')}
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<AdminWhatsAppSessionSummary>
              columns={columns}
              data={data?.sessions || []}
              loading={loading}
              rowKey={(item) => item.id}
              emptyState={
                <div className="py-12 px-4 text-center">
                  <Smartphone className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                  <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">
                    {t('admin.whatsapp.emptySessionsTitle')}
                  </h4>
                  <p className="text-xs text-slate-400 dark:text-slate-500 max-w-md mx-auto">
                    {t('admin.whatsapp.emptySessionsDesc')}
                  </p>
                </div>
              }
            />
          </CardContent>
        </Card>
      </div>
      )}
    </AdminShell>
  );
};
