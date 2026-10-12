import React, { useMemo, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock,
  Database,
  Server,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardHeader, CardTitle, CardContent } from '../../ui/card';
import { StatusBadge, StatusVariant } from '../../ui/StatusBadge';
import { Button } from '../../ui/button';
import { Skeleton } from '../../ui/Skeleton';
import {
  computeExecutiveSummary,
  type ExecutiveHealthState,
  type Incident,
} from './incidentEngine';
import type {
  AdminOverviewResponse,
  OpsHealthCheck,
  OpsOperation,
  OpsServiceStatus,
} from '../../../types/admin';

export interface OverviewPanelProps {
  overview: AdminOverviewResponse | null;
  services: OpsServiceStatus[];
  health: OpsHealthCheck | null;
  operations: OpsOperation[];
  loading?: boolean;
  /** False when the server cannot persist its operation history. */
  persistenceOk?: boolean;
  /**
   * Gateway sessions whose database row no longer exists. They report
   * CONNECTED but nothing they emit is stored, so this is surfaced rather than
   * left for the operator to infer from missing history.
   */
  orphanedCount?: number;
  orphanedDetail?: { id: string; session_name?: string; since?: string | null }[];
  /**
   * Sessions the database calls CONNECTED while the gateway serves nothing for
   * them. Reported separately from `orphanedCount`: an orphan still produces
   * events that reach the backend, whereas a ghost-connected line produces
   * nothing at all.
   */
  ghostConnected?: string[];
  incidents?: Incident[];
  lastUpdated?: string;
  hasTelemetryError?: boolean;
  onNavigateTab?: (tab: 'overview' | 'system' | 'errors' | 'logs' | 'history') => void;
}

/**
 * At-a-glance health of the whole deployment.
 *
 * Composes data the Operations Center ALREADY fetches (the admin overview plus
 * the ops status/health payloads) into a human-centric Executive Health Center.
 */
export function OverviewPanel({
  overview,
  services,
  health,
  operations,
  loading = false,
  persistenceOk = true,
  orphanedCount = 0,
  orphanedDetail = [],
  ghostConnected = [],
  incidents = [],
  lastUpdated = '',
  hasTelemetryError = false,
  onNavigateTab,
}: OverviewPanelProps) {
  const { t } = useI18n();

  if (loading && (!services || services.length === 0)) {
    return (
      <div className="space-y-6">
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
              <div key={i} className="p-3.5 rounded-lg bg-slate-50/80 dark:bg-white/[0.02] border border-slate-100 dark:border-white/[0.04] space-y-2">
                <Skeleton className="h-3 w-20 rounded-md" />
                <Skeleton className="h-5 w-32 rounded-md" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  const executive = useMemo(() => {
    return computeExecutiveSummary({
      services,
      health,
      operations,
      incidents,
      orphanedCount,
      ghostConnected,
      lastUpdated,
      hasTelemetryError,
    });
  }, [
    services,
    health,
    operations,
    incidents,
    orphanedCount,
    ghostConnected,
    lastUpdated,
    hasTelemetryError,
  ]);

  const running = services.filter((s) => s.status === 'running').length;
  const down = services.filter((s) => s.status !== 'running');
  const whatsapp = health?.whatsapp;

  const getExecutiveBadge = (state: ExecutiveHealthState) => {
    switch (state) {
      case 'healthy':
        return {
          variant: 'active' as StatusVariant,
          label: t('admin.ops.statusHealthy'),
          icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
          cardBorder: 'border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/10',
          textColor: 'text-emerald-800 dark:text-emerald-300',
        };
      case 'attention':
        return {
          variant: 'warning' as StatusVariant,
          label: t('admin.attention'),
          icon: <AlertTriangle className="w-4 h-4 text-amber-500" />,
          cardBorder: 'border-amber-200 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/10',
          textColor: 'text-amber-800 dark:text-amber-300',
        };
      case 'critical':
        return {
          variant: 'danger' as StatusVariant,
          label: t('admin.statusCritical'),
          icon: <CircleAlert className="w-4 h-4 text-rose-500" />,
          cardBorder: 'border-rose-200 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/10',
          textColor: 'text-rose-800 dark:text-rose-300',
        };
      case 'unavailable':
      default:
        return {
          variant: 'neutral' as StatusVariant,
          label: t('admin.ops.healthNoData'),
          icon: <Activity className="w-4 h-4 text-slate-400" />,
          cardBorder: 'border-slate-200 dark:border-white/[0.08] bg-slate-50/50 dark:bg-white/[0.02]',
          textColor: 'text-slate-700 dark:text-slate-300',
        };
    }
  };

  const execBadge = getExecutiveBadge(executive.healthState);

  const tiles: { icon: ReactNode; label: string; value: string; tone: string }[] = [
    {
      icon: <Server className="w-4 h-4" />,
      label: t('admin.ops.overviewServices'),
      value: `${running}/${services.length}`,
      tone:
        down.length === 0 && services.length > 0
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-amber-600 dark:text-amber-400',
    },
    {
      icon: <Activity className="w-4 h-4" />,
      label: t('admin.ops.overviewHealth'),
      value: health?.all_healthy ? t('admin.ops.healthAllOk') : t('admin.ops.healthSomeDown'),
      tone: health?.all_healthy
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-amber-600 dark:text-amber-400',
    },
    {
      icon: <Database className="w-4 h-4" />,
      label: t('admin.ops.overviewDatabase'),
      value: overview?.database?.health
        ? String(overview.database.health)
        : t('admin.ops.overviewUnknown'),
      tone: 'text-slate-600 dark:text-slate-300',
    },
    {
      icon: <ShieldCheck className="w-4 h-4" />,
      label: t('admin.ops.overviewWhatsapp'),
      value: whatsapp?.state
        ? String(whatsapp.state)
        : t('admin.ops.overviewUnknown'),
      tone: whatsapp?.connected
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-amber-600 dark:text-amber-400',
    },
  ];

  return (
    <div className="space-y-6">
      {/* 1. Executive Operations Summary Banner */}
      <Card className={`border shadow-sm transition-all duration-200 ${execBadge.cardBorder}`}>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-white dark:bg-[#1E2333] shadow-sm border border-slate-200/60 dark:border-white/[0.08]">
                {execBadge.icon}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-slate-800 dark:text-white">
                    {t('admin.ops.executiveBannerTitle')}
                  </h3>
                  <StatusBadge
                    status={execBadge.variant}
                    label={execBadge.label}
                    size="sm"
                    pulse={executive.healthState === 'critical' || executive.healthState === 'attention'}
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {t(executive.healthDescriptionKey)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 dark:text-slate-500">
              <Clock className="w-3.5 h-3.5" />
              <span>{t('admin.lastUpdated')} {executive.lastUpdated}</span>
            </div>
          </div>

          {/* Executive KPI Matrix */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-white/80 dark:bg-[#1E2333]/70 border border-slate-200/50 dark:border-white/[0.06]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('admin.ops.activeIncidents')}
              </span>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-sm font-bold text-slate-800 dark:text-white">
                  {executive.activeIncidentsCount === 0
                    ? t('admin.ops.noIncidentsReported')
                    : t('admin.ops.incidentsDetected', { count: String(executive.activeIncidentsCount) })}
                </span>
                {executive.criticalIncidentsCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
                    {t('admin.ops.criticalCount', { count: String(executive.criticalIncidentsCount) })}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-white/80 dark:bg-[#1E2333]/70 border border-slate-200/50 dark:border-white/[0.06]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('admin.ops.troubledServices')}
              </span>
              <p className="text-sm font-bold text-slate-800 dark:text-white mt-1 truncate">
                {executive.troubledServices.length === 0
                  ? t('admin.ops.allServicesHealthy')
                  : executive.troubledServices.join(', ')}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-white/80 dark:bg-[#1E2333]/70 border border-slate-200/50 dark:border-white/[0.06]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('admin.ops.waStreamStatus')}
              </span>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-sm font-bold text-slate-800 dark:text-white">
                  {executive.whatsappState.connected
                    ? t('admin.ops.statusRunning')
                    : t('admin.ops.statusStopped')}
                </span>
                {executive.whatsappState.hasOrphans && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
                    {t('admin.ops.orphansCount', { count: String(executive.whatsappState.orphanCount) })}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-white/80 dark:bg-[#1E2333]/70 border border-slate-200/50 dark:border-white/[0.06]">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {t('admin.ops.lastDeployStatus')}
              </span>
              <p className="text-sm font-bold text-slate-800 dark:text-white mt-1 truncate">
                {executive.lastOperation.label} ({executive.lastOperation.status})
              </p>
            </div>
          </div>

          {/* Actionable Guidance Box */}
          <div className="p-3.5 rounded-lg bg-white dark:bg-[#1E2333] border border-slate-200/80 dark:border-white/[0.08] flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-0.5 max-w-2xl">
              <span className="text-[11px] font-bold uppercase tracking-wide text-vuexy-primary flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                {t('admin.ops.recommendedAction')}
              </span>
              <p className="text-xs text-slate-700 dark:text-slate-200">
                {t(executive.recommendedActionKey) || executive.recommendedActionDefault}
              </p>
            </div>

            {onNavigateTab && (
              <div className="flex items-center gap-2 shrink-0">
                {executive.activeIncidentsCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onNavigateTab('errors')}
                    className="text-xs gap-1.5 cursor-pointer"
                  >
                    <span>{t('admin.ops.viewIncidents')}</span>
                    <ArrowRight className="w-3 h-3" />
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => onNavigateTab('system')}
                  className="text-xs gap-1.5 cursor-pointer bg-vuexy-primary hover:bg-vuexy-primary/90 text-white"
                >
                  <span>{t('admin.ops.viewSystem')}</span>
                  <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2. Technical System Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((tile, i) => (
          <Card
            key={tile.label}
            style={{ animationDelay: `${i * 45}ms` }}
            className="border-slate-200 dark:border-white/[0.06] animate-stagger-in"
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-slate-400 dark:text-[#7E7F96]">
                {tile.icon}
                <span className="text-[11px] font-bold uppercase tracking-wide">{tile.label}</span>
              </div>
              <p className={`mt-2 text-lg font-bold ${tile.tone}`}>{tile.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 3. Persistence Warning */}
      {!persistenceOk && (
        <Card className="border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {t('admin.ops.persistenceWarning')}
            </p>
          </CardContent>
        </Card>
      )}

      {/* 4. Orphaned Sessions Alert */}
      {orphanedCount > 0 && (
        <Card className="border-rose-300 dark:border-rose-700/50 bg-rose-50 dark:bg-rose-950/20">
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-rose-600 dark:text-rose-400 shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-rose-800 dark:text-rose-300">
                  {t('admin.ops.orphanedSessionTitle', { count: String(orphanedCount) })}
                </p>
                <p className="text-sm text-rose-700 dark:text-rose-300/90">
                  {t('admin.ops.orphanedSessionBody')}
                </p>
              </div>
            </div>
            {orphanedDetail.length > 0 && (
              <ul className="ml-7 space-y-1">
                {orphanedDetail.map((s) => (
                  <li key={s.id} className="text-[11px] text-rose-700/80 dark:text-rose-300/70">
                    • {s.session_name || s.id}
                    {s.since ? ` — ${t('admin.ops.orphanedSince', { at: s.since })}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5. Ghost Connected Alert */}
      {ghostConnected.length > 0 && (
        <Card className="border-amber-300 dark:amber-700/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-amber-900 dark:text-amber-300">
                  {t('admin.ops.ghostConnectedTitle', { count: String(ghostConnected.length) })}
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-300/90">
                  {t('admin.ops.ghostConnectedBody')}
                </p>
              </div>
            </div>
            <ul className="ml-7 space-y-0.5">
              {ghostConnected.map((name) => (
                <li key={name} className="text-[11px] text-amber-800/80 dark:text-amber-300/70">
                  • {name}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* 6. Service List */}
      <ServiceList services={services} loading={loading} />

      {/* 7. Recent Operations */}
      <RecentOperations operations={operations} />
    </div>
  );
}

function ServiceList({ services, loading }: { services: OpsServiceStatus[]; loading: boolean }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <CardTitle className="text-base text-slate-800 dark:text-white">
          {t('admin.ops.servicesTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">{t('common.loading')}</p>
        ) : services.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">{t('admin.ops.overviewNoServices')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {services.map((s) => (
              <li key={s.name} className="py-2.5 flex items-center justify-between gap-3">
                <span className="text-sm text-slate-700 dark:text-slate-200">
                  {s.name.replace('tezlify-', '')}
                </span>
                <StatusBadge
                  status={s.status === 'running' ? 'active' : 'danger'}
                  label={s.state || s.status}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentOperations({ operations }: { operations: OpsOperation[] }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <CardTitle className="text-base text-slate-800 dark:text-white">
          {t('admin.ops.operationsTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {operations.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-500">{t('admin.ops.noOperations')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {operations.slice(0, 5).map((o) => (
              <li key={o.id} className="py-2.5 flex items-center justify-between gap-3">
                <span className="text-sm text-slate-700 dark:text-slate-200 truncate">
                  {o.label}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] font-bold">
                  {o.status === 'succeeded' && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  )}
                  <span className="text-slate-500 dark:text-slate-400">
                    {o.step || o.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
