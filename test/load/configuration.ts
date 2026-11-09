import process from 'node:process';

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000)
    throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfiguration() {
  const requests = positive('LOAD_REQUESTS', 100);
  const concurrency = positive('LOAD_CONCURRENCY', 10);
  const p95Limit = positive('LOAD_P95_MS', 5000);
  const sampleMs = positive('LOAD_SAMPLE_MS', 500);
  const drainTimeoutMs = positive('LOAD_DRAIN_TIMEOUT_MS', 60000);
  const urls = (process.env.LOAD_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const external = Boolean(process.env.LOAD_URLS);
  const workersEnabled = process.env.LOAD_WORKERS !== 'false';
  const expectDrain = external
    ? process.env.LOAD_EXPECT_DRAIN === 'true'
    : workersEnabled;
  return {
    requests,
    concurrency,
    p95Limit,
    sampleMs,
    drainTimeoutMs,
    urls,
    external,
    workersEnabled,
    expectDrain,
  };
}
export type LoadConfiguration = ReturnType<typeof loadConfiguration>;
