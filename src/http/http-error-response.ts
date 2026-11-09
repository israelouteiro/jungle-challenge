import { HttpException } from '@nestjs/common';
import { DomainError, DomainInvariantError } from '../domain/domain-error';
import { ResourceNotFoundError } from '../application/errors';
const transientSqlCodes = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '53300',
  '53400',
  '57P01',
  '57P02',
  '57P03',
]);
const networkCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
]);
export interface HttpErrorResponse {
  status: number;
  body: unknown;
}
export function httpErrorResponse(error: unknown): HttpErrorResponse {
  if (error instanceof DomainInvariantError) return internalError();
  if (error instanceof ResourceNotFoundError)
    return { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } };
  if (error instanceof DomainError) {
    if (
      ['INVALID_TRANSACTION_STATE', 'INVALID_LEDGER_ENTRY'].includes(error.code)
    )
      return internalError();
    return {
      status: error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400,
      body: { code: error.code },
    };
  }
  if (error instanceof HttpException)
    return { status: error.getStatus(), body: error.getResponse() };
  const code = errorCode(error);
  if (
    code === '23505' ||
    (error instanceof Error &&
      error.name === 'UniqueConstraintViolationException')
  ) {
    return { status: 409, body: { code: 'RESOURCE_CONFLICT' } };
  }
  const transient =
    code !== undefined &&
    (code.startsWith('08') ||
      transientSqlCodes.has(code) ||
      networkCodes.has(code));
  if (
    transient ||
    (error instanceof Error &&
      ['ConnectionException', 'TimeoutError'].includes(error.name))
  ) {
    return {
      status: 503,
      body: { code: 'INFRASTRUCTURE_UNAVAILABLE', retryable: true },
    };
  }
  return internalError();
}
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
function internalError(): HttpErrorResponse {
  return { status: 500, body: { code: 'INTERNAL_ERROR', retryable: false } };
}
