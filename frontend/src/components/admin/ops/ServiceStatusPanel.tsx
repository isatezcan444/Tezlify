/**
 * Service status grid with the operations each service actually supports.
 *
 * Actions are NOT invented per service: they are rendered from the catalogue
 * the backend returns, so the UI can never offer a control the server would
 * reject. A service with no allowlisted operation (notably `db`) shows a hint
 * instead of a disabled mystery button.
 */
import React, { useMemo } from 'react';
import { Activity, AlertTriangle, Server, RefreshCw, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { StatusBadge, StatusVariant } from '../../ui/StatusBadge';
import { Button } from '../../ui/button';
import { Skeleton } from '../../ui/Skeleton';
import {
  OpsCatalogueEntry,
  OpsHealthCheck,
  OpsOperation,
  OpsServiceStatus,
} from '../../../types/admin';

export interface ServiceStatusPanelProps {
  services: OpsServiceStatus[];
  health: OpsHealthCheck | null;
  catalogue: OpsCatalogueEntry[];
  loading?: boolean;
  /** Operations currently running; buttons are disabled server-side too. */
  running?: OpsOperation | null;
  onRun: (entry: OpsCatalogueEntry) => void;
  busyName?: string | null;
}

/** Map a service to all allowlisted operations that target it. */
function operationsForService(
  service: string,
  catalogue: OpsCatalogueEntry[],
): OpsCatalogueEntry[] {
  const result: OpsCatalogueEntry[] = [];
  if (service === 'caddy') {
    const reload = catalogue.find((c) => c.name === 'reload_caddy');
    if (reload) result.push(reload);
  }
  const restart = catalogue.find((c) => c.name === `restart_${service}`);
  if (restart) result.push(restart);
  return result;
}

function statusVariant(svc: OpsServiceStatus): StatusVariant {
  if (svc.status !== 'running') return 'offline';
  if (svc.health === 'healthy') return 'online';
  if (svc.health === 'unhealthy') return 'danger';
  if (svc.health === 'starting') return 'pending';
  return 'active';
}

function statusLabelKey(svc: OpsServiceStatus, t: (k: string) => string): string {
  if (svc.status === 'absent') return t('admin.ops.statusAbsent');
  if (svc.status !== 'running') return t('admin.ops.statusStopped');
  if (svc.health === 'healthy') return t('admin.ops.statusHealthy');
  if (svc.health === 'unhealthy') return t('admin.ops.statusUnhealthy');
  if (svc.health === 'starting') return t('admin.ops.statusStarting');
  return t('admin.ops.statusRunning');
}


export const ServiceStatusPanel: React.FC<ServiceStatusPanelProps> = ({
  services,
  health,
  catalogue,
  loading = false,
  running = null,
  onRun,
  busyName = null,
}) => {
  const { t } = useI18n();

  const systemActions = useMemo(() => {
    return catalogue.filter((c) => c.name === 'restart_all' || c.name === 'docker_prune');
  }, [catalogue]);

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">{t('admin.ops.servicesTitle')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.servicesTitle')}
          </CardTitle>
          <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
            {t('admin.ops.servicesSubtitle')}
          </p>
        </div>
        {health?.all_healthy ? (
          <StatusBadge status="online" label={t('admin.ops.healthAllOk')} size="sm" />
        ) : (
          <StatusBadge status="danger" label={t('admin.ops.healthSomeDown')} size="sm" />
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {services.map((svc) => {
            const short = svc.name.replace('tezlify-', '');
            const actions = operationsForService(short, catalogue);
            return (
              <div
                key={svc.name}
                className="rounded-xl border border-slate-200 dark:border-white/[0.08] p-4 flex flex-col gap-3 justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Server className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="text-sm font-bold text-slate-700 dark:text-white truncate">{short}</span>
                    </div>
                    <StatusBadge status={statusVariant(svc)} label={statusLabelKey(svc, t)} size="sm" />
                  </div>

                  <dl className="text-[11px] space-y-1 mt-3">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-400">{t('admin.ops.uptime')}</dt>
                      <dd className="text-slate-600 dark:text-slate-300 font-medium">
                        {svc.uptime || t('admin.ops.noData')}
                      </dd>
                    </div>
                    {typeof svc.restart_count === 'number' && svc.restart_count > 0 && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-400">{t('admin.ops.restartCount')}</dt>
                        <dd className="text-amber-600 dark:text-amber-400 font-medium inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {svc.restart_count}
                        </dd>
                      </div>
                    )}
                    {svc.oom_killed && (
                      <div className="flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
                        <ShieldAlert className="w-3 h-3" /> OOM
                      </div>
                    )}
                  </dl>
                </div>

                <div className="flex flex-col gap-1.5 mt-auto pt-2">
                  {actions.length > 0 ? (
                    actions.map((act) => {
                      const busy = busyName === act.name || running?.name === act.name;
                      const isHotReload = act.name.includes('reload');
                      return (
                        <Button
                          key={act.name}
                          variant={isHotReload ? 'default' : 'outline'}
                          size="sm"
                          disabled={busy || Boolean(running)}
                          onClick={() => onRun(act)}
                          className={`w-full gap-2 cursor-pointer transition-all duration-150 active:scale-[0.98] ${
                            isHotReload
                              ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm'
                              : 'border-slate-200 dark:border-white/[0.08]'
                          }`}
                        >
                          {busy ? (
                            <Activity className="w-3.5 h-3.5 animate-spin" />
                          ) : isHotReload ? (
                            <Zap className="w-3.5 h-3.5" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          <span className="truncate">{act.label}</span>
                        </Button>
                      );
                    })
                  ) : (
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                      {t('admin.ops.dangerZoneDesc')}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {systemActions.length > 0 && (
          <div className="pt-4 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200">
                {t('admin.ops.systemActions')}
              </h4>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {t('admin.ops.systemActionsDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {systemActions.map((act) => {
                const busy = busyName === act.name || running?.name === act.name;
                const isPrune = act.name.includes('prune');
                return (
                  <Button
                    key={act.name}
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(running)}
                    onClick={() => onRun(act)}
                    className="gap-2 cursor-pointer border-slate-200 dark:border-white/[0.08]"
                  >
                    {busy ? (
                      <Activity className="w-3.5 h-3.5 animate-spin text-vuexy-primary" />
                    ) : isPrune ? (
                      <Trash2 className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    <span>{act.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

