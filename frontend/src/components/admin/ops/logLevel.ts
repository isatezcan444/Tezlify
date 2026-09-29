/**
 * Single source of truth for log level classification.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gateway (pino) and caddy (caddy JSON) emit STRUCTURD JSON with different
 * level conventions:
 *
 *   gateway: {"level":50,"msg":"transaction failed"}   50=fatal 40=error 30=warn 20=info
 *   caddy:   {"level":"error","msg":"challenge failed"} "error" / "warn" / "info"
 *
 * The previous implementation only ran a keyword regex over the raw line, so
 * it MISSED every gateway line whose message text happened not to contain a
 * keyword. A real `{"level":50,"msg":"transaction failed, rolling back"}`
 * line was filed as INFO: the Error feed looked empty while the gateway was
 * throwing, and an operator had no way to see it. Parsing the structured level
 * first, and falling back to the text heuristic only for non-JSON output
 * (plain `docker logs` text), fixes that.
 *
 * pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
 */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO';

const PINO_ERROR = new Set([50, 60]);
const PINO_WARN = new Set([40]);

/** Parse a line's structured level, or null when it carries none. */
function structuredLevel(line: string): LogLevel | null {
  // Cheap pre-check: almost no log line is JSON, and JSON.parse on every one of
  // a few hundred lines is measurable in the render path.
  if (!line.includes('"level"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // Not valid JSON (or truncated) -> fall through to the text heuristic.
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as { level?: unknown }).level;

  if (typeof raw === 'number') {
    if (PINO_ERROR.has(raw)) return 'ERROR';
    if (PINO_WARN.has(raw)) return 'WARN';
    return 'INFO';
  }
  if (typeof raw === 'string') {
    const l = raw.toLowerCase();
    if (l === 'error' || l === 'fatal' || l === 'panic') return 'ERROR';
    if (l === 'warn' || l === 'warning') return 'WARN';
    if (l === 'info' || l === 'debug' || l === 'trace') return 'INFO';
  }
  return null;
}

/** Classify any log line, JSON or plain text. */
export function classifyLogLevel(line: string): LogLevel {
  const structured = structuredLevel(line);
  if (structured) return structured;

  // Plain-text fallback for non-JSON output.
  const l = line.toLowerCase();
  if (/\b(error|err|fatal|critical|exception|traceback|failed|panic)\b/.test(l)) return 'ERROR';
  if (/\b(warn|warning)\b/.test(l)) return 'WARN';
  return 'INFO';
}

/** True when a line should appear in the error feed. */
export function isErrorLine(line: string): boolean {
  return classifyLogLevel(line) === 'ERROR';
}
