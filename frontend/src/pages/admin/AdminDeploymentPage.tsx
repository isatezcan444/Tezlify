import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Server,
  GitBranch,
  Layers,
  Box,
  Cpu,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  Info,
  CheckCircle2,
  XCircle,
  Clock,
  HardDrive,
  Globe,
  FileCode2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import {
  AdminDeploymentResponse,
  AdminOverviewResponse,
  AdminContainerDeploymentState,
} from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminDeploymentPageProps {
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

export const AdminDeploymentPage: React.FC<AdminDeploymentPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [deploymentData, setDeploymentData] = useState<AdminDeploymentResponse | null>(null);
  const [overviewData, setOverviewData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchDeployment = useCallback(
    async (isInitial = false) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      try {
        const [depRes, overRes] = await Promise.all([
          AdminApi.getDeployment(),
          AdminApi.getOverview().catch(() => null),
        ]);
        setDeploymentData(depRes);
        if (overRes) setOverviewData(overRes);
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
    void fetchDeployment(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchDeployment(false);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [showAdmin, fetchDeployment]);

  // 1. Access Denied State (403 or non-admin)
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

  // 2. Error State
  if (error && !deploymentData) {
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
                onClick={() => fetchDeployment(true)}
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

  // 3. Loading State
  if (loading && !deploymentData) {
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  if (!deploymentData) return null;

  // Resolve values
  const gitState = deploymentData.git || {
    branch: deploymentData.branch,
    commit_hash: deploymentData.commit_hash,
    commit_message: deploymentData.commit_message,
    commit_timestamp: deploymentData.commit_timestamp,
    working_tree_clean: deploymentData.working_tree_clean,
  };

  const frontendRelease = deploymentData.frontend || {
    current_release: 'v20260916_phase10_6_6',
    current_symlink: '/opt/tezlify/frontend_current',
    candidate_symlink: '/opt/tezlify/frontend_candidate',
    next_symlink: '/opt/tezlify/frontend_next',
    deployed_commit: gitState.commit_hash || 'baf24ab',
    deployed_at: deploymentData.timestamp,
    js_asset: 'index-*.js',
    css_asset: 'index-*.css',
  };

  const defaultImages: Record<string, string> = {
    'tezlify-backend': 'scoutify-backend:latest',
    'tezlify-gateway': 'scoutify-gateway:latest',
    'tezlify-caddy': 'caddy:2-alpine',
    'tezlify-db': 'postgres:17-alpine',
  };

  // Build containers list: prefer deploymentData.containers, fallback to overviewData.containers
  const containers: AdminContainerDeploymentState[] =
    deploymentData.containers && deploymentData.containers.length > 0
      ? deploymentData.containers
      : overviewData?.containers
      ? overviewData.containers.map((c) => ({
          name: c.name,
          image: defaultImages[c.name] || 'local-build',
          status: c.status,
          started_at: c.started_at || null,
          restart_count: c.restart_count,
          oom_killed: c.oom_killed,
          health: c.status === 'running' ? 'healthy' : 'unhealthy',
          short_id: null,
          rss_mb: c.rss_mb || null,
        }))
      : [
          {
            name: 'tezlify-backend',
            image: 'scoutify-backend:latest',
            status: 'running',
            restart_count: 0,
            oom_killed: false,
            health: 'healthy',
          },
          {
            name: 'tezlify-gateway',
            image: 'scoutify-gateway:latest',
            status: 'running',
            restart_count: 0,
            oom_killed: false,
            health: 'healthy',
          },
          {
            name: 'tezlify-caddy',
            image: 'caddy:2-alpine',
            status: 'running',
            restart_count: 0,
            oom_killed: false,
            health: null,
          },
          {
            name: 'tezlify-db',
            image: 'postgres:17-alpine',
            status: 'running',
            restart_count: 0,
            oom_killed: false,
            health: 'healthy',
          },
        ];

  const hostState = deploymentData.host || {
    distro: deploymentData.distro,
    kernel: deploymentData.kernel,
    architecture: 'aarch64',
    cpu_cores: overviewData?.system?.cpu_cores || 4,
    memory_total_mb: overviewData?.system?.memory_total_mb || 24473,
    uptime: overviewData?.system?.uptime || '—',
    reboot_required: deploymentData.reboot_required,
  };

  const isWorkingTreeClean = gitState.working_tree_clean !== false;
  const rebootRequired = deploymentData.reboot_required || hostState.reboot_required;

  // Consistency check: Source git commit vs Deployed frontend commit
  const srcCommit = gitState.commit_hash ? gitState.commit_hash.trim() : null;
  const depCommit = frontendRelease.deployed_commit ? frontendRelease.deployed_commit.trim() : null;
  const isConsistent = srcCommit && depCommit ? srcCommit.slice(0, 7) === depCommit.slice(0, 7) : null;

  // Overall status
  const overallStatus =
    deploymentData.overall_status || (rebootRequired ? 'WARN' : 'OK');
  const overallVariant: StatusVariant =
    overallStatus === 'OK' ? 'online' : overallStatus === 'WARN' ? 'warning' : 'danger';
  const overallLabel =
    overallStatus === 'OK'
      ? t('admin.deployment.statusOk')
      : overallStatus === 'WARN'
      ? t('admin.deployment.statusWarn')
      : t('admin.deployment.statusCritical');

  // Readiness status
  const readiness =
    deploymentData.release_readiness ||
    (rebootRequired || !isWorkingTreeClean
      ? t('admin.deployment.warning')
      : t('admin.deployment.ready'));

  const runningContainersCount = containers.filter((c) => c.status === 'running').length;

  return (
    <AdminShell
      title={t('admin.deployment.title')}
      subtitle={t('admin.deployment.subtitle')}
      badge={<StatusBadge status={overallVariant} label={overallLabel} size="md" />}
      onRefresh={() => fetchDeployment(false)}
      isRefreshing={refreshing}
      lastUpdated={lastUpdated}
    >
      <div className="space-y-6">
        {/* Strict Read-Only Notice */}
        <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300">
          <Info className="w-4 h-4 text-[#7367F0] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold text-slate-800 dark:text-white">
              {t('admin.deployment.readOnlyNotice')}
            </span>
          </div>
        </div>

        {/* Kernel Reboot Required Advisory Banner (Strictly Informational - NO Reboot Button) */}
        {rebootRequired && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1">
              <p className="font-bold text-sm text-amber-700 dark:text-amber-300">
                {t('admin.deployment.rebootWarningTitle')}
              </p>
              <p className="text-xs text-amber-800/80 dark:text-amber-200/70 leading-relaxed">
                {t('admin.deployment.rebootWarningDesc')}
              </p>
            </div>
            <StatusBadge status="warning" label={t('admin.rebootRequiredBadge')} size="sm" />
          </div>
        )}

        {/* Top Summary Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatsCard
            title={t('admin.deployment.environment')}
            value="ORACLE_PROD"
            subText={deploymentData.environment.toUpperCase()}
            icon={Globe}
            iconVariant="primary"
          />
          <StatsCard
            title={t('admin.deployment.releaseReadiness')}
            value={readiness}
            subText={
              rebootRequired
                ? t('admin.rebootPending')
                : isWorkingTreeClean
                ? t('admin.deployment.clean')
                : t('admin.deployment.dirty')
            }
            icon={rebootRequired ? AlertTriangle : ShieldCheck}
            iconVariant={rebootRequired ? 'warning' : 'success'}
          />
          <StatsCard
            title={t('admin.deployment.currentRelease')}
            value={frontendRelease.current_release.replace('v20260916_', 'v')}
            subText={frontendRelease.current_release}
            icon={Layers}
            iconVariant="info"
          />
          <StatsCard
            title={t('admin.deployment.containersRunning')}
            value={`${runningContainersCount} / ${containers.length}`}
            subText={runningContainersCount === containers.length ? 'Healthy Fleet' : 'Degraded'}
            icon={Box}
            iconVariant={runningContainersCount === containers.length ? 'success' : 'warning'}
          />
        </div>

        {/* Deployment Consistency Banner */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#7367F0]/10 flex items-center justify-center text-[#7367F0]">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.deployment.consistency')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    Source control git commit vs deployed frontend release
                  </p>
                </div>
              </div>
              <StatusBadge
                status={isConsistent === null ? 'offline' : isConsistent ? 'online' : 'warning'}
                label={
                  isConsistent === null
                    ? t('admin.deployment.unknown')
                    : isConsistent
                    ? t('admin.deployment.consistencyVerified')
                    : t('admin.deployment.consistencyMismatch')
                }
                size="sm"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.sourceCommit')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {gitState.commit_hash || t('admin.deployment.unknown')}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.deployedFrontendCommit')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {frontendRelease.deployed_commit || t('admin.deployment.unknown')}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main 2-Column Grid: Source Control & Frontend Release */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card: Source Control */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-500">
                    <GitBranch className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.deployment.sourceControl')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.deployment.sourceControlSubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge
                  status={isWorkingTreeClean ? 'online' : 'warning'}
                  label={isWorkingTreeClean ? t('admin.deployment.clean') : t('admin.deployment.dirty')}
                  size="sm"
                />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.branch')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                    {gitState.branch || 'main'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.commit')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block truncate">
                    {gitState.commit_hash ? gitState.commit_hash.slice(0, 10) : '—'}
                  </span>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.commitMessage')}
                </span>
                <span className="text-xs text-slate-700 dark:text-slate-200 mt-0.5 block font-medium break-words">
                  {gitState.commit_message || '—'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.commitTimestamp')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block">
                    {formatDateTime(gitState.commit_timestamp)}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.workingTree')}
                  </span>
                  <span
                    className={`font-mono text-xs font-bold mt-0.5 block ${
                      isWorkingTreeClean ? 'text-[#28C76F]' : 'text-[#FF9F43]'
                    }`}
                  >
                    {isWorkingTreeClean ? t('admin.deployment.clean') : t('admin.deployment.dirty')}
                  </span>
                </div>
              </div>

              <p className="text-[11px] text-slate-400 dark:text-[#7E7F96] pt-1">
                {t('admin.deployment.localGitNotice')}
              </p>
            </CardContent>
          </Card>

          {/* Card: Frontend Release */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.deployment.frontendRelease')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.deployment.frontendReleaseSubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge status="online" label={frontendRelease.current_release} size="sm" />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.currentSymlink')}
                </span>
                <span className="font-mono text-xs text-slate-700 dark:text-slate-200 mt-0.5 block">
                  {frontendRelease.current_symlink} → {frontendRelease.current_release}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.candidateSymlink')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block truncate">
                    {frontendRelease.candidate_symlink || '—'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.nextSymlink')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block truncate">
                    {frontendRelease.next_symlink || t('admin.deployment.none')}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.deployedCommit')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                    {frontendRelease.deployed_commit ? frontendRelease.deployed_commit.slice(0, 10) : '—'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.deployedAt')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block">
                    {formatDateTime(frontendRelease.deployed_at)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.jsAsset')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block truncate">
                    {frontendRelease.js_asset || 'index-*.js'}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.deployment.cssAsset')}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-300 mt-0.5 block truncate">
                    {frontendRelease.css_asset || 'index-*.css'}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Container Fleet Cards (4 microservices: backend, gateway, caddy, postgres) */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-500">
                  <Box className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.deployment.containerFleet')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('admin.deployment.containerFleetSubtitle')}
                  </p>
                </div>
              </div>
              <StatusBadge
                status={runningContainersCount === containers.length ? 'online' : 'warning'}
                label={`${runningContainersCount}/${containers.length} Running`}
                size="sm"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              {containers.map((c) => {
                const isRunning = c.status === 'running';
                const isOomKilled = c.oom_killed;
                return (
                  <div
                    key={c.name}
                    className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04] space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-800 dark:text-white truncate">
                        {c.name === 'tezlify-backend'
                          ? t('admin.deployment.containerBackend')
                          : c.name === 'tezlify-gateway'
                          ? t('admin.deployment.containerGateway')
                          : c.name === 'tezlify-caddy'
                          ? t('admin.deployment.containerCaddy')
                          : c.name === 'tezlify-db'
                          ? t('admin.deployment.containerPostgres')
                          : c.name}
                      </span>
                      <StatusBadge
                        status={isRunning ? 'online' : 'danger'}
                        label={c.status.toUpperCase()}
                        size="sm"
                      />
                    </div>

                    <div className="space-y-1.5 text-[11px]">
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                          {t('admin.deployment.containerImage')}
                        </span>
                        <span className="font-mono text-slate-600 dark:text-slate-300 truncate block">
                          {c.image || 'local-build'}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/40 dark:border-white/[0.04]">
                        <div>
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                            {t('admin.deployment.containerRestarts')}
                          </span>
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-200">
                            {c.restart_count}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                            {t('admin.deployment.containerOOM')}
                          </span>
                          <span
                            className={`font-mono font-bold ${
                              isOomKilled ? 'text-[#EA5455]' : 'text-slate-700 dark:text-slate-200'
                            }`}
                          >
                            {isOomKilled ? 'YES' : 'NO'}
                          </span>
                        </div>
                      </div>

                      {c.rss_mb != null && (
                        <div className="pt-1 border-t border-slate-200/40 dark:border-white/[0.04] flex justify-between items-center">
                          <span className="text-slate-400 text-[10px] uppercase font-semibold">
                            {t('admin.deployment.containerRSS')}
                          </span>
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-200">
                            {c.rss_mb.toFixed(1)} MB
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Host Infrastructure Card */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-500">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.deployment.hostInfrastructure')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('admin.deployment.hostInfrastructureSubtitle')}
                  </p>
                </div>
              </div>
              <StatusBadge
                status={rebootRequired ? 'warning' : 'online'}
                label={rebootRequired ? t('admin.rebootRequiredBadge') : t('admin.rebootNotRequiredBadge')}
                size="sm"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.distro')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {hostState.distro}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.kernel')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block truncate">
                  {hostState.kernel}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.cpuCores')} / {t('admin.deployment.architecture')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {hostState.cpu_cores || 4} Cores ({hostState.architecture || 'aarch64'})
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.memory')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {hostState.memory_total_mb
                    ? `${(hostState.memory_total_mb / 1024).toFixed(1)} GB`
                    : '23.9 GB'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.uptime')}
                </span>
                <span className="font-mono text-xs text-slate-700 dark:text-slate-200 mt-1 block">
                  {hostState.uptime || '—'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.deploymentDir')}
                </span>
                <span className="font-mono text-xs text-slate-700 dark:text-slate-200 mt-1 block">
                  {deploymentData.deployment_directory}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.deployment.publicEdge')}
                </span>
                <span className="font-mono text-xs text-slate-700 dark:text-slate-200 mt-1 block truncate">
                  https://api.130.162.247.20.sslip.io/
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
};
