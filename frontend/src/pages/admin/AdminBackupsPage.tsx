import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  Plus,
  ChevronDown,
  ChevronUp,
  Clock,
  Calendar,
  Lock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { useToast } from '../../context/ToastContext';
import { AdminApi } from '../../api/admin';
import { AdminBackupsResponse, AdminBackupFileInfo } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';
import { AdminActionIssueCard } from '../../components/admin/AdminActionIssueCard';

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

// Renders a single backup category card with file metadata and an action trigger
const BackupFileCard: React.FC<{
  title: string;
  subtitle: string;
  icon: React.ElementType;
  info: AdminBackupFileInfo;
  iconColor: string;
  t: (key: string) => string;
  isOperating?: boolean;
  onRunAction?: () => void;
  actionText?: string;
}> = ({
  title,
  subtitle,
  icon: Icon,
  info,
  iconColor,
  t,
  isOperating = false,
  onRunAction,
  actionText,
}) => {
  const hasBackup = Boolean(info.latest_backup_filename);

  return (
    <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-xs flex flex-col justify-between">
      <div>
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${iconColor}18` }}
            >
              <Icon className="w-4 h-4" style={{ color: iconColor }} />
            </div>
            <div>
              <CardTitle className="text-xs font-bold text-slate-800 dark:text-white">
                {title}
              </CardTitle>
              <p className="text-[10px] text-slate-400 dark:text-[#7E7F96]">{subtitle}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-3.5 space-y-2.5 text-xs">
          {!hasBackup ? (
            <div className="flex flex-col items-center justify-center py-5 text-center space-y-1.5">
              <Inbox className="w-6 h-6 text-slate-300 dark:text-white/20" />
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                {t('admin.backups.notAvailable')}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {t('admin.backups.noBackupFound')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.backups.filename')}
                </span>
                <span
                  className="font-mono text-[11px] font-medium text-slate-700 dark:text-slate-200 mt-0.5 block break-all"
                  title={info.latest_backup_filename ?? undefined}
                >
                  {info.latest_backup_filename}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.backups.size')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                    {info.size_human ?? '—'}
                  </span>
                </div>
                <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
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
              <div className="p-2 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.backups.createdAt')}
                </span>
                <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 mt-0.5 block">
                  {formatDateTime(info.created_at)}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </div>

      {onRunAction && actionText && (
        <div className="px-4 pb-3.5 pt-1">
          <Button
            variant="outline"
            disabled={isOperating}
            onClick={onRunAction}
            className="w-full h-9 px-3.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 border border-slate-200/80 dark:border-white/[0.08] hover:bg-[#7367F0]/10 hover:text-[#7367F0] hover:border-[#7367F0]/30 transition-all cursor-pointer active:scale-[0.98]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isOperating ? 'animate-spin' : ''}`} />
            <span>{actionText}</span>
          </Button>
        </div>
      )}
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
    <div className="flex items-center gap-3 py-2 border-b border-slate-100 dark:border-white/[0.04] last:border-0">
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

// Off-Host Guide Modal
const OffHostGuideModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  t: (key: string) => string;
}> = ({ isOpen, onClose, t }) => {
  if (!isOpen) return null;
  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-white dark:bg-[#2F3349] rounded-2xl shadow-xl border border-slate-200 dark:border-white/[0.08] overflow-hidden">
        <div className="p-5 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <CloudOff className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-white">
                {t('admin.backups.offHostGuideTitle')}
              </h3>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {t('admin.backups.offHostGuideSubtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg transition-colors cursor-pointer"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-3.5 text-xs">
          <p className="text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
            {t('admin.backups.offHostWarningDesc')}
          </p>
          <div className="space-y-2 p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              {t('admin.backups.offHostStep1')}
            </p>
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              {t('admin.backups.offHostStep2')}
            </p>
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              {t('admin.backups.offHostStep3')}
            </p>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 italic">
            {t('admin.backups.offHostGuideNote')}
          </p>
        </div>
        <div className="p-4 bg-slate-50 dark:bg-white/[0.02] border-t border-slate-100 dark:border-white/[0.06] flex justify-end">
          <Button variant="default" size="sm" onClick={onClose} className="px-5 cursor-pointer">
            {t('admin.backups.close')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const AdminBackupsPage: React.FC<AdminBackupsPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();
  const toast = useToast();

  const [data, setData] = useState<AdminBackupsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [operatingType, setOperatingType] = useState<string | null>(null);
  const [backupJustFinished, setBackupJustFinished] = useState<boolean>(false);
  const [showGuideModal, setShowGuideModal] = useState<boolean>(false);
  const [showAdvancedDetails, setShowAdvancedDetails] = useState<boolean>(false);
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
    },
    [t]
  );

  const handleRunBackup = async (type: 'full' | 'postgres' | 'config' | 'media' = 'full') => {
    if (operatingType) return;
    setOperatingType(type);
    setBackupJustFinished(false);
    toast.info(t('admin.backups.backupInProgress'));
    try {
      const updated = await AdminApi.takeManualBackup(type);
      setData(updated);
      setLastUpdated(new Date().toLocaleTimeString());
      setBackupJustFinished(true);
      toast.success(t('admin.backups.backupSuccess'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`${t('admin.backups.backupFailed')}: ${msg}`);
    } finally {
      setOperatingType(null);
    }
  };

  useEffect(() => {
    if (!showAdmin) {
      setLoading(false);
      return;
    }
    void fetchBackups(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchBackups(false);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [showAdmin, fetchBackups]);

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

  // 3. Loading
  if (loading && !data) {
    return (
      <AdminShell
        title={t('admin.backups.heroTitle')}
        subtitle={t('admin.backups.heroSubtitle')}
        isRefreshing={true}
      >
        <div className="space-y-6">
          <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] p-6 space-y-6">
            <div className="flex justify-between items-center">
              <div className="space-y-2">
                <Skeleton className="h-6 w-48 rounded-md" />
                <Skeleton className="h-4 w-72 rounded-md" />
              </div>
              <Skeleton className="h-10 w-36 rounded-xl" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          </Card>
        </div>
      </AdminShell>
    );
  }

  if (!data) return null;

  const { certification_status, off_host_status, postgres, media, config, total_backup_disk_usage } = data;
  const hasPostgres = Boolean(postgres.latest_backup_filename);
  const hasMedia = Boolean(media.latest_backup_filename);
  const hasConfig = Boolean(config.latest_backup_filename);
  const isVerified = Boolean(hasPostgres && certification_status === 'BACKUP_RESTORE_VERIFIED');
  const isOffHostConfigured = off_host_status !== 'OFF_HOST_BACKUP_NOT_CONFIGURED';

  const overallBadgeVariant: StatusVariant = operatingType
    ? 'warning'
    : isVerified
    ? 'online'
    : hasPostgres
    ? 'online'
    : 'offline';

  const overallBadgeText = operatingType
    ? t('admin.backups.statusInProgress')
    : isVerified
    ? t('admin.backups.statusSuccessVerified')
    : hasPostgres
    ? t('admin.backups.statusSuccessVerified')
    : t('admin.backups.statusNoBackup');

  return (
    <AdminShell
      title={t('admin.backups.heroTitle')}
      subtitle={t('admin.backups.heroSubtitle')}
      badge={<StatusBadge status={overallBadgeVariant} label={overallBadgeText} size="md" />}
      onRefresh={() => fetchBackups(false)}
      isRefreshing={refreshing}
      lastUpdated={lastUpdated}
    >
      <div className="space-y-6">
        {/* Navigation Tabs: Backup & Security Unified */}
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200/60 dark:border-white/[0.05]">
            <button
              type="button"
              className="min-h-[40px] px-4 py-2 rounded-lg text-xs font-bold bg-white dark:bg-[#2F3349] text-slate-800 dark:text-white shadow-xs cursor-default flex items-center gap-2"
            >
              <Database className="w-4 h-4 text-[#7367F0]" />
              <span>{t('admin.backups.tabBackups')}</span>
            </button>
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('admin-security')}
                className="min-h-[40px] px-4 py-2 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors cursor-pointer flex items-center gap-2"
              >
                <Lock className="w-4 h-4 text-slate-400" />
                <span>{t('admin.backups.tabSecurity')}</span>
              </button>
            )}
          </div>

          <span className="text-[11px] text-slate-400 dark:text-slate-500 hidden sm:inline">
            {total_backup_disk_usage.human} {t('admin.backups.totalStorage').toLowerCase()}
          </span>
        </div>

        {/* 1. HERO ACTION CARD — RADICAL SIMPLICITY BLUEPRINT */}
        <Card className="border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#2F3349] shadow-sm overflow-hidden">
          <CardContent className="p-5 sm:p-7 space-y-6">
            {/* Top Bar: Action & Primary Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-extrabold text-slate-800 dark:text-white tracking-tight">
                    {t('admin.backups.heroTitle')}
                  </h2>
                  <StatusBadge status={overallBadgeVariant} label={overallBadgeText} size="sm" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl">
                  {t('admin.backups.heroSubtitle')}
                </p>
              </div>

              {/* Primary Action Button */}
              <div className="w-full sm:w-auto flex items-center gap-3 shrink-0">
                <Button
                  variant="default"
                  disabled={operatingType !== null}
                  onClick={() => handleRunBackup('full')}
                  className="w-full sm:w-auto h-10 px-5 bg-gradient-to-r from-[#7367F0] to-[#867BFF] hover:from-[#685dd8] hover:to-[#766bf3] text-white font-bold text-xs sm:text-sm shadow-xs hover:shadow-md shadow-[#7367F0]/30 rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.98]"
                >
                  {operatingType === 'full' ? (
                    <RefreshCw className="w-4 h-4 animate-spin text-white" />
                  ) : (
                    <Plus className="w-4 h-4 text-white" />
                  )}
                  <span>
                    {operatingType === 'full'
                      ? t('admin.backups.runningBackupHero')
                      : t('admin.backups.runBackupHeroBtn')}
                  </span>
                </Button>
              </div>
            </div>

            {/* In-Progress Notification Banner */}
            {operatingType && (
              <div className="p-4 rounded-xl bg-[#7367F0]/10 border border-[#7367F0]/30 flex items-center gap-3 animate-pulse">
                <RefreshCw className="w-5 h-5 text-[#7367F0] animate-spin shrink-0" />
                <div className="text-xs text-slate-700 dark:text-slate-200">
                  <strong className="font-bold text-[#7367F0] block">
                    {t('admin.backups.backupInProgress')}
                  </strong>
                  <span>{t('admin.backups.distinctionAlertBody')}</span>
                </div>
              </div>
            )}

            {/* Success Banner */}
            {backupJustFinished && !operatingType && (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between gap-3 animate-fade-in">
                <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-200">
                  <CheckCircle2 className="w-5 h-5 text-[#28C76F] shrink-0" />
                  <div>
                    <strong className="font-bold text-emerald-600 dark:text-emerald-400 block">
                      {t('admin.backups.backupSuccess')}
                    </strong>
                    <span className="text-[11px] text-slate-500">
                      {t('admin.backups.lastBackupDateLabel')}: {formatDateTime(postgres.created_at)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setBackupJustFinished(false)}
                  className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* 4 Essential Metric Blocks */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {/* Metric 1: Son Yedekleme Zamanı */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5">
                <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                  <Clock className="w-4 h-4 text-[#7367F0]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider">
                    {t('admin.backups.lastBackupDateLabel')}
                  </span>
                </div>
                <div className="font-mono text-sm font-bold text-slate-800 dark:text-white truncate">
                  {formatDateTime(postgres.created_at)}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {postgres.age_hours != null
                    ? `${postgres.age_hours.toFixed(1)} ${t('admin.backups.ageHoursUnit')} önce`
                    : t('admin.backups.statusNoBackup')}
                </p>
              </div>

              {/* Metric 2: Son Yedekleme Durumu */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5">
                <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                  <CheckCircle2 className="w-4 h-4 text-[#28C76F]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider">
                    {t('admin.backups.lastBackupStatusLabel')}
                  </span>
                </div>
                <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 truncate flex items-center gap-1.5">
                  <span>{hasPostgres ? t('admin.backups.statusSuccessVerified') : t('admin.backups.statusNoBackup')}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isVerified
                    ? t('admin.backups.statusVerified')
                    : hasPostgres
                    ? t('admin.backups.localBackupStatus')
                    : t('admin.backups.noBackupFound')}
                </p>
              </div>

              {/* Metric 3: Son Yedek Boyutu */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5">
                <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                  <HardDrive className="w-4 h-4 text-[#FF9F43]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider">
                    {t('admin.backups.lastBackupSizeLabel')}
                  </span>
                </div>
                <div className="font-mono text-sm font-bold text-slate-800 dark:text-white truncate">
                  {postgres.size_human ?? total_backup_disk_usage.human}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('admin.backups.totalStorage')}: {total_backup_disk_usage.human}
                </p>
              </div>

              {/* Metric 4: Otomatik Zamanlama */}
              <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-1.5">
                <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                  <Calendar className="w-4 h-4 text-[#00CFE8]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider">
                    {t('admin.backups.autoScheduleLabel')}
                  </span>
                </div>
                <div className="text-xs font-bold text-slate-800 dark:text-white truncate">
                  {t('admin.backups.autoScheduleValue')}
                </div>
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {t('admin.guidance.systemHealthyState')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Real Issue / Security Warning if failed or off-host unconfigured */}
        {!hasPostgres && (
          <AdminActionIssueCard
            title={t('admin.backups.noBackupTitle')}
            description={t('admin.backups.noBackupDesc')}
            severity="warning"
            statusLabel={t('admin.backups.noBackupStatus')}
            impact={t('admin.backups.noBackupImpact')}
            recommendedAction={t('admin.backups.noBackupAction')}
            primaryAction={{
              label: t('admin.backups.runBackupHeroBtn'),
              onClick: () => handleRunBackup('full'),
              loading: operatingType !== null,
              icon: RefreshCw,
            }}
          />
        )}

        {!isOffHostConfigured && (
          <AdminActionIssueCard
            title={t('admin.backups.cloudUnconfiguredTitle')}
            description={t('admin.backups.cloudUnconfiguredDesc')}
            severity="info"
            statusLabel={t('admin.backups.cloudUnconfiguredStatus')}
            impact={t('admin.backups.cloudUnconfiguredImpact')}
            recommendedAction={t('admin.backups.cloudUnconfiguredAction')}
            primaryAction={{
              label: t('admin.backups.openGuideModal'),
              onClick: () => setShowGuideModal(true),
              icon: Info,
            }}
          />
        )}

        {/* 2. CLI Restore Guidance Box (Honest & Secure: No Fake Restore Button) */}
        <Card className="border border-slate-200/70 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.01]">
          <CardContent className="p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 mt-0.5">
                <Info className="w-4 h-4" />
              </div>
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-slate-800 dark:text-white">
                  {t('admin.backups.cliRestoreTitle')}
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed max-w-3xl">
                  {t('admin.backups.cliRestoreBody')}
                </p>
              </div>
            </div>
            <span className="text-[10px] font-mono font-medium text-slate-400 dark:text-slate-500 bg-slate-200/60 dark:bg-white/[0.05] px-2.5 py-1 rounded-md shrink-0">
              {t('admin.backups.cliRestoreRunbookLink')}
            </span>
          </CardContent>
        </Card>

        {/* 3. Collapsible Advanced Section: Category Files, DR Details & Archive History */}
        <div className="border border-slate-200/80 dark:border-white/[0.06] rounded-2xl bg-white dark:bg-[#2F3349] overflow-hidden shadow-xs">
          <button
            type="button"
            onClick={() => setShowAdvancedDetails((prev) => !prev)}
            className="w-full p-4 sm:p-5 flex items-center justify-between text-left hover:bg-slate-50/60 dark:hover:bg-white/[0.02] transition-colors cursor-pointer select-none"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 flex items-center justify-center">
                <Database className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800 dark:text-white">
                  {showAdvancedDetails
                    ? t('admin.backups.hideAdvancedTitle')
                    : t('admin.backups.showAdvancedTitle')}
                </h3>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  PostgreSQL, Medya, Yapılandırma kategorileri, DR doğrulaması ve SHA256 dosya geçmişi
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <span>{showAdvancedDetails ? t('admin.monitoring.hideDetails') : t('admin.monitoring.showDetails')}</span>
              {showAdvancedDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showAdvancedDetails && (
            <div className="p-5 border-t border-slate-100 dark:border-white/[0.06] space-y-6 animate-fade-in">
              {/* Category Cards: PostgreSQL, Media, Config */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <BackupFileCard
                  title={t('admin.backups.postgresBackup')}
                  subtitle={t('admin.backups.postgresBackupSubtitle')}
                  icon={Database}
                  info={postgres}
                  iconColor="#7367F0"
                  t={t}
                  isOperating={operatingType === 'postgres'}
                  onRunAction={() => handleRunBackup('postgres')}
                  actionText={t('admin.backups.backupDatabaseOnly')}
                />
                <BackupFileCard
                  title={t('admin.backups.mediaBackup')}
                  subtitle={t('admin.backups.mediaBackupSubtitle')}
                  icon={Image}
                  info={media}
                  iconColor="#28C76F"
                  t={t}
                  isOperating={operatingType === 'media'}
                  onRunAction={() => handleRunBackup('media')}
                  actionText={t('admin.backups.backupMediaOnly')}
                />
                <BackupFileCard
                  title={t('admin.backups.configBackup')}
                  subtitle={t('admin.backups.configBackupSubtitle')}
                  icon={FileText}
                  info={config}
                  iconColor="#FF9F43"
                  t={t}
                  isOperating={operatingType === 'config'}
                  onRunAction={() => handleRunBackup('config')}
                  actionText={t('admin.backups.backupConfigOnly')}
                />
              </div>

              {/* Disaster Recovery Status Rows */}
              <div className="p-4 rounded-xl bg-slate-50/70 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04]">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-200/60 dark:border-white/[0.04]">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[#7367F0]" />
                    <span className="text-xs font-bold text-slate-800 dark:text-white">
                      {t('admin.backups.drStatus')}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400">
                    {t('admin.backups.cliOnlyBadge')}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-white/[0.03]">
                  <DrCheckRow label={t('admin.backups.checkPostgresExists')} passed={hasPostgres} />
                  <DrCheckRow label={t('admin.backups.checkRestoreVerified')} passed={hasPostgres ? (isVerified ? true : false) : null} />
                  <DrCheckRow label={t('admin.backups.checkMediaBackup')} passed={hasMedia} />
                  <DrCheckRow label={t('admin.backups.checkConfigBackup')} passed={hasConfig} />
                  <DrCheckRow label={t('admin.backups.checkOffHost')} passed={isOffHostConfigured} isWarning={true} />
                </div>
              </div>

              {/* Backup History Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-[#7367F0]" />
                    <span>{t('admin.backups.historyTitle')}</span>
                  </h4>
                  {data.backup_files && data.backup_files.length > 0 && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
                      {data.backup_files.length} {t('admin.backups.historyColFile').toLowerCase()}
                    </span>
                  )}
                </div>

                {!data.backup_files || data.backup_files.length === 0 ? (
                  <div className="py-6 flex flex-col items-center justify-center text-center gap-1.5 px-4 rounded-xl bg-slate-50/50 dark:bg-white/[0.02]">
                    <Inbox className="w-6 h-6 text-slate-300 dark:text-white/20" />
                    <p className="text-xs font-medium text-slate-500">
                      {t('admin.backups.noHistoryAvailable')}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200/60 dark:border-white/[0.04]">
                    <table className="w-full text-left text-xs text-slate-600 dark:text-slate-300 divide-y divide-slate-100 dark:divide-white/[0.04]">
                      <thead className="bg-slate-50/80 dark:bg-white/[0.02] text-[10px] font-semibold text-slate-400 dark:text-[#7E7F96] uppercase tracking-wider">
                        <tr>
                          <th className="py-2.5 px-3">{t('admin.backups.historyColCategory')}</th>
                          <th className="py-2.5 px-3">{t('admin.backups.historyColFile')}</th>
                          <th className="py-2.5 px-3">{t('admin.backups.historyColSize')}</th>
                          <th className="py-2.5 px-3">{t('admin.backups.historyColDate')}</th>
                          <th className="py-2.5 px-3">{t('admin.backups.historyColIntegrity')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                        {data.backup_files.map((file, idx) => {
                          const isPg = file.category === 'postgres';
                          const isMed = file.category === 'media';
                          const catBadge = isPg
                            ? { label: t('admin.backups.categoryPostgres'), color: 'bg-[#7367F0]/10 text-[#7367F0] border-[#7367F0]/20' }
                            : isMed
                            ? { label: t('admin.backups.categoryMedia'), color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' }
                            : { label: t('admin.backups.categoryConfig'), color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' };

                          return (
                            <tr key={file.filename + idx} className="hover:bg-slate-50/60 dark:hover:bg-white/[0.02] transition-colors">
                              <td className="py-2 px-3 whitespace-nowrap">
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${catBadge.color}`}>
                                  {catBadge.label}
                                </span>
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] font-medium text-slate-800 dark:text-slate-200">
                                {file.filename}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap font-semibold text-slate-700 dark:text-slate-300">
                                {file.size_human}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap text-slate-500 dark:text-slate-400">
                                {formatDateTime(file.created_at)}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                {file.sha256 ? (
                                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded" title={file.sha256}>
                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                    {file.sha256.slice(0, 8)}…
                                  </span>
                                ) : (
                                  <span className="text-slate-400 text-[10px]">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Off-host guide link button */}
              <div className="pt-2 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowGuideModal(true)}
                  className="text-xs font-semibold flex items-center gap-1.5 border-amber-300 dark:border-amber-800/50 hover:bg-amber-500/10 text-amber-700 dark:text-amber-300 cursor-pointer"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>{t('admin.backups.howToConfigureOffHost')}</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <OffHostGuideModal
        isOpen={showGuideModal}
        onClose={() => setShowGuideModal(false)}
        t={t}
      />
    </AdminShell>
  );
};
