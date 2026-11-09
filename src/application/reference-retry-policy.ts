export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts = 10,
    readonly ttlMilliseconds = 24 * 60 * 60 * 1000,
    readonly maxDelaySeconds = 60 * 60,
  ) {}
  exhausted(attempts: number, createdAt: Date, now: Date): boolean {
    return (
      attempts >= this.maxAttempts ||
      now.getTime() - createdAt.getTime() >= this.ttlMilliseconds
    );
  }
  nextAttempt(attempts: number, now: Date): Date {
    const delaySeconds = Math.min(
      this.maxDelaySeconds,
      2 ** Math.min(attempts + 1, 30),
    );
    return new Date(now.getTime() + delaySeconds * 1000);
  }
}
