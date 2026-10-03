/**
 * Centralized, consistent date and time formatting for Admin Operations.
 * Displays local date and time in a standard format: DD.MM.YYYY HH:mm:ss.
 */

export function formatOpsDateTime(input: string | number | Date | null | undefined): string {
  if (!input) return '-';
  try {
    const d = typeof input === 'number'
      ? new Date(input > 1e11 ? input : input * 1000)
      : new Date(input);
    if (isNaN(d.getTime())) return String(input);

    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());

    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  } catch {
    return String(input);
  }
}

export function formatOpsTime(input: string | number | Date | null | undefined): string {
  if (!input) return '-';
  try {
    const d = typeof input === 'number'
      ? new Date(input > 1e11 ? input : input * 1000)
      : new Date(input);
    if (isNaN(d.getTime())) return String(input);

    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());

    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return String(input);
  }
}
