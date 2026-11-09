import { expect, test } from 'bun:test';
import { Telemetry } from '../../src/observability/telemetry';

test('latency histogram exposes a zero baseline and cumulative buckets for the first burst', () => {
  const telemetry = new Telemetry();
  const initial = telemetry.render();
  expect(initial).toContain(
    '# TYPE jungle_processing_duration_seconds histogram\n',
  );
  expect(initial).toContain('jungle_processing_duration_seconds_count 0\n');
  expect(initial).toContain('jungle_processing_duration_seconds_sum 0\n');
  expect(initial).toContain(
    'jungle_processing_duration_seconds_bucket{le="+Inf"} 0\n',
  );

  telemetry.observeMilliseconds(5);
  telemetry.observeMilliseconds(75);
  const measured = telemetry.render();
  expect(measured).toContain('jungle_processing_duration_seconds_count 2\n');
  expect(measured).toContain('jungle_processing_duration_seconds_sum 0.08\n');
  expect(measured).toContain(
    'jungle_processing_duration_seconds_bucket{le="0.01"} 1\n',
  );
  expect(measured).toContain(
    'jungle_processing_duration_seconds_bucket{le="0.1"} 2\n',
  );
  expect(measured).toContain(
    'jungle_processing_duration_seconds_bucket{le="+Inf"} 2\n',
  );
});
