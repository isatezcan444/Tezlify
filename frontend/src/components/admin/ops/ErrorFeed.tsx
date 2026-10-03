/**
 * Live error feed derived from the service log buffer.
 *
 * No new persistence was introduced for this: the operations surface already
 * fetches a bounded, redacted log tail per service, so errors are derived from
 * that same buffer rather than from a second polling loop. Clicking an error
 * shows the raw line plus the actions that apply to THAT service — a human
 * always presses the button, nothing self-heals.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, CircleAlert, Copy, Info } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { OpsCatalogueEntry } from '../../../types/admin';
import { classifyLogLevel } from './logLevel';

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

/** Classify a log line. Delegates to the shared classifier so the feed and the
 * log viewer can never disagree about what counts as an error. */
export function classifyError(line: string): 'ERROR' | 'WARN' | null {
  const level = classifyLogLevel(line);
  return level === 'INFO' ? null : level;
}

/** Build the feed from the log buffers. Pure so it is directly testable. */
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const errors = useMemo(() => buildErrorFeed(logsByService), [logsByService]);
  const visible = useMemo(
    () => (filter === 'ALL' ? errors : errors.filter((e) => e.level === filter)),
    [errors, filter],
  );

  const actionsFor = (service: string) =>
    catalogue.filter((c) => c.name === `restart_${service.replace('tezlify-', '')}`);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-base text-slate-800 dark:text-white">
            {t('admin.ops.errorsTitle')}
          </CardTitle>
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
                      ? 'bg-slate-800 dark:bg-white text-white'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-white')
                  }
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-[#7E7F96]">
          {errors.length} {t('admin.ops.errorsCount')}
        </p>
      </CardHeader>

      <CardContent className="space-y-2">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-slate-400">
            <Info className="w-7 h-7 mb-2 opacity-40" />
            <p className="text-xs">{t('admin.ops.errorsEmpty')}</p>
          </div>
        ) : (
          visible.slice(0, 50).map((err) => {
            const isOpen = selected?.id === err.id;
            return (
              <div
                key={err.id}
                className={
                  'rounded-lg border cursor-pointer transition-colors ' +
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
                    <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                      {err.service}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                      {err.line}
                    </p>
                  </div>
                  <ChevronRight
                    className={
                      'w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5 transition-transform ' +
                      (isOpen ? 'rotate-90' : '')
                    }
                  />
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 space-y-3 border-t border-slate-200 dark:border-white/[0.06] pt-3">
                    <pre className="max-h-48 overflow-auto rounded-md bg-slate-50 dark:bg-[#0F1222] p-2.5 text-[11px] font-mono whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300">
                      {err.line}
                    </pre>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(err.line);
                          setCopiedId(err.id);
                          setTimeout(() => setCopiedId(null), 2000);
                        }}
                        className="gap-1.5 cursor-pointer"
                        title={copiedId === err.id ? t('common.copied') : t('common.copy')}
                      >
                        {copiedId === err.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedId === err.id ? t('common.copied') : t('common.copy')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onViewLogs(err.service)}
                        className="cursor-pointer"
                      >
                        {t('admin.ops.viewLogs')}
                      </Button>
                      {actionsFor(err.service).map((a) => (
                        <Button
                          key={a.name}
                          variant="outline"
                          size="sm"
                          disabled={Boolean(runningName)}
                          onClick={() => onRun(a)}
                          className="cursor-pointer"
                        >
                          {a.label}
                        </Button>
                      ))}
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
