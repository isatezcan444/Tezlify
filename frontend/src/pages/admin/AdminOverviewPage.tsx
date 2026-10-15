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
  Smartphone,
  ChevronDown,
  ChevronUp,
  Terminal,
  Activity,
  Layers,
  Wrench,
  Radio,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { AdminOverviewResponse, AdminWhatsAppResponse, AdminBackupsResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminOverviewPageProps {
  onNavigate?: (tab: string) => void;
}

const formatUptime = (raw?: string, isTr = true): string => {
  if (!raw) return '—';
  let cleaned = raw.replace(/^up\s+/i, '').trim();
  if (isTr) {
    cleaned = cleaned
      .replace(/(\d+)\s*days?/gi, '$1 gün')
      .replace(/(\d+)\s*hours?/gi, '$1 sa')
      .replace(/(\d+)\s*(?:minutes?|mins?)/gi, '$1 dk')
      .replace(/(\d+)\s*(?:seconds?|secs?)/gi, '$1 sn');
  } else {
    cleaned = cleaned
      .replace(/(\d+)\s*days?/gi, '$1d')
      .replace(/(\d+)\s*hours?/gi, '$1h')
      .replace(/(\d+)\s*(?:minutes?|mins?)/gi, '$1m')
      .replace(/(\d+)\s*(?:seconds?|secs?)/gi, '$1s');
  }
  return cleaned;
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
    });
  } catch {
    return isoString;
  }
};

export const AdminOverviewPage: React.FC<AdminOverviewPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [waData, setWaData] = useState<AdminWhatsAppResponse | null>(null);
  const [backupData, setBackupData] = useState<AdminBackupsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [showInfraDetails, setShowInfraDetails] = useState<boolean>(false);

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchOverview = useCallback(async (isInitial = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    if (isInitial) setLoading(true);
    else setRefreshing(true);

    try {
      const [overviewRes, waRes, backupRes] = await Promise.allSettled([
        AdminApi.getOverview(),
        AdminApi.getWhatsApp(),
        AdminApi.getBackups(),
      ]);

      if (overviewRes.status === 'fulfilled') {
        setData(overviewRes.value);
        setError(null);
      } else {
        const err = overviewRes.reason;
        if (err?.message === 'ACCESS_DENIED') {
          setError('ACCESS_DENIED');
        } else {
          setError(err?.message || t('admin.errorDesc'));
        }
      }

      if (waRes.status === 'fulfilled') {
        setWaData(waRes.value);
      }

      if (backupRes.status === 'fulfilled') {
        setBackupData(backupRes.value);
      }

      const now = new Date();
      setLastUpdated(now.toLocaleTimeString());
    } catch (err: any) {
      setError(err?.message || t('admin.errorDesc'));
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

  // 2. Loading State
  if (loading && !data) {
    return (
      <AdminShell
        title={t('nav.adminOverview')}
        subtitle={t('titles.adminOverviewSub')}
        isRefreshing={true}
      >
        <div className="space-y-6">
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
        title={t('nav.adminOverview')}
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
  const overallVariant: StatusVariant =
    data.overall_status === 'OK' ? 'online' : data.overall_status === 'WARN' ? 'warning' : 'danger';

  const overallLabel =
    data.overall_status === 'OK'
      ? t('admin.statusOk')
      : data.overall_status === 'WARN'
      ? t('admin.statusWarn')
      : t('admin.statusCritical');

  // WhatsApp connection facts
  const isWaBridgeConnected = waData?.gateway_bridge.connected ?? true;
  const waConnectedCount = waData?.db_session_summary.connected ?? 0;
  const waTotalCount = waData?.db_session_summary.total ?? 0;

  // Backup facts
  const latestBackupTime = backupData?.postgres.created_at;
  const latestBackupSize = backupData?.postgres.size_human;

  // Action resolution
  const hasIssues = data.overall_status !== 'OK';
  const issueDescription = (() => {
    if (!hasIssues) return t('admin.overviewAnswers.issueNone');
    const reasons = data.overall_status_reasons || [];
    if (reasons.length > 0) {
      return reasons[0].replace(/\(\/var\/run\/[^\)]+\)/g, '').trim();
    }
    if (data.system.reboot_required) {
      return t('admin.rebootRequiredHelp');
    }
    return t('admin.executiveAttentionBody');
  })();

  const recommendedActionTarget = (() => {
    if (!isWaBridgeConnected || (waData?.db_session_summary.scan_qr ?? 0) > 0) {
      return { tab: 'admin-whatsapp', label: t('admin.overviewAnswers.quickWhatsApp') };
    }
    if (hasIssues) {
      return { tab: 'admin-operations', label: t('admin.overviewAnswers.quickOps') };
    }
    return null;
  })();

  const getServiceDisplayName = (name: string): string => {
    if (name.includes('backend')) return t('admin.serviceBackend');
    if (name.includes('gateway')) return t('admin.serviceGateway');
    if (name.includes('caddy')) return t('admin.serviceCaddy');
    if (name.includes('db')) return t('admin.serviceDb');
    return name;
  };

  return (
    <AdminShell
      title={t('nav.adminOverview')}
      subtitle={t('titles.adminOverviewSub')}
      lastUpdated={lastUpdated}
      onRefresh={() => void fetchOverview(false)}
      isRefreshing={refreshing}
      badge={<StatusBadge status={overallVariant} label={overallLabel} size="md" />}
    >
      <div className="space-y-6">
        {/* A. GENEL BAKIŞ — 5 TEMEL SORU KARTI */}
        <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardHeader className="p-5 sm:p-6 border-b border-slate-100 dark:border-white/[0.06] flex flex-row items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base font-extrabold text-slate-800 dark:text-white flex items-center gap-2.5">
                <Activity className="w-5 h-5 text-[#7367F0]" />
                <span>{t('admin.executiveGuidanceTitle')}</span>
              </CardTitle>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96] mt-0.5">
                {t('admin.executiveGuidanceSubtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Durum:</span>
              <StatusBadge status={overallVariant} label={overallLabel} size="sm" />
            </div>
          </CardHeader>

          <CardContent className="p-5 sm:p-6 space-y-5">
            {/* 4 Answers Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Soru 1: Sistem çalışıyor mu? */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                    <Server className="w-4 h-4 text-[#7367F0]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      {t('admin.overviewAnswers.systemStatus')}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-slate-800 dark:text-white mt-2">
                    {data.overall_status === 'OK'
                      ? t('admin.overviewAnswers.systemStatusOk')
                      : data.overall_status === 'WARN'
                      ? t('admin.overviewAnswers.systemStatusWarn')
                      : t('admin.overviewAnswers.systemStatusCritical')}
                  </div>
                </div>
                <div className="pt-2 text-[11px] text-slate-400">
                  {data.containers.filter((c) => c.status.toLowerCase() === 'running').length} / {data.containers.length} servis aktif
                </div>
              </div>

              {/* Soru 2: WhatsApp bağlantısı sağlıklı mı? */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                    <Smartphone className="w-4 h-4 text-[#28C76F]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      {t('admin.overviewAnswers.whatsAppStatus')}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-slate-800 dark:text-white mt-2">
                    {isWaBridgeConnected ? (
                      waConnectedCount > 0 ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {t('admin.overviewAnswers.whatsAppOk', { count: waConnectedCount })}
                        </span>
                      ) : (
                        <span>{t('admin.overviewAnswers.whatsAppNoSession')}</span>
                      )
                    ) : (
                      <span className="text-rose-500 font-bold">
                        {t('admin.overviewAnswers.whatsAppDown')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="pt-2 text-[11px] text-slate-400">
                  Toplam {waTotalCount} kayıtlı oturum
                </div>
              </div>

              {/* Soru 3: Son yedekleme ne zaman? */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                    <Database className="w-4 h-4 text-[#FF9F43]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      {t('admin.overviewAnswers.lastBackupTime')}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-slate-800 dark:text-white mt-2">
                    {latestBackupTime ? (
                      formatDateTime(latestBackupTime)
                    ) : (
                      <span className="text-slate-400">{t('admin.overviewAnswers.lastBackupNone')}</span>
                    )}
                  </div>
                </div>
                <div className="pt-2 text-[11px] text-slate-400">
                  {latestBackupSize ? `Boyut: ${latestBackupSize}` : 'Otomatik plan devrede'}
                </div>
              </div>

              {/* Soru 4: Müdahale gerektiren bir sorun var mı? */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                    <ShieldCheck className="w-4 h-4 text-[#00CFE8]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">
                      {t('admin.overviewAnswers.issueStatus')}
                    </span>
                  </div>
                  <div className={`text-xs font-bold mt-2 line-clamp-2 ${hasIssues ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {issueDescription}
                  </div>
                </div>
                <div className="pt-2 text-[11px] text-slate-400">
                  {hasIssues ? 'İnceleme önerilir' : 'Sistem stabil'}
                </div>
              </div>
            </div>

            {/* Quick Action Navigation Bar */}
            <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                <strong>{t('admin.overviewAnswers.actionNeeded')}:</strong>{' '}
                <span>
                  {recommendedActionTarget
                    ? issueDescription
                    : t('admin.overviewAnswers.actionNone')}
                </span>
              </div>

              <div className="flex items-center gap-2.5 flex-wrap w-full sm:w-auto justify-end">
                {onNavigate && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onNavigate('admin-whatsapp')}
                      className="text-xs font-semibold gap-1.5 h-8.5 cursor-pointer border-slate-200 dark:border-white/[0.08]"
                    >
                      <Smartphone className="w-3.5 h-3.5 text-emerald-500" />
                      <span>{t('admin.overviewAnswers.quickWhatsApp')}</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onNavigate('admin-operations')}
                      className="text-xs font-semibold gap-1.5 h-8.5 cursor-pointer border-slate-200 dark:border-white/[0.08]"
                    >
                      <Wrench className="w-3.5 h-3.5 text-indigo-500" />
                      <span>{t('admin.overviewAnswers.quickOps')}</span>
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onNavigate('admin-backups')}
                      className="text-xs font-semibold gap-1.5 h-8.5 bg-[#7367F0] hover:bg-[#685dd8] text-white cursor-pointer shadow-xs"
                    >
                      <Database className="w-3.5 h-3.5" />
                      <span>{t('admin.overviewAnswers.quickBackup')}</span>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* B. SECONDARY COLLAPSIBLE SECTION: CPU, RAM, Disk, Containers & DB details */}
        <div className="border border-slate-200/80 dark:border-white/[0.06] rounded-2xl bg-white dark:bg-[#2F3349] overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => setShowInfraDetails((prev) => !prev)}
            className="w-full p-4 sm:p-5 flex items-center justify-between text-left hover:bg-slate-50/60 dark:hover:bg-white/[0.02] transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 flex items-center justify-center">
                <Server className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800 dark:text-white">
                  {showInfraDetails
                    ? t('admin.overviewAnswers.hideInfraDetails')
                    : t('admin.overviewAnswers.showInfraDetails')}
                </h3>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  İşlemci yükü, RAM, disk kullanımı, konteyner bellekleri ve veritabanı bağlantı havuzu
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <span>{showInfraDetails ? t('admin.monitoring.hideDetails') : t('admin.monitoring.showDetails')}</span>
              {showInfraDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showInfraDetails && (
            <div className="p-5 border-t border-slate-100 dark:border-white/[0.06] space-y-6 animate-fade-in">
              {/* System Resource Cards (4-col grid) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                  subText={`${t('admin.ramUsedPercent', { percent: ((data.system.memory_used_mb / Math.max(1, data.system.memory_total_mb)) * 100).toFixed(0) })}`}
                  icon={Server}
                  iconVariant="info"
                />

                {/* Disk */}
                <StatsCard
                  title={t('admin.disk')}
                  value={`${data.system.disk_used_percent}%`}
                  subText={`${data.system.disk_used_gb} GB / ${data.system.disk_total_gb} GB`}
                  icon={HardDrive}
                  iconVariant="warning"
                />

                {/* Uptime & Reboot */}
                <StatsCard
                  title={t('admin.hostUptime')}
                  value={formatUptime(data.system.uptime, true)}
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

              {/* Production Services Fleet Cards */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-indigo-500" />
                  <span>{t('admin.productionServices')} ({data.containers.length})</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {data.containers.map((c) => {
                    const isRunning = c.status.toLowerCase() === 'running';
                    return (
                      <div
                        key={c.name}
                        className="p-3 rounded-xl border border-slate-100 dark:border-white/[0.04] bg-slate-50/50 dark:bg-white/[0.02] flex flex-col justify-between space-y-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="font-bold text-slate-800 dark:text-white block truncate">
                              {getServiceDisplayName(c.name)}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400 block">
                              {c.name}
                            </span>
                          </div>
                          <StatusBadge
                            status={isRunning ? 'online' : 'danger'}
                            label={isRunning ? t('admin.statusRunning') : c.status}
                            size="sm"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-[10px] border-t border-slate-100 dark:border-white/[0.04] pt-2 text-slate-500">
                          <div>Bellek: <strong className="text-slate-700 dark:text-slate-300">{c.rss_mb} MB</strong></div>
                          <div>Restart: <strong className="text-slate-700 dark:text-slate-300">{c.restart_count}</strong></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Database Connection Pool Metrics */}
              <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04] flex items-center justify-between flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-2.5">
                  <Database className="w-4 h-4 text-[#7367F0]" />
                  <div>
                    <span className="font-bold text-slate-800 dark:text-white block">PostgreSQL 17 Havuzu</span>
                    <span className="text-[11px] text-slate-400">Veritabanı boyutu: {data.database.database_size_mb} MB</span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-slate-600 dark:text-slate-300 font-medium">
                  <div>Aktif: <strong className="text-emerald-600 dark:text-emerald-400 font-bold">{data.database.connections_active}</strong></div>
                  <div>Boşta: <strong className="font-bold">{data.database.connections_idle}</strong></div>
                  <div>Toplam: <strong className="font-bold">{data.database.connections_total} / 100</strong></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
};
