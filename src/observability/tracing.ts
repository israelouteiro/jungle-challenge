import process from 'node:process';
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import type { Attributes, Context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import {
  TracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export function startTracing(exporter?: SpanExporter) {
  if (!exporter && process.env.OTEL_ENABLED !== 'true') return undefined;
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new Error('Invalid OTEL_TRACES_SAMPLER_ARG');
  const provider = new TracerProvider({
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(ratio),
    }),
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'jungle-wagering',
      'service.instance.id': process.env.INSTANCE_ID ?? String(process.pid),
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exportTimeoutMillis: 4000,
        exporter: exporter ?? new OTLPTraceExporter({ timeoutMillis: 3000 }),
      }),
    ],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return provider;
}
export async function inSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: () => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return trace
    .getTracer('jungle-wagering')
    .startActiveSpan(name, { kind, attributes }, parent, async (span) => {
      try {
        return await work();
      } catch (error) {
        // Error messages may contain SQL parameters or financial data.
        span.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Unknown',
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}
export function remoteContext(carrier: Record<string, string>) {
  return propagation.extract(ROOT_CONTEXT, carrier);
}
export { SpanKind };
