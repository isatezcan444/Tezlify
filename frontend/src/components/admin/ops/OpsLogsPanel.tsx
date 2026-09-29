/**
 * Bounded log viewer.
 *
 * The backend caps every read (`tail` <= 500, allowlisted service) and
 * redacts secrets before they are sent, so this component only has to avoid
 * the two client-side failure modes: an unbounded fetch loop and re-rendering
 * thousands of nodes. Filtering is done on the already-fetched buffer.
 */
import React, { useMemo, useState } from 'react';
import { Download, FileText, Search, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { Skeleton } from '../../ui/Skeleton';
import { buildLogExport, downloadTextFile } from './exportLogs';

export interface OpsLogsPanelProps {
  services: string[];
  activeService: string;
  lines: string[];
  loading?: boolean;
  error?: string | null;
  onServiceChange: (service: string) => void;
  onReload: () => void;
  /**
   * Every service buffer already loaded in the page, used by the merged export.
   * Only services that have actually been fetched are included, so the file
   * never claims to hold data the operator never saw.
   */
  logsByService?: Record<string, string[]>;
}

const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO'];

function levelOf(line: string): 'ERROR' | 'WARN' | 'INFO' {
  const l = line.toLowerCase();
  if (/\b(error|err|fatal|critical|exception|traceback|failed)\b/.test(l)) return 'ERROR';
  if (/\b(warn|warning)\b/.test(l)) return 'WARN';
  return 'INFO';
}

function lineTone(line: string): string {
  const level = levelOf(line);
  if (level === 'ERROR') return 'text-rose-600 dark:text-rose-400';
  if (level === 'WARN') return 'text-amber-600 dark:text-amber-400';
  return 'text-slate-600 dark:text-slate-300';
}


export const OpsLogsPanel: React.FC<OpsLogsPanelProps> = ({
  services,
  activeService,
  lines,
  loading = false,
  error = null,
  onServiceChange,
  onReload,
  logsByService = {},
}) => {
  const { t } = useI18n();
  const [level, setLevel] = useState('ALL');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (level !== 'ALL' && levelOf(line) !== level) return false;
      if (needle && !line.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [lines, level, query]);

  // Exports what the operator can SEE, not the raw buffer: if a level filter or
  // a search is active, the file must match the screen, otherwise the export
  // becomes a way to get around a filter they are relying on.
  const exportFiltered = (prefix: string) => {
    downloadTextFile(buildLogExport({
      prefix,
      service: activeService,
      lines: visible,
      levelFilter: level,
      query,
      extra: logsByService,
    }));
  };

  const hasVisible = visible.length > 0;
  const errorCount = useMemo(
    () => visible.filter((l) => levelOf(l) === 'ERROR').length,
    [visible],
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base text-slate-800 dark:text-white">
              {t('admin.ops.logsTitle')}
            </CardTitle>
            <p className="text-xs text-slate-500 dark:text-[#7E7F96] mt-0.5">
              {t('admin.ops.logsService')}: <strong>{activeService}</strong>
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportFiltered('tezlify-errors')}
              disabled={!hasVisible || errorCount === 0}
              className="cursor-pointer gap-1.5"
              title={t('admin.ops.exportErrorsHint')}
            >
              <TriangleAlert className="w-3.5 h-3.5" />
              {t('admin.ops.exportErrors')} ({errorCount})
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportFiltered('tezlify-logs')}
              disabled={!hasVisible}
              className="cursor-pointer gap-1.5"
              title={t('admin.ops.exportLogsHint')}
            >
              <Download className="w-3.5 h-3.5" />
              {t('admin.ops.exportLogs')}
            </Button>
            <Button variant="outline" size="sm" onClick={onReload} className="cursor-pointer">
              {t('admin.refreshNow')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="flex items-center gap-1 overflow-x-auto">
            {services.map((svc) => (
              <button
                key={svc}
                type="button"
                onClick={() => onServiceChange(svc)}
                className={
                  'px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors cursor-pointer ' +
                  (svc === activeService
                    ? 'bg-vuexy-primary text-white'
                    : 'bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:bg-slate-200')
                }
              >
                {svc}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            {LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLevel(lvl)}
                className={
                  'px-2 py-1 rounded-md text-[10px] font-bold transition-colors cursor-pointer ' +
                  (lvl === level
                    ? 'bg-slate-800 dark:bg-white text-white'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-white')
                }
              >
                {lvl === 'ALL' ? t('admin.ops.logsAll') : lvl}
              </button>
            ))}
          </div>

          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('admin.ops.logsSearch')}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#1E2333] text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-vuexy-primary"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-4 w-full rounded" />
            ))}
          </div>
        ) : error ? (
          <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-slate-400">
            <FileText className="w-7 h-7 mb-2 opacity-40" />
            <p className="text-xs">{t('admin.ops.logsEmpty')}</p>
          </div>
        ) : (
          <pre className="max-h-[420px] overflow-auto rounded-lg bg-slate-50 dark:bg-[#0F1222] p-3 text-[11px] leading-relaxed">
            {visible.slice(-500).map((line, i) => (
              <div key={i} className={'font-mono break-all ' + lineTone(line)}>
                {line}
              </div>
            ))}
          </pre>
        )}
      </CardContent>
    </Card>
  );
};
