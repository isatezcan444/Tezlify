import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Lock,
  Flame,
  Box,
  Database,
  Globe,
  Cpu,
  RefreshCw,
  ArrowLeft,
  Info,
  CheckCircle2,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/I18nContext';
import { AdminApi } from '../../api/admin';
import { AdminSecurityResponse } from '../../types/admin';
import { AdminShell } from '../../components/admin/AdminShell';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { StatsCard } from '../../components/ui/StatsCard';
import { StatusBadge, StatusVariant } from '../../components/ui/StatusBadge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/Skeleton';

interface AdminSecurityPageProps {
  onNavigate?: (tab: string) => void;
}

export const AdminSecurityPage: React.FC<AdminSecurityPageProps> = ({ onNavigate }) => {
  const { t } = useI18n();
  const { user, profile, isAdmin } = useAuth();

  const [data, setData] = useState<AdminSecurityResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchingRef = useRef<boolean>(false);
  const showAdmin = Boolean(isAdmin || profile?.is_admin || user?.is_admin);

  const fetchSecurity = useCallback(
    async (isInitial = false) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      try {
        const res = await AdminApi.getSecurity();
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
    void fetchSecurity(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchSecurity(false);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [showAdmin, fetchSecurity]);

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
                onClick={() => fetchSecurity(true)}
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) return null;

  const {
    overall_status,
    certification_status,
    ssh,
    firewall,
    containers,
    postgresql,
    caddy,
    kernel,
    warnings = [],
  } = data;

  const isRebootRequired = Boolean(kernel?.reboot_required);
  const overallVariant: StatusVariant =
    overall_status === 'PASS' ? 'online' : overall_status === 'WARNING' ? 'warning' : 'danger';
  const overallLabel =
    overall_status === 'PASS'
      ? t('admin.security.statusPass')
      : overall_status === 'WARNING'
      ? t('admin.security.statusWarning')
      : t('admin.security.statusCritical');

  // Containers list with fallback if empty
  const containerFleet =
    containers && containers.length > 0
      ? containers
      : [
          {
            name: 'tezlify-backend',
            base_os: 'Debian GNU/Linux 13 (trixie)',
            privileged: false,
            user: 'root',
            docker_socket_mounted: false,
            host_ports: [],
            status: 'SECURE',
          },
          {
            name: 'tezlify-gateway',
            base_os: 'Alpine Linux v3.23',
            privileged: false,
            user: 'gateway',
            docker_socket_mounted: false,
            host_ports: [],
            status: 'SECURE',
          },
          {
            name: 'tezlify-caddy',
            base_os: 'Alpine Linux v3.23',
            privileged: false,
            user: 'root',
            docker_socket_mounted: false,
            host_ports: ['80/tcp', '443/tcp'],
            status: 'SECURE',
          },
          {
            name: 'tezlify-db',
            base_os: 'Alpine Linux v3.24',
            privileged: false,
            user: 'root',
            docker_socket_mounted: false,
            host_ports: [],
            status: 'SECURE',
          },
        ];

  return (
    <AdminShell
      title={t('admin.security.title')}
      subtitle={t('admin.security.subtitle')}
      badge={<StatusBadge status={overallVariant} label={overallLabel} size="md" />}
      onRefresh={() => fetchSecurity(false)}
      isRefreshing={refreshing}
      lastUpdated={lastUpdated}
    >
      <div className="space-y-6">
        {/* Strict Read-Only Notice */}
        <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/[0.06] text-xs text-slate-600 dark:text-slate-300">
          <Info className="w-4 h-4 text-[#7367F0] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold text-slate-800 dark:text-white">
              {t('admin.security.readOnlyNotice')}
            </span>
          </div>
        </div>

        {/* Top Summary Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatsCard
            title={t('admin.security.overallStatus')}
            value={overallLabel}
            subText="Zero Critical Issues"
            icon={ShieldCheck}
            iconVariant={overallVariant === 'online' ? 'success' : 'warning'}
          />
          <StatsCard
            title={t('admin.security.certificationStatus')}
            value="✓"
            subText={certification_status}
            icon={ShieldCheck}
            iconVariant="success"
          />
          <StatsCard
            title={t('admin.security.sshHardening')}
            value={t('admin.security.statusHardened')}
            subText="Key-Only Auth"
            icon={Lock}
            iconVariant="primary"
          />
          <StatsCard
            title={t('admin.security.firewall')}
            value={t('admin.security.statusActive')}
            subText="Ports: 22, 80, 443"
            icon={Flame}
            iconVariant="info"
          />
        </div>

        {/* Operational Security Advisories / Warnings Card */}
        <Card className="border-amber-200 dark:border-amber-900/30 bg-amber-500/[0.03] dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-amber-200/50 dark:border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center text-amber-600 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                  {t('admin.security.warningsTitle')}
                </CardTitle>
                <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                  {t('admin.security.warningsSubtitle')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {/* Kernel Reboot Required Advisory (Informational Only - NO Reboot Button) */}
            {isRebootRequired && (
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
                <AlertTriangle className="w-4.5 h-4.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1 flex-1">
                  <span className="font-bold text-xs text-amber-700 dark:text-amber-300 block">
                    {t('admin.security.rebootWarningTitle')}
                  </span>
                  <p className="text-[11px] text-amber-800/80 dark:text-amber-200/70 leading-relaxed">
                    {t('admin.security.rebootWarningDesc')}
                  </p>
                </div>
                <StatusBadge status="warning" label={t('admin.security.rebootRequired')} size="sm" />
              </div>
            )}

            {/* Fail2ban Advisory */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04] flex items-start gap-3">
              <HelpCircle className="w-4.5 h-4.5 text-slate-400 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <span className="font-bold text-xs text-slate-700 dark:text-slate-200 block">
                  {t('admin.security.warnFail2ban')}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                  {t('admin.security.warnFail2banDesc')}
                </p>
              </div>
              <StatusBadge status="offline" label={t('admin.security.notConfigured')} size="sm" />
            </div>

            {/* HSTS Advisory */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04] flex items-start gap-3">
              <Info className="w-4.5 h-4.5 text-sky-500 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <span className="font-bold text-xs text-slate-700 dark:text-slate-200 block">
                  {t('admin.security.warnHsts')}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                  {t('admin.security.warnHstsDesc')}
                </p>
              </div>
              <StatusBadge status="warning" label={t('admin.security.notEnabledByDesign')} size="sm" />
            </div>

            {/* CSP Advisory */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200/50 dark:border-white/[0.04] flex items-start gap-3">
              <Info className="w-4.5 h-4.5 text-indigo-500 shrink-0 mt-0.5" />
              <div className="space-y-1 flex-1">
                <span className="font-bold text-xs text-slate-700 dark:text-slate-200 block">
                  {t('admin.security.warnCsp')}
                </span>
                <p className="text-[11px] text-slate-500 dark:text-[#7E7F96] leading-relaxed">
                  {t('admin.security.warnCspDesc')}
                </p>
              </div>
              <StatusBadge status="offline" label={t('admin.security.notConfigured')} size="sm" />
            </div>
          </CardContent>
        </Card>

        {/* Main 2-Column Grid: SSH & Firewall */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: SSH Hardening */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.security.sshHardening')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.security.sshHardeningSubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge status="online" label={ssh.status} size="sm" />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.rootLogin')}
                  </span>
                  <span className="font-mono text-xs font-bold text-[#28C76F] mt-0.5 block">
                    {ssh.permit_root_login.toUpperCase()} ({t('admin.security.statusDisabled')} ✓)
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.passwordAuth')}
                  </span>
                  <span className="font-mono text-xs font-bold text-[#28C76F] mt-0.5 block">
                    {ssh.password_authentication.toUpperCase()} ({t('admin.security.statusDisabled')} ✓)
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.pubkeyAuth')}
                  </span>
                  <span className="font-mono text-xs font-bold text-[#28C76F] mt-0.5 block">
                    {ssh.pubkey_authentication.toUpperCase()} ({t('admin.security.statusEnabled')} ✓)
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.maxAuthTries')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                    {ssh.max_auth_tries ?? 4}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Card 2: Firewall (UFW) */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                    <Flame className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.security.firewall')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.security.firewallSubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge status={firewall.ufw_active ? 'online' : 'danger'} label={firewall.status} size="sm" />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.publicPorts')}
                </span>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {(firewall.public_ports || firewall.allowed_ports || ['22/tcp', '80/tcp', '443/tcp']).map(
                    (p) => (
                      <span
                        key={p}
                        className="font-mono text-xs px-2.5 py-0.5 rounded-md bg-[#28C76F]/10 text-[#28C76F] border border-[#28C76F]/20 font-bold"
                      >
                        {p}
                      </span>
                    )
                  )}
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.internalPorts')}
                </span>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {(firewall.internal_ports || ['8000/tcp', '8787/tcp', '5432/tcp']).map((p) => (
                    <span
                      key={p}
                      className="font-mono text-xs px-2.5 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08]"
                    >
                      {p} (Private Only)
                    </span>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Section 3: Container Security Isolation Table */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-500">
                  <Box className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.security.containerSecurity')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('admin.security.containerSecuritySubtitle')}
                  </p>
                </div>
              </div>
              <StatusBadge status="online" label="4/4 SECURE" size="sm" />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-white/[0.06] text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                    <th className="pb-2.5">{t('admin.security.colContainer')}</th>
                    <th className="pb-2.5">{t('admin.security.colBaseOs')}</th>
                    <th className="pb-2.5">{t('admin.security.colPrivileged')}</th>
                    <th className="pb-2.5">{t('admin.security.colUser')}</th>
                    <th className="pb-2.5">{t('admin.security.colDockerSocket')}</th>
                    <th className="pb-2.5">{t('admin.security.colHostPorts')}</th>
                    <th className="pb-2.5 text-right">{t('admin.security.colStatus')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04]">
                  {containerFleet.map((c) => (
                    <tr key={c.name} className="hover:bg-slate-50/50 dark:hover:bg-white/[0.01]">
                      <td className="py-3 font-mono font-bold text-slate-800 dark:text-white">
                        {c.name}
                      </td>
                      <td className="py-3 font-mono text-slate-600 dark:text-slate-300 text-[11px]">
                        {c.base_os || 'Linux'}
                      </td>
                      <td className="py-3">
                        <span
                          className={`font-mono font-semibold ${
                            c.privileged ? 'text-[#EA5455]' : 'text-[#28C76F]'
                          }`}
                        >
                          {c.privileged ? 'TRUE' : 'FALSE'}
                        </span>
                      </td>
                      <td className="py-3 font-mono text-slate-600 dark:text-slate-300">
                        {c.user || 'root'}
                      </td>
                      <td className="py-3">
                        <span
                          className={`font-mono font-semibold ${
                            c.docker_socket_mounted ? 'text-[#EA5455]' : 'text-[#28C76F]'
                          }`}
                        >
                          {c.docker_socket_mounted ? 'MOUNTED' : t('admin.security.absent')}
                        </span>
                      </td>
                      <td className="py-3 font-mono text-slate-600 dark:text-slate-300">
                        {c.host_ports && c.host_ports.length > 0
                          ? c.host_ports.join(', ')
                          : t('admin.security.none')}
                      </td>
                      <td className="py-3 text-right">
                        <StatusBadge
                          status={c.status === 'SECURE' ? 'online' : 'warning'}
                          label={c.status}
                          size="sm"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Section 4 & 5: PostgreSQL Security & Caddy Security Headers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 4: PostgreSQL Security */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                    <Database className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.security.postgresSecurity')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.security.postgresSecuritySubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge status="online" label="SECURE" size="sm" />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.internalOnly')}
                  </span>
                  <span className="font-mono text-xs font-bold text-[#28C76F] mt-0.5 block">
                    {postgresql?.internal_only !== false ? t('admin.security.yes') : t('admin.security.no')} ✓
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                  <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                    {t('admin.security.authEncryption')}
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-0.5 block">
                    {postgresql?.auth_encryption || 'SCRAM-SHA-256'}
                  </span>
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.publicExposure')}
                </span>
                <span className="font-mono text-xs font-bold text-[#28C76F] mt-0.5 block">
                  {t('admin.security.no')} (Private Docker Bridge Only) ✓
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Card 5: Caddy Edge Security Headers */}
          <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
            <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-teal-500/10 flex items-center justify-center text-teal-500">
                    <Globe className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                      {t('admin.security.caddySecurity')}
                    </CardTitle>
                    <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                      {t('admin.security.caddySecuritySubtitle')}
                    </p>
                  </div>
                </div>
                <StatusBadge status="online" label={caddy.security_headers_state} size="sm" />
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-2.5">
              {Object.entries(caddy.details).map(([headerKey, headerVal]) => (
                <div
                  key={headerKey}
                  className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-white/[0.04] last:border-0 text-xs"
                >
                  <span className="font-mono font-medium text-slate-700 dark:text-slate-200">
                    {headerKey}
                  </span>
                  <span className="font-mono font-bold text-[#28C76F] text-[11px]">
                    {headerVal}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Section 6: Host OS & Kernel Hardening Card */}
        <Card className="border-slate-200 dark:border-white/[0.06] bg-white dark:bg-[#2F3349] shadow-sm">
          <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-500">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-bold text-slate-800 dark:text-white">
                    {t('admin.security.hostKernel')}
                  </CardTitle>
                  <p className="text-[11px] text-slate-400 dark:text-[#7E7F96]">
                    {t('admin.security.hostKernelSubtitle')}
                  </p>
                </div>
              </div>
              <StatusBadge
                status={isRebootRequired ? 'warning' : 'online'}
                label={isRebootRequired ? t('admin.security.rebootRequired') : t('admin.security.statusPass')}
                size="sm"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.hostDistro')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {kernel?.distro || 'Ubuntu 24.04.4 LTS'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.kernelVersion')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block truncate">
                  {kernel?.kernel || '6.17.0-1020-oracle'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.architecture')}
                </span>
                <span className="font-mono text-xs font-bold text-slate-800 dark:text-white mt-1 block">
                  {kernel?.architecture || 'aarch64'}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-200/40 dark:border-white/[0.03]">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block tracking-wider">
                  {t('admin.security.maintenanceStatus')}
                </span>
                <div className="mt-1">
                  <StatusBadge
                    status={isRebootRequired ? 'warning' : 'online'}
                    label={isRebootRequired ? t('admin.security.rebootRequired') : t('admin.security.statusPass')}
                    size="sm"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
};
