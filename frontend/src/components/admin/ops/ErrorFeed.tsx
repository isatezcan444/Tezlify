/**
 * Tezlify Operations Center — Incident & Live Error Feed
 *
 * Combines live error log inspection with root-cause intelligence, deduplication,
 * and safe remediation guidance.
 *
 * Invariants:
 * 1. Pure buildErrorFeed and classifyError functions are preserved for test parity.
 * 2. Deterministic grouping: Raw logs are analyzed with the incident engine.
 * 3. Safe actions: Service actions display disruption risks and require confirmation.
 */
import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  Info,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { classifyLogLevel } from './logLevel';
import {
  groupLogsIntoIncidents,
  type Incident,
  type IncidentSeverity,
} from './incidentEngine';
import type { OpsCatalogueEntry } from '../../../types/admin';

export interface ErrorEntry {
  id: string;
  service: string;
  line: string;
  level: 'ERROR' | 'WARN';
}

export interface ErrorFeedProps {
  /** service -> already-fetched log lines. */
  logsByService: Record<string, string[]>;
  catalogue: OpsCatalogueEntry[];
  runningName?: string | null;
  onRun: (entry: OpsCatalogueEntry) => void;
  onViewLogs: (service: string) => void;
}

/** Classify a log line. Delegates to shared classifier. */
export function classifyError(line: string): 'ERROR' | 'WARN' | null {
  const level = classifyLogLevel(line);
  return level === 'INFO' ? null : level;
}

/** Build the feed from raw log buffers. Pure so it is directly testable. */
export function buildErrorFeed(logsByService: Record<string, string[]>): ErrorEntry[] {
  const out: ErrorEntry[] = [];
  for (const [service, lines] of Object.entries(logsByService || {})) {
    for (let i = 0; i < (lines || []).length; i += 1) {
      const line = lines[i];
      const level = classifyError(line);
      if (level) out.push({ id: `${service}:${i}`, service, line, level });
    }
  }
  // Newest last in the buffer -> show most recent first.
  return out.reverse().slice(0, 200);
}

export const ErrorFeed: React.FC<ErrorFeedProps> = ({
  logsByService,
  catalogue,
  runningName = null,
  onRun,
  onViewLogs,
}) => {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ErrorEntry | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'ERROR' | 'WARN'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);

  const errors = useMemo(() => buildErrorFeed(logsByService), [logsByService]);

  const incidents = useMemo(
    () => groupLogsIntoIncidents(logsByService),
    [logsByService],
  );

  const visible = useMemo(() => {
    let list = filter === 'ALL' ? errors : errors.filter((e) => e.level === filter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((e) => e.line.toLowerCase().includes(q) || e.service.toLowerCase().includes(q));
    }
    return list;
  }, [errors, filter, searchQuery]);

  const actionsFor = (service: string) =>
    catalogue.filter((c) => c.name === `restart_${service.replace('tezlify-', '')}`);

  // Find incident intelligence for a given error entry
  const getIncidentForError = (err: ErrorEntry): Incident | undefined => {
    return incidents.find(
      (inc) => inc.service === err.service && inc.evidence.some((ev) => ev === err.line || err.line.includes(ev)),
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base text-slate-800 dark:text-white">
                {t('admin.ops.errorsTitle')}
              </CardTitle>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300">
                {incidents.length} {t('admin.ops.activeIncidents')} ({errors.length} {t('admin.ops.errorsCount')})
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
              {t('admin.ops.subtitle')}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {visible.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const text = visible.map((e) => `[${e.service}] ${e.line}`).join('\n');
                  navigator.clipboard.writeText(text);
                  setCopiedAll(true);
                  setTimeout(() => setCopiedAll(false), 2000);
                }}
                className="gap-1.5 cursor-pointer text-xs"
                title={copiedAll ? t('common.copied') : t('common.copy')}
              >
                {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedAll ? t('common.copied') : t('common.copy')}
              </Button>
            )}

            <div className="flex items-center gap-1">
              {(['ALL', 'ERROR', 'WARN'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={
                    'px-2 py-1 rounded-md text-[10px] font-bold transition-colors cursor-pointer ' +
                    (f === filter
                      ? 'bg-slate-800 dark:bg-white text-white dark:text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-white bg-slate-100 dark:bg-white/[0.04]')
                  }
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Search bar */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('admin.ops.searchErrorsPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#1E2333] text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-vuexy-primary"
          />
        </div>

        {/* Incidents Intelligence Summary Header if incidents exist */}
        {incidents.length > 0 && (
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#1E2333]/80 border border-slate-200/80 dark:border-white/[0.06] space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
              <Sparkles className="w-3.5 h-3.5 text-vuexy-primary" />
              <span>{t('admin.ops.incidentCenter')} ({incidents.length} {t('admin.ops.activeIncidents')})</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {incidents.slice(0, 3).map((inc) => (
                <div
                  key={inc.id}
                  className="p-2.5 rounded-md bg-white dark:bg-[#181B2E] border border-slate-200/60 dark:border-white/[0.06] text-xs space-y-1 shadow-sm"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-bold uppercase tracking-wider text-[10px] text-slate-500">
                      {inc.service}
                    </span>
                    <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                      inc.severity === 'critical' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' :
                      inc.severity === 'high' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' :
                      'bg-slate-100 text-slate-700 dark:bg-white/[0.08] dark:text-slate-300'
                    }`}>
                      {t('admin.ops.occurrences', { count: String(inc.count) })}
                    </span>
                  </div>
                  <p className="font-semibold text-slate-800 dark:text-white line-clamp-1">
                    {t(inc.titleKey) || inc.titleDefault}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                    {t(inc.whatHappenedKey) || inc.whatHappenedDefault}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-4 space-y-2">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-slate-400">
            <Info className="w-7 h-7 mb-2 opacity-40 text-emerald-500" />
            <p className="text-xs font-medium">{t('admin.ops.errorsEmpty')}</p>
          </div>
        ) : (
          visible.slice(0, 50).map((err) => {
            const isOpen = selected?.id === err.id;
            const inc = getIncidentForError(err);
            const actions = actionsFor(err.service);

            return (
              <div
                key={err.id}
                className={
                  'rounded-lg border transition-colors ' +
                  (isOpen
                    ? 'border-vuexy-primary bg-slate-50 dark:bg-white/[0.04]'
                    : 'border-slate-200 dark:border-white/[0.08] hover:bg-slate-50 dark:hover:bg-white/[0.03]')
                }
              >
                <button
                  type="button"
                  onClick={() => setSelected(isOpen ? null : err)}
                  className="w-full flex items-start gap-2.5 p-3 text-left cursor-pointer"
                >
                  {err.level === 'ERROR' ? (
                    <CircleAlert className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                        {err.service}
                      </p>
                      {inc && (
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                          inc.severity === 'critical' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' :
                          inc.severity === 'high' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' :
                          'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'
                        }`}>
                          {inc.severity.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                      {err.line}
                    </p>
                  </div>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="border-t border-slate-200 dark:border-white/[0.08] p-3 space-y-3 bg-white dark:bg-[#181B2E]">
                    {/* Incident Diagnostics Context if available */}
                    {inc && (
                      <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#151828] border border-slate-200/60 dark:border-white/[0.06] space-y-2 text-xs">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {t('admin.ops.whatHappened')}
                            </span>
                            <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-snug">
                              {t(inc.whatHappenedKey) || inc.whatHappenedDefault}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {t('admin.ops.estimatedImpact')}
                            </span>
                            <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-snug">
                              {t(inc.impactKey) || inc.impactDefault}
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-slate-200/40 dark:border-white/[0.04]">
                          <div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {t('admin.ops.possibleCause')}
                            </span>
                            <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-snug">
                              {t(inc.possibleCauseKey) || inc.possibleCauseDefault}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {t('admin.ops.safeNextStep')}
                            </span>
                            <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-snug">
                              {t(inc.recommendedActionKey) || inc.recommendedActionDefault}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Raw log line */}
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {t('admin.ops.rawOutput')}
                      </span>
                      <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-[#0F1222] p-2 rounded">
                        {err.line}
                      </pre>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-slate-100 dark:border-white/[0.06]">
                      <Button
                        variant="outline"
                        onClick={() => onViewLogs(err.service)}
                        className="min-h-[40px] h-10 px-4 rounded-xl text-xs font-semibold cursor-pointer border-slate-200 dark:border-white/[0.08]"
                      >
                        {t('admin.ops.viewLogs')}
                      </Button>
                      <div className="flex items-center gap-2">
                        {actions.map((action) => (
                          <Button
                            key={action.name}
                            variant="destructive"
                            disabled={Boolean(runningName)}
                            onClick={() => onRun(action)}
                            className="min-h-[40px] h-10 px-4 rounded-xl text-xs font-bold cursor-pointer shadow-sm"
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
};
