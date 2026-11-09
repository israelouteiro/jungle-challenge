import { expect, test } from 'bun:test';
import {
  DomainError,
  DomainInvariantError,
} from '../../src/domain/domain-error';
import { ResourceNotFoundError } from '../../src/application/errors';
import { httpErrorResponse } from '../../src/http/http-error-response';
test('HTTP distinguishes internal faults, input, conflicts and transient infrastructure', () => {
  for (const error of [
    new DomainInvariantError('INVALID_LEDGER_ENTRY'),
    new DomainInvariantError('INVALID_TRANSACTION_STATE'),
    new DomainError('INVALID_TRANSACTION_STATE'),
    new TypeError('programming error'),
    null,
    Object.assign(new Error('constraint violated'), { code: '23514' }),
  ]) {
    expect(httpErrorResponse(error)).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', retryable: false },
    });
  }
  expect(httpErrorResponse(new DomainError('INVALID_MONEY')).status).toBe(400);
  expect(
    httpErrorResponse(new DomainError('IDEMPOTENCY_CONFLICT')).status,
  ).toBe(409);
  expect(httpErrorResponse(new ResourceNotFoundError('Wallet')).status).toBe(
    404,
  );
  expect(
    httpErrorResponse(Object.assign(new Error(), { code: '23505' })).status,
  ).toBe(409);
  for (const code of ['ECONNREFUSED', '08006', '55P03', '40001']) {
    expect(httpErrorResponse(Object.assign(new Error(), { code }))).toEqual({
      status: 503,
      body: { code: 'INFRASTRUCTURE_UNAVAILABLE', retryable: true },
    });
  }
});
