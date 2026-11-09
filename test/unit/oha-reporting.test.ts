import { expect, test } from 'bun:test';
import { ohaStatistics, type OhaReport } from '../load/oha';
function fixture(): OhaReport {
  return {
    summary: { total: 2, requestsPerSec: 5 },
    latencyPercentiles: { p50: 0.01, p95: 0.03, p99: 0.05 },
    statusCodeDistribution: { '200': 8, '500': 1 },
    errorDistribution: { timeout: 1 },
  };
}
test('oha report converts seconds to milliseconds and counts HTTP and transport errors', () => {
  const stats = ohaStatistics(fixture(), 10);
  expect(stats.p50Ms).toBe(10);
  expect(stats.p95Ms).toBe(30);
  expect(stats.p99Ms).toBe(50);
  expect(stats.elapsedMs).toBe(2000);
  expect(stats.errors).toBe(2);
  expect(stats.errorRate).toBe(0.2);
  expect(stats.completed).toBe(9);
});
test('oha report rejects impossible totals and invalid statistics', () => {
  expect(() => ohaStatistics(fixture(), 1)).toThrow('Invalid oha report');
  const raw = fixture();
  raw.latencyPercentiles.p95 = NaN;
  expect(() => ohaStatistics(raw, 10)).toThrow('Invalid oha report');
});
