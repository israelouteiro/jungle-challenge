import { trace } from '@opentelemetry/api';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@nestjs/common';
const durationBuckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, Infinity];
@Injectable()
export class Telemetry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  constructor() {
    for (const metric of [
      'outbox_published_total',
      'duplicates_total',
      'retries_total',
      'dlq_messages_total',
      'lock_conflicts_total',
      'reconciliation_mismatches_total',
      'reference_retries_total',
      'worker_errors_total',
    ])
      this.counters.set(metric, 0);
    for (const status of [
      'PENDING',
      'PENDING_REFERENCE',
      'PROCESSED',
      'REJECTED',
      'FAILED',
    ]) {
      for (const transport of ['http', 'sqs'])
        this.counters.set(
          `wager_requests_total{transport="${transport}",status="${status}"}`,
          0,
        );
    }
    this.gauges.set('outbox_lag_seconds', 0);
    // Expose a zero baseline before the first request so rate() captures the first burst.
    this.counters.set('processing_duration_seconds_sum', 0);
    this.counters.set('processing_duration_seconds_count', 0);
    for (const bound of durationBuckets)
      this.counters.set(
        `processing_duration_seconds_bucket{le="${bound === Infinity ? '+Inf' : bound}"}`,
        0,
      );
  }
  recordLockConflict(error: unknown): void {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['40P01', '40001', '55P03'].includes(String(error.code))
    )
      this.increment('lock_conflicts_total');
  }
  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }
  observeMilliseconds(value: number): void {
    this.increment('processing_duration_seconds_sum', value / 1000);
    this.increment('processing_duration_seconds_count');
    for (const bound of durationBuckets) {
      if (value / 1000 <= bound)
        this.increment(
          `processing_duration_seconds_bucket{le="${bound === Infinity ? '+Inf' : bound}"}`,
        );
    }
  }
  render(): string {
    return (
      '# TYPE jungle_processing_duration_seconds histogram\n' +
      [...this.counters, ...this.gauges]
        .map(([key, value]) => `jungle_${key} ${value}`)
        .join('\n') +
      '\n'
    );
  }
  log(
    event: string,
    context: Record<string, unknown> = {},
    level = 'info',
  ): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
        spanId: trace.getActiveSpan()?.spanContext().spanId ?? null,
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        ...Object.fromEntries(
          Object.entries(context).filter(([, value]) => value !== undefined),
        ),
      }),
    );
  }
}
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, ..._args: unknown[]) {
    this.write('error', message);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  private write(level: string, message: unknown, context?: string) {
    // Infrastructure errors may embed SQL parameters. Do not serialize arbitrary errors.
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message:
          typeof message === 'string' ? message : 'Application diagnostic',
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        context,
      }),
    );
  }
}
