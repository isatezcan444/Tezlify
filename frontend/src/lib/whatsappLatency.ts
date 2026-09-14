/** Local development only. No payloads, identifiers or telemetry uploads. */
const enabled = import.meta.env.DEV && import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING === 'true';
const pending = new Map<string, number>();
const samples: Array<{ metric: string; duration_ms: number; epoch_ms: number }> = [];

export function startWaLatency(metric: string, key: string | number = ''): void {
  if (!enabled) return;
  if (pending.size >= 512) pending.delete(pending.keys().next().value!);
  pending.set(`${metric}:${key}`, performance.now());
}

export function finishWaLatency(metric: string, key: string | number = ''): void {
  if (!enabled) return;
  const id = `${metric}:${key}`;
  const started = pending.get(id);
  if (started === undefined) return;
  pending.delete(id);
  samples.push({ metric, duration_ms: performance.now() - started, epoch_ms: Date.now() });
  if (samples.length > 512) samples.shift();
}

/** Explicit import from devtools; bounded and excludes correlation keys. */
export function readWaLatency(): ReadonlyArray<{ metric: string; duration_ms: number; epoch_ms: number }> {
  return samples.map(sample => ({ ...sample }));
}