import type { OpsAuditEntry, OpsOperation } from '../../../types/admin';

/**
 * Client-side download helper for admin exports.
 *
 * WHY A HELPER
 * ------------
 * Blob downloads leak if they are not cleaned up, and the two failure modes
 * that matter are easy to get wrong per call site:
 *   1. the object URL is never revoked, so a long admin session accumulates
 *      the full log text in memory until reload;
 *   2. the export appears to succeed on an empty/failed fetch, which is the
 *      "mask the failure" behaviour the project rules forbid.
 *
 * The content is produced in the browser from data the server ALREADY
 * redacted, so nothing is re-fetched and nothing sensitive is added here.
 */
export interface ExportFile {
  /** File name WITHOUT the extension, e.g. 'tezlify-errors-2026-09-29T10-02-00'. */
  baseName: string;
  content: string;
  mimeType?: string;
}

/** Build a filesystem-safe, sortable, collision-free base name. */
export function exportBaseName(prefix: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${prefix}-${stamp}`;
}

/**
 * Trigger a download of `file` in the browser.
 *
 * The URL is revoked on the next tick rather than immediately: Safari and
 * Firefox abort an in-flight download when the object URL disappears in the
 * same task that created it.
 */
export function downloadTextFile(file: ExportFile): void {
  const mimeType = file.mimeType ?? 'text/plain;charset=utf-8';
  const blob = new Blob([file.content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${file.baseName}.${mimeType.includes('json') ? 'json' : 'txt'}`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Serialise a log bundle, with metadata an operator needs when filing a bug. */
export function buildLogExport(options: {
  prefix: string;
  service: string;
  lines: string[];
  levelFilter?: string;
  query?: string;
  /** Extra services included, for a merged export. */
  extra?: Record<string, string[]>;
  now?: Date;
}): ExportFile {
  const { prefix, service, lines, levelFilter, query, extra, now } = options;
  const header = [
    `# Tezlify operations export`,
    `# service: ${service}`,
    `# lines: ${lines.length}`,
    levelFilter && levelFilter !== 'ALL' ? `# level: ${levelFilter}` : '# level: ALL',
    query?.trim() ? `# search: ${query.trim()}` : null,
    `# generated: ${(now ?? new Date()).toISOString()}`,
    '',
  ].filter((l): l is string => l !== null);

  const body: string[] = [];
  // A merged export groups by service so a single file stays readable.
  if (extra && Object.keys(extra).length > 0) {
    for (const [svc, svcLines] of Object.entries(extra)) {
      if (svc === service) continue;
      body.push(`===== ${svc} (${svcLines.length} lines) =====`);
      body.push(...svcLines);
      body.push('');
    }
  }
  body.push(`===== ${service} (${lines.length} lines) =====`);
  body.push(...lines);

  return {
    baseName: exportBaseName(prefix, now),
    content: [...header, ...body].join('\n'),
  };
}

/**
 * Escape one CSV cell.
 *
 * The leading apostrophe is the important part: a cell starting with =, +, - or
 * @ is executed as a FORMULA by Excel and Sheets. An audit trail is exactly the
 * kind of data an operator opens in a spreadsheet, and an error message or actor
 * name is fully attacker-influenced, so this is a real injection path rather
 * than a theoretical one.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Neutralise embedded newlines and quotes so a row stays one row.
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface HistoryExportOptions {
  operations: OpsOperation[];
  audit: OpsAuditEntry[];
  now?: Date;
}

/** Build a CSV export of the operation history and audit trail. */
export function buildHistoryCsv(options: HistoryExportOptions): ExportFile {
  const { operations, audit, now } = options;
  const lines: string[] = [];

  lines.push('# Tezlify operations history');
  lines.push(`# operations: ${operations.length}`);
  lines.push(`# audit entries: ${audit.length}`);
  lines.push(`# generated: ${(now ?? new Date()).toISOString()}`);
  lines.push('');

  lines.push('## Operations');
  lines.push([
    'id', 'name', 'label', 'status', 'step', 'actor', 'destructive',
    'started_at', 'finished_at', 'duration_ms', 'exit_code', 'error',
  ].join(','));
  for (const op of operations) {
    lines.push([
      csvCell(op.id), csvCell(op.name), csvCell(op.label), csvCell(op.status),
      csvCell(op.step), csvCell(op.actor), csvCell(op.destructive),
      csvCell(op.started_at), csvCell(op.finished_at), csvCell(op.duration_ms),
      csvCell(op.exit_code), csvCell(op.error),
    ].join(','));
  }

  lines.push('');
  lines.push('## Audit trail');
  lines.push(['at', 'action', 'actor', 'result', 'operation_id', 'detail'].join(','));
  for (const entry of audit) {
    lines.push([
      csvCell(entry.at), csvCell(entry.action), csvCell(entry.actor),
      csvCell(entry.result), csvCell(entry.id), csvCell(entry.detail),
    ].join(','));
  }

  return {
    baseName: exportBaseName('tezlify-operations-history', now),
    content: lines.join('\n'),
    mimeType: 'text/csv;charset=utf-8',
  };
}

/**
 * Build a JSON export.
 *
 * No comment header: the point of this format is that `jq` can read it. The
 * generation timestamp travels INSIDE the payload instead, so the information
 * is not lost just because the file has to stay parseable.
 */
export function buildHistoryJson(options: HistoryExportOptions): ExportFile {
  const { operations, audit, now } = options;
  return {
    baseName: exportBaseName('tezlify-operations-history', now),
    content: JSON.stringify(
      { generated_at: (now ?? new Date()).toISOString(), operations, audit },
      null,
      2,
    ),
    mimeType: 'application/json;charset=utf-8',
  };
}

