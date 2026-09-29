/**
 * Operation history + audit trail.
 *
 * Operations keep running server-side after the tab closes, so this list is
 * re-attachable rather than fire-and-forget: an operation started elsewhere
 * (or before a refresh) still shows its live status and logs.
 */
import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, Download, Loader2, Search, ShieldAlert, XCircle } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { StatusBadge } from '../../ui/StatusBadge';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/EmptyState';
import { OpsAuditEntry, OpsOperation } from '../../../types/admin';
import { buildHistoryCsv, buildHistoryJson, downloadTextFile } from './exportLogs';

export interface OpsHistoryPanelProps {
  operations: OpsOperation[];
  audit: OpsAuditEntry[];
  /** Total retained operations, for the paging controls. 0 = unknown. */
  totalOperations?: number;
  /** Page offset currently shown. */
  offset?: number;
  /** Rows per page. */
  pageSize?: number;
  onPageChange?: (offset: number) => void;
  onStatusFilter?: (status: string) => void;
  onNameFilter?: (name: string) => void;
  /** Status filter currently applied. */
  statusFilter?: string;
}

/** Human label for a step, including the multi-step deploy pipeline names. */
function stepLabel(op: OpsOperation, t: (k: string) => string): string {
  // A multi-step operation reports `failed:<step>` so the operator can see
  // which stage stopped the pipeline instead of a bare "failed".
  if (op.step?.startsWith('failed:')) {
    return `${t('admin.ops.stepFailed')} (${stepName(op.step.slice('failed:'.length), t)})`;
  }
  switch (op.step) {
    case 'starting': return t('admin.ops.stepStarting');
    case 'running': return t('admin.ops.stepRunning');
    case 'completed': return t('admin.ops.stepCompleted');
    case 'failed': return t('admin.ops.stepFailed');
    case 'interrupted': return t('admin.ops.stepInterrupted');
    case 'health_check': return t('admin.ops.stepHealthCheck');
    case 'health_check_failed': return t('admin.ops.stepHealthFailed');
    default: return stepName(op.step, t) || '-';
  }
}

/** Translate a server-side step id (pull / build / restart) for display. */
function stepName(step: string | null | undefined, t: (k: string) => string): string {
  if (!step) return '';
  const known: Record<string, string> = {
    pull: 'admin.ops.stagePull',
    build: 'admin.ops.stageBuild',
    restart: 'admin.ops.stageRestart',
    run: 'admin.ops.stepRunning',
  };
  const key = known[step];
  return key ? t(key) : step;
}

/**
 * "Step 2 of 3 — build" for a pipeline, empty for a single-command operation.
 * A deploy takes minutes, so without this the panel shows an undifferentiated
 * "running" and the operator cannot tell a normal build from a hung one.
 */
function progressLabel(op: OpsOperation, t: (k: string) => string): string {
  const total = op.total_steps || 1;
  if (total <= 1) return '';
  const current = op.current_step;
  if (!current) return '';
  const index = (['pull', 'build', 'restart'] as const).indexOf(current as never);
  const pos = index >= 0 ? index + 1 : 0;
  return pos > 0
    ? `${t('admin.ops.stageProgress')} ${pos}/${total} — ${stepName(current, t)}`
    : `${t('admin.ops.stageProgress')} ${total}/${total}`;
}

function statusOf(op: OpsOperation) {
  if (op.status === 'running') return { variant: 'pending' as const, key: 'admin.ops.operationRunning' };
  if (op.status === 'succeeded') return { variant: 'completed' as const, key: 'admin.ops.operationSucceeded' };
  return { variant: 'failed' as const, key: 'admin.ops.operationFailed' };
}


export const OpsHistoryPanel: React.FC<OpsHistoryPanelProps> = ({
  operations,
  audit,
  totalOperations = 0,
  offset = 0,
  pageSize = 20,
  onPageChange,
  onStatusFilter,
  onNameFilter,
  statusFilter = 'ALL',
}) => {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState('');

  // The export covers the WHOLE retained history, not the visible page: an
  // audit question ("everything we did last week") is not answered by one page
  // of rows, and a silently truncated export would be worse than none.
  const exportHistory = (format: 'csv' | 'json') => {
    const build = format === 'csv' ? buildHistoryCsv : buildHistoryJson;
    downloadTextFile(build({ operations, audit }));
  };

  const canPrev = Boolean(onPageChange) && offset > 0;
  const canNext = Boolean(onPageChange) && totalOperations > 0
    && offset + pageSize < totalOperations;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base text-slate-800 dark:text-white">
                {t('admin.ops.operationsTitle')}
              </CardTitle>
              <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
                {t('admin.ops.operationsSubtitle')}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportHistory('csv')}
                disabled={operations.length === 0 && audit.length === 0}
                className="cursor-pointer gap-1.5"
                title={t('admin.ops.exportHistoryHint')}
              >
                <Download className="w-3.5 h-3.5" />
                CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportHistory('json')}
                disabled={operations.length === 0 && audit.length === 0}
                className="cursor-pointer gap-1.5"
                title={t('admin.ops.exportHistoryHint')}
              >
                <Download className="w-3.5 h-3.5" />
                JSON
              </Button>
            </div>
          </div>

          {/* Filters: "which deploy failed" and "what did we do last Tuesday"
              are the two questions this panel exists to answer. */}
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center mt-3">
            <div className="flex items-center gap-1">
              {['ALL', 'succeeded', 'failed', 'running'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStatusFilter?.(s)}
                  className={
                    'px-2 py-1 rounded-md text-[10px] font-bold transition-colors cursor-pointer ' +
                    (s === statusFilter
                      ? 'bg-slate-800 dark:bg-white text-white'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-white')
                  }
                >
                  {s === 'ALL' ? t('admin.ops.filterAll') : s}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[140px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onNameFilter?.(nameQuery); }}
                onBlur={() => onNameFilter?.(nameQuery)}
                placeholder={t('admin.ops.searchOperation')}
                className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#1E2333] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-vuexy-primary"
              />
            </div>
          </div>

          {onPageChange && totalOperations > pageSize && (
            <div className="flex items-center justify-between gap-2 mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(Math.max(0, offset - pageSize))}
                disabled={!canPrev}
                className="cursor-pointer"
              >
                {t('admin.ops.previousPage')}
              </Button>
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                {offset + 1}-{Math.min(offset + operations.length, totalOperations)} / {totalOperations}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(offset + pageSize)}
                disabled={!canNext}
                className="cursor-pointer"
              >
                {t('admin.ops.nextPage')}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {operations.length === 0 ? (
            <EmptyState
              icon={ShieldAlert}
              title={t('admin.ops.noOperations')}
              description={t('admin.ops.operationsSubtitle')}
            />
          ) : (
            operations.map((op) => {
              const meta = statusOf(op);
              const isOpen = openId === op.id;
              return (
                <div key={op.id} className="rounded-lg border border-slate-200 dark:border-white/[0.08]">
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : op.id)}
                    className="w-full flex items-center gap-2.5 p-3 text-left cursor-pointer"
                  >
                    {op.status === 'running' ? (
                      <Loader2 className="w-4 h-4 text-slate-400 shrink-0 animate-spin" />
                    ) : op.status === 'succeeded' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">{op.label}</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500">
                        {op.actor || '-'} · {stepLabel(op, t)}
                        {progressLabel(op, t) && (
                          <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-vuexy-primary">
                            {progressLabel(op, t)}
                          </span>
                        )}
                        {typeof op.duration_ms === 'number' ? ` · ${op.duration_ms}ms` : ''}
                      </p>
                    </div>
                    <StatusBadge status={meta.variant} label={t(meta.key)} size="sm" />
                    <ChevronDown
                      className={
                        'w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ' +
                        (isOpen ? 'rotate-180' : '')
                      }
                    />
                  </button>

                  {isOpen && (
                    <div className="px-3 pb-3 space-y-2 border-t border-slate-200 dark:border-white/[0.06] pt-3">
                      {op.error && (
                        <p className="text-[11px] text-rose-600 dark:text-rose-400">{op.error}</p>
                      )}
                      {op.health && (
                        <p className="text-[11px] text-slate-500 dark:text-[#7E7F96]">
                          {t('admin.ops.stepHealthCheck')}: {op.health.all_healthy ? 'OK' : 'FAIL'}
                        </p>
                      )}
                      {op.logs.length > 0 ? (
                        <pre className="max-h-56 overflow-auto rounded-md bg-slate-50 dark:bg-[#0F1222] p-2.5 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300">
                          {op.logs.slice(-200).join('\n')}
                        </pre>
                      ) : (
                        <p className="text-[11px] text-slate-400 dark:text-slate-500">{t('admin.ops.noData')}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.auditTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {audit.length === 0 ? (
            <EmptyState icon={ShieldAlert} title={t('admin.ops.auditEmpty')} description="" />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {audit.slice(0, 50).map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex items-center gap-3 text-[11px]">
                  <span className="font-mono text-slate-400 dark:text-slate-500 shrink-0">
                    {new Date(a.at).toLocaleTimeString()}
                  </span>
                  <span className="font-bold text-slate-700 dark:text-slate-200 shrink-0">
                    {a.actor || '-'}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400 truncate flex-1">{a.action}</span>
                  <StatusBadge
                    status={a.result === 'success' || a.result === 'accepted' ? 'completed' : 'failed'}
                    label={a.result}
                    size="sm"
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
