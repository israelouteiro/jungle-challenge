import { runOha } from './oha';
import { LoadClient } from './client';
import { LoadConfiguration } from './configuration';
import { LoadMonitor } from './monitor';
import { assert } from './assert';
import { idempotentReplays } from './scenarios/idempotent-replays';

export async function httpBenchmarks(
  client: LoadClient,
  monitor: LoadMonitor,
  configuration: LoadConfiguration,
  runId: string,
  urls: string[],
  replay: Awaited<ReturnType<typeof idempotentReplays>>,
  report: Record<string, unknown>,
) {
  const { requests, concurrency, p95Limit } = configuration;
  const { duplicate, input, key } = replay;
  // Native oha generates HTTP traffic; Bun retains financial validation and monitoring.
  const benchmarks = [
    { name: 'walletReads', path: `/wallets/${duplicate.id}` },
    { name: 'ledgerReads', path: `/wallets/${duplicate.id}/ledger?limit=50` },
    {
      name: 'processedReplays',
      path: '/wagering/transactions',
      body: input,
      key,
    },
  ];
  for (const benchmark of benchmarks) {
    const baseline = await monitor.sample();
    const result = await runOha({
      ...benchmark,
      runId,
      urls,
      requests,
      concurrency,
    });
    const end = await monitor.sample();
    const samples = monitor.samples.filter(
      (sample) =>
        sample.elapsedMs >= baseline.elapsedMs &&
        sample.elapsedMs <= end.elapsedMs,
    );
    const stats = {
      ...result,
      lockConflicts: end.lockConflicts - baseline.lockConflicts,
      duplicateDetections: end.duplicates - baseline.duplicates,
      outbox: {
        finalPending: end.outboxPending,
        sampledPeakPending: Math.max(
          ...samples.map((sample) => sample.outboxPending),
        ),
        sampledPeakLagSeconds: Math.max(
          ...samples.map((sample) => sample.outboxLagSeconds),
        ),
      },
    };
    (report.httpBenchmarks as Record<string, unknown>)[benchmark.name] = stats;
    console.log(JSON.stringify({ httpBenchmark: benchmark.name, ...stats }));
    assert(
      result.errors === 0 && Object.keys(result.transportErrors).length === 0,
      `${benchmark.name}: oha request failures`,
    );
    assert(
      result.p95Ms <= p95Limit,
      `${benchmark.name}: oha p95 exceeds ${p95Limit}ms`,
    );
    if (benchmark.name === 'processedReplays')
      assert(
        stats.duplicateDetections === requests,
        'Native oha replay count mismatch',
      );
    await client.check(duplicate, 1n, 1);
  }
}
