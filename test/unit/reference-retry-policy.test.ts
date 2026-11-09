import { expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../src/application/reference-retry-policy';
import {
  DomainError,
  DomainInvariantError,
  isBusinessRejection,
} from '../../src/domain/domain-error';
test('only expected business failures may become a persisted rejection', () => {
  expect(isBusinessRejection(new DomainError('INSUFFICIENT_FUNDS'))).toBe(true);
  expect(
    isBusinessRejection(new DomainInvariantError('INVALID_TRANSACTION_STATE')),
  ).toBe(false);
  expect(
    isBusinessRejection(new DomainInvariantError('INVALID_LEDGER_ENTRY')),
  ).toBe(false);
  // Defensive check: a code alone must not turn a programming failure into business behavior.
  expect(
    isBusinessRejection(new DomainError('INVALID_TRANSACTION_STATE')),
  ).toBe(false);
  expect(isBusinessRejection(new DomainError('IDEMPOTENCY_CONFLICT'))).toBe(
    false,
  );
  expect(isBusinessRejection(new TypeError('unexpected'))).toBe(false);
});
test('reference retry policy uses explicit limits, persistent age and capped backoff', () => {
  const policy = new ReferenceRetryPolicy(10, 86_400_000, 3600);
  const createdAt = new Date('2026-01-01T00:00:00Z');
  expect(policy.exhausted(0, createdAt, createdAt)).toBe(false);
  expect(policy.exhausted(10, createdAt, createdAt)).toBe(true);
  expect(policy.exhausted(0, createdAt, new Date('2026-01-02T00:00:00Z'))).toBe(
    true,
  );
  expect(policy.nextAttempt(0, createdAt).getTime() - createdAt.getTime()).toBe(
    2000,
  );
  expect(policy.nextAttempt(1, createdAt).getTime() - createdAt.getTime()).toBe(
    4000,
  );
  expect(
    policy.nextAttempt(100, createdAt).getTime() - createdAt.getTime(),
  ).toBe(3_600_000);
});
