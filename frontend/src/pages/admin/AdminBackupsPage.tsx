import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database,
  Image,
  FileText,
  HardDrive,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowLeft,
  Info,
  CloudOff,
  Inbox,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { AdminBackupsResponse, AdminBackupFileInfo } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { ExecutiveGuidanceCard } from '../../components/admin/ExecutiveGuidanceCard';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminBackupsPageProps {
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
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
};

// Renders a single backup category card with file metadata
const BackupFileCard: React.FC<{
  title: string;
  subtitle: string;
  icon: React.ElementType;
  info: AdminBackupFileInfo;
  iconColor: string;
  t: (key: string) => string;
}> = ({ title, subtitle, icon: Icon, info, iconColor, t }) => {
  const hasBackup = Boolean(info.latest_backup_filename);

  return (
    <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${iconColor}18` }}
          >
            <Icon className="w-4.5 h-4.5" style={{ color: iconColor }} />
          </div>
          <div>
            <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
              {title}
            </CardTitle>
            <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">{subtitle}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {!hasBackup ? (
          <div className="flex flex-col items-center justify-center py-6 text-center space-y-2">
            <Inbox className="w-7 h-7 text-slate-300 dark:text-white/20" />
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {t('admin.backups.notAvailable')}
            </p>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              {t('admin.backups.noBackupFound')}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* Filename */}
            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
              <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                {t('admin.backups.filename')}
              </span>
              <span
                className="font-mono text-xs font-medium text-slate-700 dark:text-slate-200 mt-0.5 block break-all"
                title={info.latest_backup_filename ?? undefined}
              >
                {info.latest_backup_filename}
              </span>
            </div>
            {/* Size + Age grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.backups.size')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                  {info.size_human ?? '—'}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.backups.ageHours')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                  {info.age_hours != null
                    ? `${info.age_hours.toFixed(1)} ${t('admin.backups.ageHoursUnit')}`
                    : '—'}
                </span>
              </div>
            </div>
            {/* Created At */}
            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
              <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                {t('admin.backups.createdAt')}
              </span>
              <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block">
                {formatDateTime(info.created_at)}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// DR check row
const DrCheckRow: React.FC<{
  label: string;
  passed: boolean | null;
  isWarning?: boolean;
}> = ({ label, passed, isWarning = false }) => {
  const { t } = useI18n();
  const icon =
    passed === null ? (
      <AlertTriangle className="w-4 h-4 text-slate-400" />
    ) : passed ? (
      <CheckCircle2 className="w-4 h-4 text-[#28C76F]" />
    ) : isWarning ? (
      <AlertTriangle className="w-4 h-4 text-[#FF9F43]" />
    ) : (
      <XCircle className="w-4 h-4 text-[#EA5455]" />
    );

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-slate-100 dark:border-white/[0.04] last:border-0">
      {icon}
      <span
        className={`text-xs font-medium flex-1 ${
          passed === false && !isWarning
            ? 'text-[#EA5455]'
            : passed === false && isWarning
            ? 'text-[#FF9F43] dark:text-amber-300'
            : 'text-slate-700 dark:text-slate-200'
        }`}
      >
        {label}
      </span>
      <StatusBadge
        status={
          passed === null
            ? 'offline'
            : passed
            ? 'online'
            : isWarning
            ? 'warning'
            : 'danger'
        }
        label={
          passed === null
            ? t('admin.backups.unknownUpper')
            : passed
            ? t('admin.backups.okUpper')
            : t('admin.backups.warnUpper')
        }
        size="sm"
      />
    </div>
  );
};

export const AdminBackupsPage: React.FC<AdminBackupsPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminBackupsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchBackups = useCallback(
    async (isInitial = false) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      try {
        const res = await AdminApi.getBackups();
        setData(res);
        setError(null);
        setLastUpdated(new Date().toLocaleTimeString());
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
    },
    [t]
  );

  useEffect(() => {
    if (!showAdmin) {
      setLoading(false);
      return;
    }
    void fetchBackups(true);
    // Low-frequency: refresh on visibility restore only (no auto-polling for backups)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchBackups(false);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [showAdmin, fetchBackups]);

  // 1. Access Denied
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

  // 2. Error state
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
                onClick={() => fetchBackups(true)}
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

  // 3. Loading
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200 dark:border-white/[0.06]">
          <div className="space-y-2">
            <Skeleton className="h-8 w-72 rounded-lg" />
            <Skeleton className="h-4 w-96 rounded-md" />
          </div>
          <Skeleton className="h-9 w-32 rounded-lg" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) return null;

  const { certification_status, off_host_status, postgres, media, config, total_backup_disk_usage } =
    data;

  const hasPostgres = Boolean(postgres.latest_backup_filename);
  const hasMedia = Boolean(media.latest_backup_filename);
  const hasConfig = Boolean(config.latest_backup_filename);

  const isVerified = Boolean(hasPostgres && certification_status === 'BACKUP_RESTORE_VERIFIED');
  const isOffHostConfigured = off_host_status !== 'OFF_HOST_BACKUP_NOT_CONFIGURED';

  const overallBadgeVariant: StatusVariant = isVerified ? 'online' : hasPostgres ? 'warning' : 'offline';
  const overallBadgeText = isVerified
    ? t('admin.backups.statusVerified')
    : hasPostgres
    ? t('admin.backups.uncertified')
    : t('admin.backups.notAvailable');

  return (
    <AdminShell
      title={t('admin.backups.title')}
      subtitle={t('admin.backups.subtitle')}
      badge={<StatusBadge status={overallBadgeVariant} label={overallBadgeText} size="md" />}
      onRefresh={() => fetchBackups(false)}
      isRefreshing={refreshing}
      lastUpdated={lastUpdated}
    >
      <div className="space-y-6">
        <ExecutiveGuidanceCard
          status={isVerified ? 'ok' : hasPostgres ? 'warn' : 'critical'}
          badgeLabel={overallBadgeText}
          title={t('admin.backups.title')}
          subtitle={t('admin.backups.subtitle')}
          currentState={
            isVerified
              ? t('admin.backups.statusVerified')
              : hasPostgres
              ? `${t('admin.backups.postgresBackup')}: ${postgres.size_human ?? '—'} (${t('admin.backups.uncertified')})`
              : t('admin.backups.notAvailable')
          }
          severity={{
            level: isVerified ? 'normal' : hasPostgres ? 'medium' : 'high',
            label: overallBadgeText,
            description: isVerified
              ? t('admin.backups.certified')
              : hasPostgres
              ? t('admin.backups.uncertified')
              : t('admin.backups.noBackupFound'),
          }}
          businessImpact={
            isVerified
              ? t('admin.guidance.zeroCustomerImpact')
              : hasPostgres
              ? t('admin.backups.distinctionAlertBody')
              : t('admin.backups.noBackupFound')
          }
          recommendedAction={{
            label: isVerified ? t('admin.guidance.noActionNeeded') : t('admin.backups.safeNextStep'),
            description: isVerified
              ? t('admin.guidance.noActionNeededDesc')
              : t('admin.backups.distinctionAlertBody'),
            buttonText: (onNavigate && !isVerified) ? t('admin.actionGoToOps') : undefined,
            onAction: (onNavigate && !isVerified) ? () => onNavigate('admin-operations') : undefined,
            icon: Database,
          }}
          actionOutcome={t('admin.backups.readOnlyNotice')}
          technicalDetails={
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.backups.postgresBackup')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{postgres.latest_backup_filename || '—'}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.backups.size')}</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">{postgres.size_human || '—'}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.backups.totalStorage')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{total_backup_disk_usage.human}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-white/[0.03] border border-slate-200/50 dark:border-white/[0.05]">
                  <span className="text-[10px] text-slate-400 block">{t('admin.backups.offHostStatus')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{off_host_status}</span>
                </div>
              </div>
            </div>
          }
        />

        {/* Off-Host Warning Banner (Surfaced only if configuration is missing) */}
        {!isOffHostConfigured && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
            <CloudOff className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-sm text-amber-700 dark:text-amber-300">
                {t('admin.backups.offHostWarningTitle')}
              </p>
              <p className="text-xs text-amber-800/80 dark:text-amber-200/70 leading-relaxed">
                {t('admin.backups.offHostWarningDesc')}
              </p>
            </div>
          </div>
        )}

        {/* Summary Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatsCard
            title={t('admin.backups.certificationStatus')}
            value={isVerified ? '✓' : '—'}
            subText={
              hasPostgres
                ? isVerified
                  ? t('admin.backups.statusVerified')
                  : t('admin.backups.uncertified')
                : t('admin.backups.notAvailable')
            }
            icon={ShieldCheck}
            iconVariant={isVerified ? 'success' : 'warning'}
          />
          <StatsCard
            title={t('admin.backups.offHostStatus')}
            value={isOffHostConfigured ? '✓' : '!'}
            subText={
              isOffHostConfigured
                ? t('admin.backups.configured')
                : t('admin.backups.notConfigured')
            }
            icon={isOffHostConfigured ? ShieldCheck : CloudOff}
            iconVariant={isOffHostConfigured ? 'success' : 'warning'}
          />
          <StatsCard
            title={t('admin.backups.totalStorage')}
            value={total_backup_disk_usage.human}
            subText={t('admin.backups.totalStorageSubtitle')}
            icon={HardDrive}
            iconVariant="primary"
          />
          <StatsCard
            title={t('admin.backups.overallStatus')}
            value={isVerified ? 'OK' : hasPostgres ? 'WARN' : 'OFFLINE'}
            subText={
              isVerified
                ? t('admin.backups.certified')
                : hasPostgres
                ? t('admin.backups.uncertified')
                : t('admin.backups.notAvailable')
            }
            icon={isVerified ? ShieldCheck : ShieldAlert}
            iconVariant={isVerified ? 'success' : 'warning'}
          />
        </div>

        {/* Backup Category Cards — 3-col on md/xl */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* PostgreSQL */}
          <BackupFileCard
            title={t('admin.backups.postgresBackup')}
            subtitle={t('admin.backups.postgresBackupSubtitle')}
            icon={Database}
            info={postgres}
            iconColor="#7367F0"
            t={t}
          />
          {/* Media */}
          <BackupFileCard
            title={t('admin.backups.mediaBackup')}
            subtitle={t('admin.backups.mediaBackupSubtitle')}
            icon={Image}
            info={media}
            iconColor="#28C76F"
            t={t}
          />
          {/* Config */}
          <BackupFileCard
            title={t('admin.backups.configBackup')}
            subtitle={t('admin.backups.configBackupSubtitle')}
            icon={FileText}
            info={config}
            iconColor="#FF9F43"
            t={t}
          />
        </div>

        {/* Disaster Recovery Status */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.backups.drStatus')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.backups.drSubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 divide-y divide-slate-100 dark:divide-white/[0.04]">
            <div className="pb-3 text-[11px] text-slate-500 dark:text-slate-400 flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-[#7367F0] shrink-0 mt-0.5" />
              <span>{t('admin.backups.drRunbookNote')}</span>
            </div>
            <DrCheckRow label={t('admin.backups.checkPostgresExists')} passed={hasPostgres} />
            <DrCheckRow label={t('admin.backups.checkRestoreVerified')} passed={hasPostgres ? (isVerified ? true : false) : null} />
            {/* Isolated restore = implied by BACKUP_RESTORE_VERIFIED; guarded by file presence */}
            <DrCheckRow label={t('admin.backups.checkIsolatedRestore')} passed={hasPostgres ? (isVerified ? true : false) : null} />
            <DrCheckRow label={t('admin.backups.checkMediaBackup')} passed={hasMedia} />
            <DrCheckRow label={t('admin.backups.checkConfigBackup')} passed={hasConfig} />
            <DrCheckRow
              label={t('admin.backups.checkOffHost')}
              passed={isOffHostConfigured}
              isWarning={true}
            />
          </CardContent>
        </Card>

        {/* History — not available from current API */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-[#7367F0]" />
              <div>
                <CardTitle className="text-base text-slate-800 dark:text-white">
                  {t('admin.backups.historyTitle')}
                </CardTitle>
                <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.backups.historySubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6 pb-8 flex flex-col items-center justify-center text-center gap-2">
            <Inbox className="w-8 h-8 text-slate-300 dark:text-white/20" />
            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
              {t('admin.backups.noHistoryAvailable')}
            </p>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
};
