/**
 * Human-readable byte size for operator-facing numbers.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Logs cleared" with no quantity is indistinguishable from a no-op: an
 * operator cannot tell whether 40 bytes or 400 MB were reclaimed, and the
 * whole point of clearing logs is usually to reclaim disk. The clear endpoint
 * returns `freed_bytes`; this turns it into something actionable.
 *
 * Binary units (1024), matching what `du`/`df` and docker's own output report
 * for this kind of figure.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes and kilobytes read better as whole numbers; larger units keep one
  // decimal so "1.4 GB" does not collapse to "1 GB".
  const rounded = unit <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}
