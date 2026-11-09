import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { checkOha } from './oha';
import { loadConfiguration } from './configuration';
import { createLoadReport, saveLoadReport } from './report';
import { loadEnvironment } from './environment';
import { LoadRuntime } from './runtime';
import { LoadClient } from './client';
import { LoadMonitor } from './monitor';
import { ScenarioRunner } from './scenario';
import { warmup } from './scenarios/warmup';
import { independentWallets } from './scenarios/independent-wallets';
import { hotWallet } from './scenarios/hot-wallet';
import { idempotentReplays } from './scenarios/idempotent-replays';
import { competingBets } from './scenarios/competing-bets';
import { httpBenchmarks } from './http-benchmarks';
import { waitForDrain } from './drain';
import { assert } from './assert';

const configuration = loadConfiguration();
const {
  requests,
  concurrency,
  sampleMs,
  drainTimeoutMs,
  expectDrain,
  external,
} = configuration;
const runId = randomUUID();
const report = createLoadReport(runId, configuration);
const runtime = new LoadRuntime(configuration, runId);
let monitor: LoadMonitor | undefined;
try {
  report.tools = {
    financialChecks: 'Bun fetch + explicit financial assertions',
    httpBenchmark: await checkOha(),
    docs: 'apiDoc (Bun CLI)',
  };
  report.environment = loadEnvironment();
  await runtime.start(report);
  report.instances = runtime.urls;
  monitor = new LoadMonitor(runtime.urls, sampleMs);
  await monitor.start();
  const client = new LoadClient(runtime.urls, runId);
  const runner = new ScenarioRunner(configuration, monitor, report);
  await warmup(client, concurrency);
  if (expectDrain) await waitForDrain(monitor, drainTimeoutMs, sampleMs);
  await independentWallets(client, runner, requests, concurrency);
  await hotWallet(client, runner, requests);
  const replay = await idempotentReplays(client, runner);
  const budget = await competingBets(client, runner, requests);
  await httpBenchmarks(
    client,
    monitor,
    configuration,
    runId,
    runtime.urls,
    replay,
    report,
  );
  report.drain = expectDrain
    ? await waitForDrain(monitor, drainTimeoutMs, sampleMs)
    : { verified: false, reason: 'Drain not required by configuration' };
  const finalMetrics = await monitor.sample();
  report.finalMetrics = finalMetrics;
  if (!external && expectDrain) {
    const expectedByScenario = {
      warmup: 20 * 2,
      independentWallets: requests * 2,
      hotWallet: requests * 2,
      idempotentReplays: 2,
      competingBets: Number(budget) * 2 + (requests - Number(budget)) + 2,
    };
    const expectedEvents = Object.values(expectedByScenario).reduce(
      (sum, count) => sum + count,
      0,
    );
    report.delivery = {
      expectedByScenario,
      expectedUniqueEvents: expectedEvents,
      published: finalMetrics.published,
      pending: finalMetrics.outboxPending,
    };
    assert(
      finalMetrics.published === expectedEvents &&
        finalMetrics.outboxPending === 0,
      'Outbox delivery count mismatch',
    );
  }
  assert(
    finalMetrics.workerErrors === monitor.samples[0]!.workerErrors,
    'Worker errors occurred during warmup or drain',
  );
  await monitor.stop();
  report.metricsSamples = monitor.samples;
  assert(
    monitor.errors.length === 0,
    `Monitoring failed: ${monitor.errors.join(', ')}`,
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await monitor?.stop();
  if (monitor) {
    report.metricsSamples = monitor.samples;
    report.monitorErrors = monitor.errors;
  }
  const cleanupErrors = await runtime.close();
  if (cleanupErrors.length) {
    report.cleanupErrors = cleanupErrors;
    report.passed = false;
    process.exitCode = 1;
  }
  await saveLoadReport(runId, report);
}
