import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Layers, 
  Send, 
  ShieldAlert, 
  AlertTriangle,
  ArrowLeft,
  Smartphone,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { 
  AdminWhatsAppResponse, 
  AdminWhatsAppSessionSummary,
} from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';
import { DataTable, ColumnDef } from '../../components/data-display/DataTable';
import { AdminActionIssueCard } from '../../components/admin/AdminActionIssueCard';

interface AdminWhatsAppPageProps {
  onNavigate?: (tab: string) => void;
}

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
    });
  } catch {
    return isoString;
  }
};

export const AdminWhatsAppPage: React.FC<AdminWhatsAppPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminWhatsAppResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [showAdvancedLeases, setShowAdvancedLeases] = useState<boolean>(false);

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'ACCESS_DENIED') {
        setError('ACCESS_DENIED');
      } else {
        setError(msg || t('admin.errorDesc'));
      }
    } finally {
      if (isInitial) setLoading(false);
      setRefreshing(false);
      fetchingRef.current = false;
    }
  }, [t]);

  useEffect(() => {
    if (!showAdmin) {
      setLoading(false);
      return;
    }

    void fetchWhatsApp(true);

    const intervalId = setInterval(() => {
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

  // 1. Access Denied Guard
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
                className="flex items-center gap-2 cursor-pointer"
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

  // 2. Error State
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
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('admin.errorDesc')}</p>
            <div className="flex items-center gap-3">
              <Button
                variant="default"
                size="sm"
                onClick={() => fetchWhatsApp(true)}
                disabled={refreshing}
                className="flex items-center gap-2 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                {t('admin.retry')}
              </Button>
              {onNavigate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('admin-overview')}
                  className="flex items-center gap-2 cursor-pointer"
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

  // 3. Loading Skeleton
  if (loading && !data) {
    return (
      <AdminShell
        title={t('nav.adminWhatsApp')}
        subtitle={t('admin.whatsapp.subtitle')}
        isRefreshing={true}
      >
        <div className="space-y-6">
          <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] p-6 space-y-4">
            <Skeleton className="h-6 w-48 rounded-md" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          </Card>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </AdminShell>
    );
  }

  if (!data) return null;

  const isBridgeConnected = data.gateway_bridge.connected;
  const connectedCount = data.db_session_summary.connected;
  const totalCount = data.db_session_summary.total;
  const scanQrCount = data.db_session_summary.scan_qr;
  const relinkCount = data.db_session_summary.relink_required;

  const overallBadgeVariant: StatusVariant = !isBridgeConnected
    ? 'danger'
    : relinkCount > 0
    ? 'warning'
    : 'online';

  const overallBadgeLabel = !isBridgeConnected
    ? t('admin.whatsapp.bridgeDisconnected')
    : relinkCount > 0
    ? t('admin.whatsapp.statusRelinkRequired')
    : t('admin.whatsapp.bridgeConnected');

  // Table columns
  const columns: ColumnDef<AdminWhatsAppSessionSummary>[] = [
    {
      id: 'session_name',
      header: t('admin.whatsapp.colSessionName'),
      accessorKey: 'session_name',
      cell: (item) => (
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Smartphone className="w-3.5 h-3.5" />
          </div>
          <div>
            <span className="font-semibold text-slate-800 dark:text-slate-100 block text-xs">
              {item.session_name}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              ID #{item.id}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: 'phone_number_masked',
      header: t('admin.whatsapp.colPhone'),
      accessorKey: 'phone_number_masked',
      cell: (item) => (
        <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-200">
          {item.phone_number_masked || '—'}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('admin.whatsapp.colStatus'),
      accessorKey: 'status',
      cell: (item) => {
        const isOnline = item.status?.toUpperCase() === 'CONNECTED';
        const isQr = item.status?.toUpperCase() === 'SCAN_QR';
        const isRelink = item.status?.toUpperCase() === 'RELINK_REQUIRED';

        const variant: StatusVariant = isOnline ? 'online' : isQr ? 'warning' : isRelink ? 'danger' : 'offline';
        const label = isOnline
          ? t('admin.whatsapp.statusConnected')
          : isQr
          ? t('admin.whatsapp.statusScanQr')
          : isRelink
          ? t('admin.whatsapp.statusRelinkRequired')
          : item.status;

        return <StatusBadge status={variant} label={label} size="sm" />;
      },
    },
    {
      id: 'updated_at',
      header: t('admin.whatsapp.colUpdatedAt'),
      accessorKey: 'updated_at',
      cell: (item) => (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {formatDateTime(item.updated_at)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: () => (
        onNavigate ? (
          <Button
            variant="ghost"
            onClick={() => onNavigate('whatsapp')}
            className="text-xs font-semibold text-[#7367F0] hover:text-[#685dd8] bg-[#7367F0]/10 hover:bg-[#7367F0]/20 gap-1.5 h-8 px-2.5 rounded-lg flex items-center justify-center cursor-pointer transition-colors active:scale-[0.98]"
          >
            <span>{t('common.manage')}</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        ) : null
      ),
    },
  ];

  return (
    <AdminShell
      title={t('nav.adminWhatsApp')}
      subtitle={t('admin.whatsapp.subtitle')}
      badge={<StatusBadge status={overallBadgeVariant} label={overallBadgeLabel} size="md" />}
      lastUpdated={lastUpdated}
      isRefreshing={refreshing}
      onRefresh={() => void fetchWhatsApp(false)}
    >
      <div className="space-y-6">
        {/* 1. HERO CONNECTION CARD — PLAIN, HUMAN-CENTRIC */}
        <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardContent className="p-5 sm:p-7 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-extrabold text-slate-800 dark:text-white tracking-tight">
                    {t('admin.whatsapp.gatewayBridge')}
                  </h2>
                  <StatusBadge status={overallBadgeVariant} label={overallBadgeLabel} size="sm" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {isBridgeConnected
                    ? t('admin.whatsapp.bridgeConnectedDesc', { connected: connectedCount, total: totalCount })
                    : t('admin.whatsapp.bridgeDisconnectedDesc')}
                </p>
              </div>

              {/* Primary Action Button to Manage / Connect Sessions */}
              {onNavigate && (
                <div className="w-full sm:w-auto shrink-0">
                  <Button
                    variant="default"
                    onClick={() => onNavigate('whatsapp')}
                    className="w-full sm:w-auto h-10 px-5 bg-gradient-to-r from-[#7367F0] to-[#867BFF] hover:from-[#685dd8] hover:to-[#766bf3] text-white font-bold text-xs sm:text-sm shadow-xs hover:shadow-md shadow-[#7367F0]/30 rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.98]"
                  >
                    <Smartphone className="w-4 h-4 text-white" />
                    <span>{t('admin.whatsapp.manageSessionsBtn')}</span>
                  </Button>
                </div>
              )}
            </div>

            {/* Standard Issue Card if Gateway Bridge is Disconnected */}
            {!isBridgeConnected && (
              <AdminActionIssueCard
                title={t('admin.whatsapp.gatewayDisconnectedTitle')}
                description={t('admin.whatsapp.gatewayDisconnectedDesc')}
                severity="critical"
                statusLabel={t('admin.whatsapp.criticalOutage')}
                impact={t('admin.whatsapp.gatewayDisconnectedImpact')}
                recommendedAction={t('admin.whatsapp.gatewayDisconnectedAction')}
                primaryAction={{
                  label: t('admin.whatsapp.retryConnection'),
                  onClick: () => void fetchWhatsApp(false),
                  loading: refreshing,
                  icon: RefreshCw,
                }}
                secondaryAction={onNavigate ? {
                  label: t('admin.whatsapp.goToOperations'),
                  onClick: () => onNavigate('admin-operations'),
                } : undefined}
              />
            )}

            {/* Standard Issue Card if sessions need QR action */}
            {isBridgeConnected && (scanQrCount > 0 || relinkCount > 0) && (
              <AdminActionIssueCard
                title={relinkCount > 0 ? t('admin.whatsapp.sessionEndedTitle') : t('admin.whatsapp.qrScanPendingTitle')}
                description={
                  relinkCount > 0
                    ? t('admin.whatsapp.sessionEndedDesc', { count: relinkCount })
                    : t('admin.whatsapp.qrScanPendingDesc', { count: scanQrCount })
                }
                severity="warning"
                statusLabel={t('admin.whatsapp.pairingRequired')}
                impact={t('admin.whatsapp.sessionEndedImpact')}
                recommendedAction={t('admin.whatsapp.sessionEndedAction')}
                primaryAction={onNavigate ? {
                  label: t('admin.whatsapp.openWhatsAppHub'),
                  onClick: () => onNavigate('whatsapp'),
                  icon: Smartphone,
                } : undefined}
              />
            )}

            {/* Clean Sessions Summary Cards (4 blocks) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <span className="text-[11px] font-semibold uppercase text-slate-400 block tracking-wider">
                  {t('admin.whatsapp.connectedSessions')}
                </span>
                <span className="text-xl font-extrabold text-emerald-600 dark:text-emerald-400 font-mono block">
                  {connectedCount}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('admin.whatsapp.subLiveOnline')}
                </span>
              </div>

              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <span className="text-[11px] font-semibold uppercase text-slate-400 block tracking-wider">
                  {t('admin.whatsapp.scanQrSessions')}
                </span>
                <span className={`text-xl font-extrabold font-mono block ${scanQrCount > 0 ? 'text-amber-500' : 'text-slate-700 dark:text-slate-200'}`}>
                  {scanQrCount}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('admin.whatsapp.subAwaitingAuth')}
                </span>
              </div>

              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <span className="text-[11px] font-semibold uppercase text-slate-400 block tracking-wider">
                  {t('admin.whatsapp.relinkRequiredSessions')}
                </span>
                <span className={`text-xl font-extrabold font-mono block ${relinkCount > 0 ? 'text-rose-500' : 'text-slate-700 dark:text-slate-200'}`}>
                  {relinkCount}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('admin.whatsapp.subSessionExpired')}
                </span>
              </div>

              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1">
                <span className="text-[11px] font-semibold uppercase text-slate-400 block tracking-wider">
                  {t('admin.whatsapp.totalSessions')}
                </span>
                <span className="text-xl font-extrabold text-slate-800 dark:text-white font-mono block">
                  {totalCount}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('admin.whatsapp.subDbRegistered')}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2. MESSAGE PIPELINE & PLAIN EXPLANATION */}
        <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <Send className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                  {t('admin.whatsapp.messagePipeline')}
                </CardTitle>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.whatsapp.pipelineSubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block mb-1">
                  {t('admin.whatsapp.delivered')}
                </span>
                <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                  {(data.outbox.delivered ?? 0).toLocaleString()}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block mb-1">
                  {t('admin.whatsapp.pending')}
                </span>
                <span className="text-lg font-bold text-slate-700 dark:text-slate-200 font-mono">
                  {(data.outbox.pending ?? 0).toLocaleString()}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block mb-1">
                  {t('admin.whatsapp.inFlight')}
                </span>
                <span className="text-lg font-bold text-[#7367F0] font-mono">
                  {(data.outbox.in_flight ?? 0).toLocaleString()}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block mb-1">
                  {t('admin.whatsapp.deadLetters')}
                </span>
                <span className={`text-lg font-bold font-mono ${
                  (data.outbox.dead_letter ?? 0) > 0 ? 'text-amber-500' : 'text-slate-700 dark:text-slate-200'
                }`}>
                  {(data.outbox.dead_letter ?? 0).toLocaleString()}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed bg-slate-50/70 dark:bg-white/[0.02] p-3 rounded-xl border border-slate-100 dark:border-white/[0.03]">
              💡 <strong>Bilgi:</strong> {t('admin.whatsapp.deadLetterNote')} WhatsApp hesabı olmayan veya engelli numaralar kalıcı hata durumunda hatta zarar vermemek adına güvenle kenara ayrılır.
            </p>
          </CardContent>
        </Card>

        {/* 3. SESSIONS FLEET TABLE */}
        <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardHeader className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Smartphone className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                  {t('admin.whatsapp.sessionsTableTitle')}
                </CardTitle>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.whatsapp.sessionsTableSubtitle')}
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              {data.sessions.length} oturum
            </span>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto min-w-0">
            <DataTable<AdminWhatsAppSessionSummary>
              columns={columns}
              data={data.sessions || []}
              loading={loading}
              rowKey={(item) => item.id}
              emptyState={
                <div className="py-12 px-4 text-center">
                  <Smartphone className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
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

        {/* 4. COLLAPSIBLE ADVANCED SECTION: Socket Ownership, Leases & Runtime */}
        <div className="border border-slate-200/80 dark:border-white/[0.06] rounded-2xl bg-white dark:bg-[#2F3349] overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => setShowAdvancedLeases((prev) => !prev)}
            className="w-full min-h-[48px] p-3.5 sm:p-4 flex items-center justify-between text-left hover:bg-slate-50/60 dark:hover:bg-white/[0.02] transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 flex items-center justify-center">
                <Layers className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800 dark:text-white">
                  {showAdvancedLeases
                    ? t('admin.whatsapp.hideAdvancedDetails')
                    : t('admin.whatsapp.showAdvancedDetails')}
                </h3>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.whatsapp.advancedDetailsSubtitle')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <span>{showAdvancedLeases ? t('admin.monitoring.hideDetails') : t('admin.monitoring.showDetails')}</span>
              {showAdvancedLeases ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showAdvancedLeases && (
            <div className="p-5 border-t border-slate-100 dark:border-white/[0.06] space-y-4 animate-fade-in text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-[10px] text-slate-400 block mb-1 uppercase tracking-wider">
                    {t('admin.whatsapp.activeLeases')}
                  </span>
                  <span className="text-base font-bold text-slate-800 dark:text-white font-mono">
                    {data.socket_leases.active_count ?? 0}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-[10px] text-slate-400 block mb-1 uppercase tracking-wider">
                    {t('admin.whatsapp.duplicateLeases')}
                  </span>
                  <span className="text-base font-bold text-slate-800 dark:text-white font-mono">
                    {data.socket_leases.duplicate_count ?? 0}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04]">
                  <span className="text-[10px] text-slate-400 block mb-1 uppercase tracking-wider">
                    {t('admin.whatsapp.reconnectCount')}
                  </span>
                  <span className="text-base font-bold text-slate-800 dark:text-white font-mono">
                    {data.gateway_bridge.reconnect_count ?? 0}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-500">
                <div>Son Bağlantı: <strong className="text-slate-700 dark:text-slate-300 font-mono">{formatDateTime(data.gateway_bridge.last_connected_at)}</strong></div>
                <div>Son Olay: <strong className="text-slate-700 dark:text-slate-300 font-mono">{formatDateTime(data.gateway_bridge.last_event_at)}</strong></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
};
