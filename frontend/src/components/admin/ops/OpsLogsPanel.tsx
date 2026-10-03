/**
 * Bounded log viewer.
 *
 * The backend caps every read (`tail` <= 500, allowlisted service) and
 * redacts secrets before they are sent, so this component only has to avoid
 * the two client-side failure modes: an unbounded fetch loop and re-rendering
 * thousands of nodes. Filtering is done on the already-fetched buffer.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, FileText, RefreshCw, Search, Trash2, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../../context/I18nContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { Skeleton } from '../../ui/Skeleton';
import { buildLogExport, downloadTextFile } from './exportLogs';
import { classifyLogLevel } from './logLevel';

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
  /**
   * Truncate the log files behind every service in `services`. Owned by the
   * page because it performs the requests and the confirmation; the panel only
   * renders the trigger.
   */
  onClearLogs?: () => void;
  /** A clear is in flight — the button must not be clickable twice. */
  clearing?: boolean;
}

const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO'];

// Level detection lives in logLevel.ts: the gateway and caddy emit different
// level conventions and a text-only regex silently missed the gateway's.
const levelOf = classifyLogLevel;

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
  onClearLogs,
  clearing = false,
}) => {
  const { t } = useI18n();
  const [level, setLevel] = useState('ALL');
  const [query, setQuery] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedLineIdx, setCopiedLineIdx] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Auto-refresh interval (5s) for live log watching without stale logs
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        onReload();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, onReload]);

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
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Live stream toggle */}
            <button
              type="button"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                autoRefresh
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 shadow-sm shadow-emerald-500/10'
                  : 'bg-slate-100 dark:bg-white/[0.05] border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
              title={autoRefresh ? 'Canlı akış aktif (Her 5s otomatik yenileniyor)' : 'Canlı akışı başlat (Her 5s otomatik yenile)'}
            >
              <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              <span>{autoRefresh ? 'Canlı Akış (5s)' : 'Canlı Akış'}</span>
            </button>

            {/* Copy visible logs button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const text = visible.join('\n');
                navigator.clipboard.writeText(text);
                setCopiedAll(true);
                setTimeout(() => setCopiedAll(false), 2000);
              }}
              disabled={!hasVisible}
              className="cursor-pointer gap-1.5"
              title={copiedAll ? t('common.copied') : t('common.copy')}
            >
              {copiedAll ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedAll ? t('common.copied') : t('common.copy')}
            </Button>

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
            <Button variant="outline" size="sm" onClick={onReload} className="cursor-pointer gap-1.5" title={t('admin.refreshNow')}>
              <RefreshCw className="w-3.5 h-3.5" />
              {t('admin.refreshNow')}
            </Button>
            {/* Irreversible, so it is last, visually distinct, and always
                confirmed. Deliberately NOT disabled when the visible buffer is
                empty: a level/search filter can hide every line while the
                server still holds logs, and that is exactly when an operator
                wants to reclaim the space. */}
            {onClearLogs && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClearLogs}
                disabled={clearing}
                className="cursor-pointer gap-1.5 text-rose-600 dark:text-rose-400 disabled:opacity-60"
                title={t('admin.ops.clearLogsHint')}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {clearing ? t('admin.ops.clearingLogs') : t('admin.ops.clearLogs')}
              </Button>
            )}
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
          <pre className="max-h-[460px] overflow-auto rounded-lg bg-slate-50 dark:bg-[#0F1222] p-3 text-[11px] leading-relaxed">
            {visible.slice(-500).map((line, i) => (
              <div
                key={i}
                className={'group flex items-start justify-between gap-2 px-1 py-0.5 rounded hover:bg-slate-200/60 dark:hover:bg-white/[0.04] transition-colors ' + lineTone(line)}
              >
                <span className="font-mono break-all flex-1">{line}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(line);
                    setCopiedLineIdx(i);
                    setTimeout(() => setCopiedLineIdx(null), 1500);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-slate-800 dark:hover:text-white rounded transition-opacity shrink-0 cursor-pointer"
                  title={copiedLineIdx === i ? t('common.copied') : t('common.copy')}
                >
                  {copiedLineIdx === i ? (
                    <Check className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            ))}
          </pre>
        )}
      </CardContent>
    </Card>
  );
};
