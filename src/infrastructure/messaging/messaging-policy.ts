export const MESSAGING_POLICY = Object.freeze({
  outboxBatchSize: 10,
  referenceBatchSize: 20,
  visibilitySeconds: 60,
  testVisibilitySeconds: 2,
  visibilityHeartbeatMilliseconds: 20_000,
  maxReceiveCount: 5,
  maxRetrySeconds: 300,
  publisherIntervalMilliseconds: 200,
  referenceIntervalMilliseconds: 1_000,
  consumerIntervalMilliseconds: 100,
  auditIntervalMilliseconds: 30_000,
  auditVisibilitySeconds: 300,
});

export type MessagingPolicy = {
  readonly [Key in keyof typeof MESSAGING_POLICY]: number;
};
