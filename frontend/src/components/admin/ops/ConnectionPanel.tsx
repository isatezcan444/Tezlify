import { Radio, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardHeader, CardTitle, CardContent } from '../../ui/card';
import { StatusBadge } from '../../ui/StatusBadge';
import type {
  AdminWhatsAppResponse,
  OpsHealthCheck,
} from '../../../types/admin';

export interface ConnectionPanelProps {
  data: AdminWhatsAppResponse | null;
  health: OpsHealthCheck | null;
  loading?: boolean;
}

/**
 * WhatsApp connection state: which sessions exist, whether the gateway bridge
 * is up, and what the operator should do next.
 *
 * This panel is READ-ONLY on purpose. Pairing a new number goes through
 * `/api/v1/whatsapp/pairing/*`, which is scoped to the requesting user, not to
 * the admin role. An admin-triggered pairing flow would either pair a session
 * against the wrong account or need a privileged endpoint that writes session
 * credentials on an admin's behalf — so instead this panel reports the state
 * and points at the flow that already owns it.
 */
export function ConnectionPanel({ data, health, loading = false }: ConnectionPanelProps) {
  const { t } = useI18n();

  const bridge = data?.gateway_bridge;
  const runtime = data?.gateway_runtime;
  const sessions = data?.sessions || [];
  const connected = sessions.filter((s) => s.status?.toUpperCase() === 'CONNECTED');
  const whatsapp = health?.whatsapp;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-3">
            <Radio className="w-4 h-4 text-vuexy-primary" />
            <CardTitle className="text-base text-slate-800 dark:text-white">
              {t('admin.ops.tabConnection')}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4 space-y-1">
          <Row
            label={t('admin.ops.bridgeStatus')}
            value={bridge?.connected ? t('admin.ops.connected') : t('admin.ops.disconnected')}
            tone={bridge?.connected ? 'active' : 'danger'}
          />
          <Row
            label={t('admin.ops.gatewayHealth')}
            value={runtime?.health_status || t('admin.ops.overviewUnknown')}
            tone={runtime?.health_status === 'healthy' ? 'active' : 'warning'}
          />
          <Row
            label={t('admin.ops.reconnectCount')}
            value={String(bridge?.reconnect_count ?? 0)}
          />
          {whatsapp?.state && (
            <Row
              label={t('admin.ops.overviewWhatsapp')}
              value={String(whatsapp.state)}
              tone={whatsapp.connected ? 'active' : 'warning'}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.sessionsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <p className="text-sm text-slate-400">{t('common.loading')}</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-slate-400">{t('admin.ops.sessionsEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {sessions.map((s) => (
                <li key={s.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700 dark:text-slate-200 truncate">
                      {s.session_name}
                    </p>
                    {s.phone_number_masked && (
                      <p className="text-[11px] text-slate-400">{s.phone_number_masked}</p>
                    )}
                  </div>
                  <StatusBadge
                    status={s.status?.toUpperCase() === 'CONNECTED' ? 'active' : 'warning'}
                    label={s.status}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 flex items-start gap-3">
          {connected.length > 0 ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
          )}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {connected.length > 0
              ? t('admin.ops.pairingActive')
              : t('admin.ops.pairingNeeded')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'active' | 'danger' | 'warning';
}) {
  const toneClass =
    tone === 'active' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'danger' ? 'text-rose-600 dark:text-rose-400'
    : tone === 'warning' ? 'text-amber-600 dark:text-amber-400'
    : 'text-slate-600 dark:text-slate-300';
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`text-sm font-bold ${toneClass}`}>{value}</span>
    </div>
  );
}
