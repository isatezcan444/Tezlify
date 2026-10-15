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
  Smartphone,
  ChevronDown,
  ChevronUp,
  Activity,
  Layers,
  Wrench,
  Radio,
  Loader2,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { useToast } from '../../context/ToastContext';
import { AdminApi } from '../../api/admin';
import { AdminOverviewResponse, AdminWhatsAppResponse, AdminBackupsResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { AdminActionIssueCard, IssueSeverity } from '../../components/admin/AdminActionIssueCard';
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
  const toast = useToast();

  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [waData, setWaData] = useState<AdminWhatsAppResponse | null>(null);
  const [backupData, setBackupData] = useState<AdminBackupsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [showInfraDetails, setShowInfraDetails] = useState<boolean>(false);

  // In-flight action states
  const [isBackingUp, setIsBackingUp] = useState<boolean>(false);
  const [isCheckingWa, setIsCheckingWa] = useState<boolean>(false);

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

  // Real action: Take Backup Now
  const handleRunBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    try {
      await AdminApi.takeManualBackup('full');
      toast.success(t('admin.overviewAnswers.backupSuccessToast'));
      await fetchOverview(false);
    } catch (err: any) {
      toast.error(err?.message || t('admin.overviewAnswers.backupErrorToast'));
    } finally {
      setIsBackingUp(false);
    }
  };

  // Real action: Check WhatsApp Health
  const handleCheckWhatsApp = async () => {
    if (isCheckingWa) return;
    setIsCheckingWa(true);
    try {
      const res = await AdminApi.getWhatsApp();
      setWaData(res);
      if (!res.gateway_bridge.connected) {
        toast.warning(t('admin.overviewAnswers.waHealthDisconnected'));
      } else if (res.db_session_summary.connected > 0) {
        toast.success(t('admin.overviewAnswers.waHealthGood', { count: res.db_session_summary.connected }));
      } else {
        toast.info(t('admin.overviewAnswers.waHealthNoSessions'));
      }
    } catch (err: any) {
      toast.error(err?.message || t('admin.errorDesc'));
    } finally {
      setIsCheckingWa(false);
    }
  };

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
        title={t('admin.overviewAnswers.hubTitle')}
        subtitle={t('admin.overviewAnswers.hubSubtitle')}
        isRefreshing={true}
      >
        <div className="space-y-6">
          <Card className="p-6 space-y-4 bg-white dark:bg-[#2F3349]">
            <Skeleton className="h-6 w-48" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
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
        title={t('admin.overviewAnswers.hubTitle')}
        subtitle={t('admin.overviewAnswers.hubSubtitle')}
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
  const waScanQrCount = waData?.db_session_summary.scan_qr ?? 0;
  const waRelinkCount = waData?.db_session_summary.relink_required ?? 0;
  const isWaFullyConnected = isWaBridgeConnected && waConnectedCount > 0;

  // Backup facts
  const latestBackupTime = backupData?.postgres.created_at;
  const latestBackupSize = backupData?.postgres.size_human;
  const hasPostgresBackup = Boolean(backupData?.postgres?.latest_backup_filename);

  // Derive real active issues
  interface DerivedIssue {
    id: string;
    title: string;
    description: string;
    severity: IssueSeverity;
    statusLabel: string;
    impact: string;
    recommendedAction: string;
    primaryAction?: {
      label: string;
      onClick: () => void | Promise<void>;
      loading?: boolean;
      icon?: React.ComponentType<{ className?: string }>;
    };
    secondaryAction?: {
      label: string;
      onClick: () => void | Promise<void>;
      icon?: React.ComponentType<{ className?: string }>;
    };
  }

  const issuesList: DerivedIssue[] = [];

  // Issue 1: Gateway Bridge Disconnected
  if (waData && !waData.gateway_bridge.connected) {
    issuesList.push({
      id: 'wa-bridge-down',
      title: 'WhatsApp Ağ Geçidi Bağlantısı Kesik',
      description: 'WhatsApp servis köprüsü ile bağlantı kurulamıyor. Oturum durumları alınamıyor.',
      severity: 'critical',
      statusLabel: 'Kritik Kesinti',
      impact: 'Gelen ve giden WhatsApp mesaj iletimi durduruldu.',
      recommendedAction: 'Ağ geçidi bağlantısını kontrol edin veya servisi inceleyin.',
      primaryAction: {
        label: t('admin.overviewAnswers.actionCheckWhatsApp'),
        onClick: handleCheckWhatsApp,
        loading: isCheckingWa,
        icon: RefreshCw,
      },
      secondaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.quickOps'),
        onClick: () => onNavigate('admin-operations'),
        icon: Wrench,
      } : undefined,
    });
  }

  // Issue 2: WhatsApp Session Needs QR Scan or Relink
  if (waData && isWaBridgeConnected && (waScanQrCount > 0 || waRelinkCount > 0)) {
    issuesList.push({
      id: 'wa-relink-needed',
      title: 'WhatsApp Yeniden Eşleştirme Bekliyor',
      description: `${waScanQrCount + waRelinkCount} oturumun telefon ile QR kod eşleştirmesi yapması gerekiyor.`,
      severity: 'warning',
      statusLabel: 'Eşleştirme Gerekli',
      impact: 'İlgili hat üzerinden müşterilere mesaj iletimi geçici olarak durdu.',
      recommendedAction: 'WhatsApp Hub sayfasına giderek telefonunuzdan QR kodu taratın.',
      primaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.actionConnectWhatsApp'),
        onClick: () => onNavigate('whatsapp'),
        icon: Smartphone,
      } : undefined,
      secondaryAction: onNavigate ? {
        label: 'Oturumları Gör',
        onClick: () => onNavigate('admin-whatsapp'),
      } : undefined,
    });
  } else if (waData && isWaBridgeConnected && waConnectedCount === 0 && (waData.db_session_summary.total ?? 0) === 0) {
    // Issue 3: No WhatsApp Sessions Registered
    issuesList.push({
      id: 'wa-no-sessions',
      title: 'Bağlı WhatsApp Oturumu Bulunmuyor',
      description: 'Sistemde kayıtlı veya bağlı aktif bir WhatsApp hesabı yok.',
      severity: 'warning',
      statusLabel: 'Bağlantı Yok',
      impact: 'Müşteri adaylarına WhatsApp üzerinden erişim sağlanamaz.',
      recommendedAction: 'WhatsApp Hub üzerinden ilk numaranızı güvenle bağlayın.',
      primaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.actionConnectWhatsApp'),
        onClick: () => onNavigate('whatsapp'),
        icon: Smartphone,
      } : undefined,
    });
  }

  // Issue 4: No Backup Yet
  if (backupData && !hasPostgresBackup && !loading) {
    issuesList.push({
      id: 'backup-none',
      title: 'Henüz Alınmış Bir Yedek Yok',
      description: 'Sistemde kayıtlı bir veritabanı yedeği bulunmuyor.',
      severity: 'warning',
      statusLabel: 'Yedek Yok',
      impact: 'Sistem arızalarına karşı veritabanı korumasız durumdadır.',
      recommendedAction: 'Tek tıkla ilk tam sistem yedeğini oluşturun.',
      primaryAction: {
        label: t('admin.overviewAnswers.actionTakeBackup'),
        onClick: handleRunBackup,
        loading: isBackingUp,
        icon: Database,
      },
      secondaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.actionViewBackup'),
        onClick: () => onNavigate('admin-backups'),
      } : undefined,
    });
  }

  // Issue 6: Critical Disk Usage
  if (data.system.disk_used_percent > 85) {
    issuesList.push({
      id: 'disk-critical',
      title: 'Disk Alanı Kritik Seviyede',
      description: `Disk doluluk oranı %${data.system.disk_used_percent} seviyesine ulaştı.`,
      severity: 'critical',
      statusLabel: 'Kritik Doluluk',
      impact: 'Disk dolarsa veri tabanı yazma işlemleri ve servisler durabilir.',
      recommendedAction: 'Eski logları ve gereksiz dosyaları inceleyip temizleyin.',
      primaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.issueViewDisk'),
        onClick: () => onNavigate('admin-operations'),
        icon: Wrench,
      } : undefined,
    });
  }

  // Issue 7: Stopped Containers
  const stoppedContainers = data.containers.filter((c) => c.status.toLowerCase() !== 'running');
  if (stoppedContainers.length > 0) {
    issuesList.push({
      id: 'containers-down',
      title: 'Durdurulmuş Servis Konteyneri Var',
      description: `Şu servisler şu an çalışmıyor: ${stoppedContainers.map((c) => c.name).join(', ')}.`,
      severity: 'critical',
      statusLabel: 'Servis Durdu',
      impact: 'İlgili servisin sunduğu işlevler kullanılamaz.',
      recommendedAction: 'Sistem İşlemleri ekranından servis loglarını inceleyin.',
      primaryAction: onNavigate ? {
        label: 'Servisleri İncele',
        onClick: () => onNavigate('admin-operations'),
        icon: Server,
      } : undefined,
    });
  }

  // Issue 8: Kernel Reboot Required
  if (data.system.reboot_required) {
    issuesList.push({
      id: 'reboot-required',
      title: 'Güvenlik Yamaları İçin Yeniden Başlatma Gerekli',
      description: 'İşletim sistemine yeni güvenlik yamaları uygulandı (/var/run/reboot-required). Güncellemelerin aktif olması için sunucunun planlı olarak yeniden başlatılması gerekir.',
      severity: 'info',
      statusLabel: 'Planlı Bakım',
      impact: 'Sistem çalışmaya devam eder; ancak en son çekirdek yamaları yeniden başlatma yapılana dek devreye girmez.',
      recommendedAction: 'Mesai saatleri dışında sunucuyu güvenli bir şekilde yeniden başlatın.',
      primaryAction: onNavigate ? {
        label: t('admin.overviewAnswers.quickOps'),
        onClick: () => onNavigate('admin-operations'),
        icon: Wrench,
      } : undefined,
    });
  }

  return (
    <AdminShell
      title={t('admin.overviewAnswers.hubTitle')}
      subtitle={t('admin.overviewAnswers.hubSubtitle')}
      lastUpdated={lastUpdated}
      onRefresh={() => void fetchOverview(false)}
      isRefreshing={refreshing}
      badge={<StatusBadge status={overallVariant} label={overallLabel} size="md" />}
    >
      <div className="space-y-8">
        {/* =========================================================================
            BÖLÜM 1: HIZLI İŞLEMLER (Büyük, açık ve anlaşılır aksiyon butonları)
           ========================================================================= */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-[#7367F0]" />
                <span>{t('admin.overviewAnswers.quickActionsTitle')}</span>
              </h2>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                {t('admin.overviewAnswers.quickActionsSubtitle')}
              </p>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300">
              6 Temel İşlem
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Buton 1: WhatsApp Bağla / WhatsApp Bağlantısını Görüntüle */}
            <Card 
              onClick={() => onNavigate?.(isWaFullyConnected ? 'admin-whatsapp' : 'whatsapp')}
              className="border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all cursor-pointer p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-[#28C76F] group-hover:bg-[#28C76F] group-hover:text-white transition-colors">
                  <Smartphone className="w-5 h-5" />
                </div>
                <StatusBadge 
                  status={isWaFullyConnected ? 'online' : isWaBridgeConnected ? 'warning' : 'danger'} 
                  label={isWaFullyConnected ? 'Bağlı' : 'Bağlantı Yok'} 
                  size="sm" 
                />
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {isWaFullyConnected 
                    ? t('admin.overviewAnswers.actionViewWhatsApp')
                    : t('admin.overviewAnswers.actionConnectWhatsApp')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  {isWaFullyConnected 
                    ? `${waConnectedCount} aktif oturum bağlı ve mesaj almaya hazır.`
                    : 'Yeni bir WhatsApp hattı bağlayın veya QR kodu taratın.'}
                </p>
              </div>
            </Card>

            {/* Buton 2: WhatsApp Durumunu Kontrol Et */}
            <Card 
              onClick={handleCheckWhatsApp}
              className="border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all cursor-pointer p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="p-2.5 rounded-xl bg-[#7367F0]/10 text-[#7367F0] group-hover:bg-[#7367F0] group-hover:text-white transition-colors">
                  {isCheckingWa ? <Loader2 className="w-5 h-5 animate-spin" /> : <Radio className="w-5 h-5" />}
                </div>
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  Tanılama
                </span>
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {isCheckingWa 
                    ? t('admin.overviewAnswers.actionCheckingWhatsApp') 
                    : t('admin.overviewAnswers.actionCheckWhatsApp')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  Ağ geçidi bağlantısını ve anlık mesaj kuyruğunu anında test edin.
                </p>
              </div>
            </Card>

            {/* Buton 3: Şimdi Yedek Al */}
            <Card 
              onClick={handleRunBackup}
              className={`border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between ${
                isBackingUp ? 'opacity-80 pointer-events-none' : 'cursor-pointer'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-500 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                  {isBackingUp ? <Loader2 className="w-5 h-5 animate-spin" /> : <Database className="w-5 h-5" />}
                </div>
                <span className="text-[10px] font-bold text-indigo-500 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 px-2 py-0.5 rounded">
                  Doğrudan İşlem
                </span>
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {isBackingUp 
                    ? t('admin.overviewAnswers.actionBackingUp') 
                    : t('admin.overviewAnswers.actionTakeBackup')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  Veritabanı ve sistem yapılandırmasının tam yedeğini tek tıkla oluşturun.
                </p>
              </div>
            </Card>

            {/* Buton 4: Son Yedeği Görüntüle */}
            <Card 
              onClick={() => onNavigate?.('admin-backups')}
              className="border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all cursor-pointer p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                  <Clock className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                  {latestBackupSize || '—'}
                </span>
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {t('admin.overviewAnswers.actionViewBackup')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  {latestBackupTime ? `Son yedek: ${formatDateTime(latestBackupTime)}` : 'Henüz arşivlenmiş yedek bulunmuyor.'}
                </p>
              </div>
            </Card>

            {/* Buton 5: Sistem Sorunlarını Gör */}
            <Card 
              onClick={() => {
                const el = document.getElementById('active-issues-section');
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth' });
                } else if (onNavigate) {
                  onNavigate('admin-operations');
                }
              }}
              className="border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all cursor-pointer p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-3">
                <div className={`p-2.5 rounded-xl transition-colors ${
                  issuesList.length > 0 
                    ? 'bg-rose-500/10 text-rose-500 group-hover:bg-rose-500 group-hover:text-white' 
                    : 'bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500 group-hover:text-white'
                }`}>
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <StatusBadge 
                  status={issuesList.length > 0 ? 'warning' : 'online'} 
                  label={issuesList.length > 0 ? `${issuesList.length} Konu` : 'Sorun Yok'} 
                  size="sm" 
                />
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {t('admin.overviewAnswers.actionViewIssues')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  {issuesList.length > 0 
                    ? `${issuesList.length} müdahale gerektiren konuyu inceleyin.`
                    : 'Sistemde tespit edilen kritik bir sorun bulunmuyor.'}
                </p>
              </div>
            </Card>

            {/* Buton 6: Dağıtım Durumunu Gör */}
            <Card 
              onClick={() => onNavigate?.('admin-operations')}
              className="border border-slate-200/80 dark:border-white/[0.08] hover:border-[#7367F0]/50 hover:shadow-md transition-all cursor-pointer p-4 bg-white dark:bg-[#2F3349] group flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-500 group-hover:bg-cyan-500 group-hover:text-white transition-colors">
                  <Server className="w-5 h-5" />
                </div>
                <span className="text-[10px] font-semibold text-slate-400">
                  {data.containers.filter(c => c.status.toLowerCase() === 'running').length} / {data.containers.length} Servis
                </span>
              </div>
              <div className="mt-3 space-y-1">
                <h3 className="text-sm font-bold text-slate-800 dark:text-white group-hover:text-[#7367F0] transition-colors">
                  {t('admin.overviewAnswers.actionViewDeployment')}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  Canlı sürüm, git commit geçmişi ve servis çalışma durumlarını açın.
                </p>
              </div>
            </Card>
          </div>
        </div>

        {/* =========================================================================
            BÖLÜM 2: ŞU AN BİR SORUN VAR MI? (Gerçek sistem verilerine dayalı)
           ========================================================================= */}
        <div id="active-issues-section" className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-[#7367F0]" />
                <span>{t('admin.overviewAnswers.issuesTitle')}</span>
              </h2>
              <p className="text-xs text-slate-400 dark:text-[#7E7F96]">
                Sistem durumu ve müdahale gerektiren operasyonel konular
              </p>
            </div>
            {issuesList.length > 0 && (
              <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                {issuesList.length} Aktif Konu
              </span>
            )}
          </div>

          {issuesList.length === 0 ? (
            /* Sistem Tamamen Sağlıklı Durum Kartı */
            <Card className="border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/15 p-6 rounded-2xl shadow-xs">
              <div className="flex items-start sm:items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-[#28C76F] flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-7 h-7 text-[#28C76F]" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-emerald-800 dark:text-emerald-300">
                    {t('admin.overviewAnswers.allClearTitle')}
                  </h3>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">
                    {t('admin.overviewAnswers.allClearDesc')}
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            /* Aktif Sorunlar Listesi */
            <div className="space-y-3.5">
              {issuesList.map((issue) => (
                <AdminActionIssueCard
                  key={issue.id}
                  title={issue.title}
                  description={issue.description}
                  severity={issue.severity}
                  statusLabel={issue.statusLabel}
                  impact={issue.impact}
                  recommendedAction={issue.recommendedAction}
                  primaryAction={issue.primaryAction}
                  secondaryAction={issue.secondaryAction}
                />
              ))}
            </div>
          )}
        </div>

        {/* =========================================================================
            BÖLÜM 3: GELİŞMİŞ SİSTEM METRİKLERİ & KONTEYNERLER (Varsayılan Kapalı)
           ========================================================================= */}
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
                  subText={`${t('admin.memoryTotal')}: ${(data.system.memory_total_mb / 1024).toFixed(1)} GB`}
                  icon={Activity}
                  iconVariant="warning"
                />

                {/* Disk */}
                <StatsCard
                  title={t('admin.disk')}
                  value={`${data.system.disk_used_percent}%`}
                  subText={`${data.system.disk_used_gb} GB / ${data.system.disk_total_gb} GB`}
                  icon={HardDrive}
                  iconVariant={data.system.disk_used_percent > 85 ? 'danger' : 'success'}
                />

                {/* Uptime */}
                <StatsCard
                  title={t('admin.hostUptime')}
                  value={formatUptime(data.system.uptime, true)}
                  subText={data.system.reboot_required ? t('admin.rebootRequiredBadge') : t('admin.rebootNotRequiredBadge')}
                  icon={Clock}
                  iconVariant={data.system.reboot_required ? 'warning' : 'primary'}
                />
              </div>

              {/* Containers & Database Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Production Containers Table */}
                <Card className="lg:col-span-2 border border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.01]">
                  <CardHeader className="p-4 border-b border-slate-100 dark:border-white/[0.06]">
                    <CardTitle className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-2">
                      <Layers className="w-4 h-4 text-[#7367F0]" />
                      <span>{t('admin.productionServices')}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-100/70 dark:bg-white/[0.03] text-slate-400 dark:text-[#7E7F96] uppercase text-[10px] font-semibold border-b border-slate-100 dark:border-white/[0.06]">
                        <tr>
                          <th className="py-2.5 px-4">Servis</th>
                          <th className="py-2.5 px-4">Durum</th>
                          <th className="py-2.5 px-4">Yeniden Başlatma</th>
                          <th className="py-2.5 px-4">Bellek (RSS)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                        {data.containers.map((c) => (
                          <tr key={c.name} className="hover:bg-slate-100/40 dark:hover:bg-white/[0.02]">
                            <td className="py-2.5 px-4 font-semibold text-slate-800 dark:text-white">
                              {c.name}
                            </td>
                            <td className="py-2.5 px-4">
                              <StatusBadge
                                status={c.status.toLowerCase() === 'running' ? 'online' : 'danger'}
                                label={c.status.toUpperCase()}
                                size="sm"
                              />
                            </td>
                            <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">
                              {c.restart_count}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500">
                              {c.rss_mb ? `${c.rss_mb} MB` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                {/* Database Connection Pool */}
                <Card className="border border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.01]">
                  <CardHeader className="p-4 border-b border-slate-100 dark:border-white/[0.06]">
                    <CardTitle className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-2">
                      <Database className="w-4 h-4 text-[#7367F0]" />
                      <span>{t('admin.database')}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-3 text-xs">
                    <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-white/[0.04]">
                      <span className="text-slate-500 dark:text-slate-400">{t('admin.dbHealth')}</span>
                      <StatusBadge
                        status={data.database.health === 'healthy' ? 'online' : 'danger'}
                        label={data.database.health.toUpperCase()}
                        size="sm"
                      />
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-white/[0.04]">
                      <span className="text-slate-500 dark:text-slate-400">{t('admin.dbSize')}</span>
                      <span className="font-semibold text-slate-800 dark:text-white">
                        {data.database.database_size_mb} MB
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-white/[0.04]">
                      <span className="text-slate-500 dark:text-slate-400">{t('admin.activeConnections')}</span>
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                        {data.database.connections_active}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-500 dark:text-slate-400">{t('admin.totalConnections')}</span>
                      <span className="font-semibold text-slate-800 dark:text-white">
                        {data.database.connections_total}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
};
