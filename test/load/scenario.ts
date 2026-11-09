import { LoadConfiguration } from './configuration';
import { LoadMonitor } from './monitor';
import { latencyStatistics } from './statistics';
import { HttpLoadError } from './client';
import { pool } from './pool';
import { assert } from './assert';

export class ScenarioRunner {
  constructor(
    private readonly configuration: LoadConfiguration,
    private readonly monitor: LoadMonitor,
    private readonly report: Record<string, unknown>,
  ) {}
  async run(
    name: string,
    work: (index: number, lane: number) => Promise<number>,
  ) {
    const { monitor, report, configuration } = this;
    const { requests, concurrency, p95Limit } = configuration;
    const baseline = await monitor.sample();
    const latencies: number[] = [];
    const errors: string[] = [];
    const statusCounts: Record<string, number> = {};
    const start = performance.now();
    await pool(requests, concurrency, async (index, lane) => {
      const before = performance.now();
      try {
        const status = await work(index, lane);
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        const code =
          error instanceof HttpLoadError
            ? String(error.status)
            : 'transportOrValidation';
        statusCounts[code] = (statusCounts[code] ?? 0) + 1;
      } finally {
        latencies.push(performance.now() - before);
      }
    });
    const elapsedMs = performance.now() - start;
    const end = await monitor.sample();
    const samples = monitor.samples.filter(
      (sample) =>
        sample.elapsedMs >= baseline.elapsedMs &&
        sample.elapsedMs <= end.elapsedMs,
    );
    const stats = {
      requests,
      ...latencyStatistics(latencies, errors.length, elapsedMs),
      statusCounts,
      lockConflicts: end.lockConflicts - baseline.lockConflicts,
      retries: end.retries - baseline.retries,
      duplicateDetections: end.duplicates - baseline.duplicates,
      workerErrors: end.workerErrors - baseline.workerErrors,
      outbox: {
        initialPending: baseline.outboxPending,
        finalPending: end.outboxPending,
        sampledPeakPending: Math.max(
          ...samples.map((sample) => sample.outboxPending),
        ),
        sampledPeakLagSeconds: Math.max(
          ...samples.map((sample) => sample.outboxLagSeconds),
        ),
        finalLagSeconds: end.outboxLagSeconds,
      },
      errorExamples: errors.slice(0, 5),
    };
    (report.scenarios as Record<string, unknown>)[name] = stats;
    console.log(JSON.stringify({ scenario: name, ...stats }));
    assert(
      stats.lockConflicts >= 0 && stats.retries >= 0 && stats.workerErrors >= 0,
      'Counters reset during measurement',
    );
    assert(errors.length === 0, `${name}: ${errors.length} requests failed`);
    assert(stats.workerErrors === 0, `${name}: worker failures`);
    assert(
      stats.p95Ms !== null && stats.p95Ms <= p95Limit,
      `${name}: p95 exceeds ${p95Limit}ms`,
    );
  }
}
