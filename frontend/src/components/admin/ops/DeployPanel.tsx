import { Rocket, CheckCircle2, Info } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardHeader, CardTitle, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';
import type { OpsCatalogueEntry, OpsOperation } from '../../../types/admin';

export interface DeployPanelProps {
  catalogue: OpsCatalogueEntry[];
  running: OpsOperation | null;
  busyName: string | null;
  onRun: (entry: OpsCatalogueEntry) => void;
}

/**
 * The cohesive deploy action: pull, rebuild, recreate, verify — in that order.
 *
 * WHY ONE BUTTON
 * --------------
 * These were three separate allowlisted operations. That is a footgun: an
 * operator can pull and forget to build (the panel then shows the new commit
 * while the old image keeps serving), or build without pulling (shipping a
 * rebuild of the previous commit). One ordered pipeline removes the ordering
 * decision from the operator, and a failure at any stage stops the rest, so a
 * failed pull can never be followed by a build of stale code.
 *
 * The action is looked up from the catalogue rather than hardcoded, so the
 * allowlist stays the single source of truth for what is callable.
 */
export function DeployPanel({ catalogue, running, busyName, onRun }: DeployPanelProps) {
  const { t } = useI18n();

  const action = catalogue.find((c) => c.name === 'deploy_full') || null;
  const busy = busyName === action?.name;
  // Any running operation disables this too: deploy and restart share a family
  // guard on the server, and offering a control the server will reject is worse
  // than showing it disabled.
  const blocked = Boolean(running);

  return (
    <Card className="border-slate-200 dark:border-white/[0.06]">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-vuexy-primary/10 flex items-center justify-center text-vuexy-primary">
            <Rocket className="w-4 h-4" />
          </div>
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.deploymentTitle')}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {action ? t('admin.ops.deployFullDesc') : t('admin.ops.deploymentUnavailable')}
        </p>
        <Button
          onClick={() => action && onRun(action)}
          disabled={!action || blocked || busy}
          className="gap-2"
        >
          <Rocket className="w-3.5 h-3.5" />
          {t('admin.ops.deployFull')}
        </Button>
        {blocked && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <Info className="w-3.5 h-3.5 mt-px shrink-0" />
            {t('admin.ops.deployBlocked')}
          </p>
        )}
        {!blocked && (
          <p className="flex items-start gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 mt-px shrink-0" />
            {t('admin.ops.deployRestartsBackendNote')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
