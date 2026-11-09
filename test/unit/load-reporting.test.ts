import { expect, test } from 'bun:test';
import { aggregateMetrics } from '../load/monitor';
import { latencyStatistics } from '../load/statistics';

test('load report counts failed attempts in latency and error rate', () => {
  const result = latencyStatistics([30, 10, 20, 400], 1, 1000);
  expect(result.completed).toBe(4);
  expect(result.errorRate).toBe(0.25);
  expect(result.p50Ms).toBe(20);
  expect(result.p95Ms).toBe(400);
  expect(result.throughputRps).toBe(4);
  expect(latencyStatistics([], 0, 1000).p95Ms).toBeNull();
});
function replica(conflicts: number, pending: number, lag: number) {
  return `jungle_lock_conflicts_total ${conflicts}\njungle_duplicates_total 2\njungle_retries_total 0\njungle_outbox_published_total 10\njungle_worker_errors_total 0\njungle_outbox_pending ${pending}\njungle_outbox_oldest_pending_age_seconds ${lag}\n`;
}
test('load metrics sum process counters but never sum shared outbox backlog', () => {
  const result = aggregateMetrics([
    replica(2, 20, 0.5),
    replica(3, 18, 0.8),
    replica(1, 19, 0.7),
  ]);
  expect(result.lockConflicts).toBe(6);
  expect(result.duplicates).toBe(6);
  expect(result.published).toBe(30);
  expect(result.outboxPending).toBe(20);
  expect(result.outboxLagSeconds).toBe(0.8);
  expect(() => aggregateMetrics(['jungle_lock_conflicts_total 0'])).toThrow(
    'Invalid or missing metric',
  );
});
