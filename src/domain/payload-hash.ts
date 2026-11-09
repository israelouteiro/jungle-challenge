import { createHash } from 'node:crypto';
import { DomainError } from './domain-error';

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new DomainError('INVALID_TRANSACTION');
}

/** Call only with the normalized allowlist of business fields, never a transport envelope. */
export function payloadHash(
  businessFields: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(canonicalJson(businessFields))
    .digest('hex');
}
