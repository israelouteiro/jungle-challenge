import { LoadMonitor } from './monitor';

export async function waitForDrain(
  monitor: LoadMonitor,
  drainTimeoutMs: number,
  sampleMs: number,
) {
  const started = performance.now();
  let empty = 0;
  while (performance.now() - started < drainTimeoutMs) {
    const snapshot = await monitor.sample();
    empty = snapshot.outboxPending === 0 ? empty + 1 : 0;
    if (empty >= 2)
      return {
        elapsedMs: performance.now() - started,
        pending: 0,
        lagSeconds: 0,
      };
    await Bun.sleep(Math.min(sampleMs, 500));
  }
  throw new Error(`Outbox did not drain within ${drainTimeoutMs}ms`);
}
