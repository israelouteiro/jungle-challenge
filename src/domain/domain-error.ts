export type FailureCode =
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'INVALID_TRANSACTION'
  | 'INVALID_TRANSACTION_STATE'
  | 'INVALID_REFERENCE'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_LEDGER_ENTRY'
  | 'INFRASTRUCTURE_RETRY_EXHAUSTED';

export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Internal invariant failures must abort the transaction, never become a rejection. */
export class DomainInvariantError extends DomainError {
  constructor(code: 'INVALID_TRANSACTION_STATE' | 'INVALID_LEDGER_ENTRY') {
    super(code);
    this.name = 'DomainInvariantError';
  }
}
const rejectionCodes: ReadonlySet<FailureCode> = new Set([
  'INVALID_MONEY',
  'CURRENCY_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'INVALID_TRANSACTION',
  'INVALID_REFERENCE',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_ALREADY_REVERSED',
]);
export function isBusinessRejection(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    !(error instanceof DomainInvariantError) &&
    rejectionCodes.has(error.code)
  );
}
