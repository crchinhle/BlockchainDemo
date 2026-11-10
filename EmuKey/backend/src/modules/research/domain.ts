export const defaults = {
  name: 'Smoke',
  purpose: 'Kiểm tra tích hợp, không phải kết luận nghiên cứu',
  strategy: 'HYBRID',
  variant: 'bounded-snapshot-v1',
  repetitions: 1,
  seed: 42,
  licenses: 1,
  devices: 1,
  maxDevices: 1,
  rate: 10,
  concurrency: 8,
  probeMs: 100,
  cacheTtlMs: 5000,
  tokenTtlMs: 3000,
  pollMs: 1000,
  eventMode: 'healthy',
  eventDelayMs: 2000,
  warmupMs: 300,
  revokeAfterMs: 500,
  observeMs: 6000,
  timeoutMs: 30000,
  confirmations: 1,
  freshnessMs: 5000,
  clients: ['old-token', 'refresh'],
  fault: 'none',
  faultDurationMs: 1000,
};
export type Config = typeof defaults;
export type Sample = {
  decision: string;
  decisionStartedAt: number;
  decisionEvaluatedAt: number;
  responseReceivedAt: number;
  latencyMs: number;
  client: string;
  stale?: boolean;
  rpcCalls?: number;
  cacheHit?: boolean;
  [key: string]: unknown;
};
export function validateConfig(input: Partial<Config>): Config {
  const c = { ...defaults, ...input };
  if (input.probeMs === undefined) c.probeMs = Math.round(1000 / c.rate);
  if (Math.abs(c.probeMs - 1000 / c.rate) > 1)
    throw new Error('PROBE_RATE_MISMATCH');
  for (const key of Object.keys(input))
    if (!(key in defaults)) throw new Error(`UNKNOWN_CONFIG:${key}`);
  const bounds: Record<string, [number, number]> = {
    repetitions: [1, 20],
    seed: [0, 2147483647],
    licenses: [1, 5],
    devices: [1, 5],
    maxDevices: [1, 10],
    rate: [1, 100],
    concurrency: [1, 32],
    probeMs: [10, 5000],
    cacheTtlMs: [100, 120000],
    tokenTtlMs: [100, 120000],
    pollMs: [100, 120000],
    eventDelayMs: [0, 120000],
    warmupMs: [0, 10000],
    revokeAfterMs: [100, 120000],
    observeMs: [1000, 180000],
    timeoutMs: [5000, 600000],
    confirmations: [1, 10],
    freshnessMs: [100, 120000],
    faultDurationMs: [0, 30000],
  };
  for (const [k, [min, max]] of Object.entries(bounds)) {
    const v = c[k as keyof Config];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`INVALID_CONFIG:${k}`);
  }
  if (
    !['CENTRALIZED', 'DIRECT_ONCHAIN', 'HYBRID'].includes(c.strategy) ||
    c.variant !== 'bounded-snapshot-v1' ||
    !['healthy', 'delayed', 'dropped'].includes(c.eventMode) ||
    !['none', 'rpc-outage', 'cache-race'].includes(c.fault)
  )
    throw new Error('INVALID_MODE');
  if (
    !Array.isArray(c.clients) ||
    !c.clients.length ||
    new Set(c.clients).size !== c.clients.length ||
    c.clients.some((v) => !['old-token', 'refresh'].includes(v))
  )
    throw new Error('INVALID_CLIENTS');
  if (
    typeof c.name !== 'string' ||
    !c.name.trim() ||
    c.name.length > 100 ||
    typeof c.purpose !== 'string' ||
    c.purpose.length > 2000
  )
    throw new Error('INVALID_NAME');
  if (
    c.devices > c.maxDevices ||
    c.timeoutMs < c.warmupMs + c.revokeAfterMs + c.observeMs + 2000
  )
    throw new Error('INVALID_LIMITS');
  if (
    ((c.repetitions * c.rate * (c.revokeAfterMs + c.observeMs)) / 1000) *
      c.clients.length *
      c.licenses *
      c.devices >
    100000
  )
    throw new Error('WORKLOAD_LIMIT');
  return c;
}
export const tokenDeadline = (
  iat: number,
  observed: number,
  c: number,
  t: number,
  licenseExp: number,
) => Math.min(iat + t, observed + c, licenseExp);
export function summarize(
  samples: Sample[],
  tc: number | null,
  end: number,
  resolution: number,
) {
  const measured = samples.filter((s) => s.decision !== 'DROPPED');
  const lat = measured.map((s) => s.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    lat.length ? lat[Math.max(0, Math.ceil(lat.length * p) - 1)]! : null;
  const stale =
    tc === null
      ? []
      : samples.filter(
          (s) =>
            s.decision === 'ALLOW' &&
            s.decisionStartedAt >= tc &&
            s.decisionEvaluatedAt >= tc,
        );
  const last = stale.length
    ? Math.max(...stale.map((s) => s.decisionEvaluatedAt))
    : null;
  const tails = new Map<string, Sample>();
  for (const s of samples)
    if (s.decision !== 'DROPPED')
      tails.set(`${s.client}:${String(s.licenseId)}:${String(s.deviceId)}`, s);
  const count = (decision: string) =>
    samples.filter((s) => s.decision === decision).length;
  const span = samples.length
    ? Math.max(1, end - Math.min(...samples.map((s) => s.decisionStartedAt)))
    : 1;
  return {
    sampleCount: samples.length,
    allow: count('ALLOW'),
    deny: count('DENY'),
    error: count('ERROR'),
    timeout: count('TIMEOUT'),
    dropped: count('DROPPED'),
    staleAccepts: stale.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    observedWindowMs:
      last === null || tc === null ? null : Math.max(0, last - tc),
    lastStaleAccept: last,
    rightCensored:
      tc === null || [...tails.values()].some((s) => s.decision !== 'DENY'),
    rpcCalls: samples.reduce((a, s) => a + (s.rpcCalls ?? 0), 0),
    cacheHits: samples.filter((s) => s.cacheHit).length,
    achievedLoad: (measured.length * 1000) / span,
    offeredLoad: (samples.length * 1000) / span,
    horizonMs: tc === null ? null : end - tc,
    resolutionMs: resolution,
    warnings: [
      ...(lat.length < 100 ? ['P99 có dưới 100 mẫu; độ tin cậy thấp.'] : []),
      ...(last === null
        ? [
            'Không quan sát thấy stale acceptance trong độ phân giải đã ghi; không khẳng định cửa sổ thật bằng 0.',
          ]
        : []),
      'CPU/RAM: N/A. Mẫu trong một repetition có tương quan.',
    ],
  };
}
export function csv(rows: Record<string, unknown>[], keys: string[]) {
  return (
    keys.join(',') +
    '\n' +
    rows
      .map((row) =>
        keys
          .map((k) => {
            const value = row[k];
            let s =
              typeof value === 'object' && value !== null
                ? JSON.stringify(value)
                : typeof value === 'string'
                  ? value
                  : typeof value === 'number' || typeof value === 'boolean'
                    ? String(value)
                    : '';
            if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\n') +
    '\n'
  );
}
