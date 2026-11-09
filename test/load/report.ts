import { mkdir } from 'node:fs/promises';
import { LoadConfiguration } from './configuration';

export function createLoadReport(
  runId: string,
  configuration: LoadConfiguration,
): Record<string, unknown> {
  const {
    requests,
    concurrency,
    p95Limit,
    sampleMs,
    drainTimeoutMs,
    workersEnabled,
    external,
    expectDrain,
  } = configuration;
  return {
    schemaVersion: 3,
    runId,
    startedAt: new Date().toISOString(),
    parameters: {
      requestsPerScenario: requests,
      concurrency,
      p95LimitMs: p95Limit,
      sampleMs,
      drainTimeoutMs,
      workersEnabled: external ? 'externally managed' : workersEnabled,
      expectDrain,
    },
    methodology: {
      model: 'closed-loop',
      latency:
        'financial scenarios: Bun client clock including validation and failures; httpBenchmarks: oha native HTTP percentiles, transport errors reported separately',
      warmupRequests: 20,
      workload:
        'HTTP commands with asynchronous SQS outbox publishing; no SQS command ingestion benchmark',
      outboxLag:
        'age of oldest unpublished event, DB snapshot, max across replicas',
      lockConflicts:
        'delta of deadlock/serialization/lock-timeout counters summed across replicas; ordinary lock waits are not errors',
      peak: 'sampled peaks are lower bounds, not continuous maxima',
    },
    scenarios: {},
    httpBenchmarks: {},
  };
}
export async function saveLoadReport(
  runId: string,
  report: Record<string, unknown>,
) {
  report.finishedAt = new Date().toISOString();
  await mkdir('artifacts/load', { recursive: true });
  const path = `artifacts/load/${runId}.json`;
  await Bun.write(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`Load report: ${path}`);
}
