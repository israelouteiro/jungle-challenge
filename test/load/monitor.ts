import { setTimeout as delay } from 'node:timers/promises';
export interface MetricsSnapshot {
  elapsedMs: number;
  lockConflicts: number;
  duplicates: number;
  retries: number;
  published: number;
  workerErrors: number;
  outboxPending: number;
  outboxLagSeconds: number;
}
export function parseMetrics(payload: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of payload.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+)\s+([\d.eE+-]+)$/.exec(line);
    if (match) metrics.set(match[1]!, Number(match[2]));
  }
  return metrics;
}
export function aggregateMetrics(
  payloads: string[],
): Omit<MetricsSnapshot, 'elapsedMs'> {
  const replicas = payloads.map(parseMetrics);
  const values = (name: string) =>
    replicas.map((metrics) => {
      const value = metrics.get(name);
      if (value === undefined || !Number.isFinite(value) || value < 0)
        throw new Error(`Invalid or missing metric: ${name}`);
      return value;
    });
  const sum = (name: string) =>
    values(name).reduce((total, value) => total + value, 0);
  // These gauges describe one shared DB. Summing replicas would triple the backlog.
  const max = (name: string) => Math.max(...values(name));
  return {
    lockConflicts: sum('jungle_lock_conflicts_total'),
    duplicates: sum('jungle_duplicates_total'),
    retries: sum('jungle_retries_total'),
    published: sum('jungle_outbox_published_total'),
    workerErrors: sum('jungle_worker_errors_total'),
    outboxPending: max('jungle_outbox_pending'),
    outboxLagSeconds: max('jungle_outbox_oldest_pending_age_seconds'),
  };
}
export class LoadMonitor {
  readonly samples: MetricsSnapshot[] = [];
  readonly errors: string[] = [];
  private readonly started = performance.now();
  private readonly stopSignal = new AbortController();
  private task?: Promise<void>;
  constructor(
    private readonly urls: string[],
    private readonly intervalMs: number,
  ) {}
  async sample(): Promise<MetricsSnapshot> {
    const payloads = await Promise.all(
      this.urls.map(async (url) => {
        const response = await fetch(url + '/metrics', {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
        return response.text();
      }),
    );
    const snapshot = {
      elapsedMs: performance.now() - this.started,
      ...aggregateMetrics(payloads),
    };
    this.samples.push(snapshot);
    return snapshot;
  }
  async start(): Promise<void> {
    await this.sample();
    this.task = (async () => {
      while (!this.stopSignal.signal.aborted) {
        try {
          await delay(this.intervalMs, undefined, {
            signal: this.stopSignal.signal,
          });
        } catch {
          break;
        }
        try {
          await this.sample();
        } catch (error) {
          this.errors.push(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.task;
  }
}
