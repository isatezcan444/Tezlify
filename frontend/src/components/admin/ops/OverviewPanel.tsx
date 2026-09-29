import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardHeader, CardTitle, CardContent } from '../../ui/card';
import { StatusBadge } from '../../ui/StatusBadge';
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
}

/**
 * At-a-glance health of the whole deployment.
 *
 * Composes data the Operations Center ALREADY fetches (the admin overview plus
 * the ops status/health payloads) rather than introducing new endpoints. It is
 * read-only: every action lives in the System and Deployment tabs, so an
 * operator gets a summary first and acts deliberately.
 */
export function OverviewPanel({
  overview,
  services,
  health,
  operations,
  loading = false,
  persistenceOk = true,
}: OverviewPanelProps) {
  const { t } = useI18n();

  const running = services.filter((s) => s.status === 'running').length;
  const down = services.filter((s) => s.status !== 'running');
  const whatsapp = health?.whatsapp;

  const tiles: { icon: ReactNode; label: string; value: string; tone: string }[] = [
    {
      icon: <Server className="w-4 h-4" />,
      label: t('admin.ops.overviewServices'),
      value: `${running}/${services.length}`,
      tone: down.length === 0 && services.length > 0
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
      // WhatsApp connectivity is reported apart from the pass/fail verdict: a
      // logged-out session needs an operator to re-pair, it is not a failure.
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((tile) => (
          <Card key={tile.label} className="border-slate-200 dark:border-white/[0.06]">
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

      <ServiceList services={services} loading={loading} />
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
          <p className="text-sm text-slate-400">{t('common.loading')}</p>
        ) : services.length === 0 ? (
          <p className="text-sm text-slate-400">{t('admin.ops.overviewNoServices')}</p>
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
          <p className="text-sm text-slate-400">{t('admin.ops.noOperations')}</p>
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
