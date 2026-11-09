import { expect, test } from 'bun:test';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import {
  inSpan,
  remoteContext,
  SpanKind,
  startTracing,
  traceHeaders,
} from '../../src/observability/tracing';

test('Bun preserves async trace context, propagation, parentage and sanitized errors', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = startTracing(exporter)!;
  try {
    let carrier: Record<string, string> = {};
    await inSpan('request', SpanKind.SERVER, {}, async () => {
      await Bun.sleep(1);
      carrier = traceHeaders();
      expect(carrier.traceparent).toBeDefined();
      await inSpan('database', SpanKind.CLIENT, {}, async () => {});
    });
    await expect(
      inSpan(
        'consumer',
        SpanKind.CONSUMER,
        {},
        async () => {
          throw new Error('secret SQL data');
        },
        remoteContext(carrier),
      ),
    ).rejects.toThrow();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(
      1,
    );
    const parent = spans.find((span) => span.name === 'request')!;
    expect(
      spans.find((span) => span.name === 'database')!.parentSpanContext?.spanId,
    ).toBe(parent.spanContext().spanId);
    expect(
      JSON.stringify(
        spans.map((span) => ({
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      ),
    ).not.toContain('secret');
    expect(spans.find((span) => span.name === 'consumer')!.status.code).toBe(2);
  } finally {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  }
});
