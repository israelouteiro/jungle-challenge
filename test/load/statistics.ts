export function latencyStatistics(
  latencies: number[],
  errors: number,
  elapsedMs: number,
) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null;
  return {
    completed: sorted.length,
    elapsedMs,
    throughputRps: sorted.length / (elapsedMs / 1000),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    errors,
    errorRate: sorted.length ? errors / sorted.length : null,
  };
}
