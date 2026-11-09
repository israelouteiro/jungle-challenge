import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { DlqAuditor } from './dlq-auditor';
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OutboxPublisher } from './outbox-publisher';
import { WagerConsumer } from './wager-consumer';
import { PendingReferenceWorker } from './pending-reference-worker';
import { Sqs } from './sqs';
import { Telemetry } from '../../observability/telemetry';
import { MESSAGING_POLICY } from './messaging-policy';
/** Owns lifecycle only. Each job owns its independent processing responsibility. */
@Injectable()
export class Workers implements OnApplicationBootstrap, OnModuleDestroy {
  private stopping = false;
  private readonly shutdown = new AbortController();
  private tasks: Promise<void>[] = [];
  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly consumer: WagerConsumer,
    private readonly references: PendingReferenceWorker,
    private readonly auditor: DlqAuditor,
    private readonly sqs: Sqs,
    private readonly telemetry: Telemetry,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.tasks = [
      this.loop(
        () => this.auditor.auditOnce(),
        MESSAGING_POLICY.auditIntervalMilliseconds,
      ),
      this.loop(
        () => this.publisher.publishOnce(),
        MESSAGING_POLICY.publisherIntervalMilliseconds,
        (count) => count === MESSAGING_POLICY.outboxBatchSize,
      ),
      this.loop(
        () => this.references.referencesOnce(),
        MESSAGING_POLICY.referenceIntervalMilliseconds,
      ),
      this.loop(
        () => this.consumer.consumeOnce(),
        MESSAGING_POLICY.consumerIntervalMilliseconds,
      ),
    ];
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    this.auditor.stop();
    this.consumer.stop();
    this.references.stop();
    await Promise.allSettled(this.tasks);
    this.sqs.client.destroy();
  }
  private async loop(
    work: () => Promise<unknown>,
    interval: number,
    continueImmediately: (result: unknown) => boolean = () => false,
  ): Promise<void> {
    while (!this.stopping) {
      try {
        // Full batches indicate backlog. Keep draining; idle/error paths still back off.
        if (continueImmediately(await work())) continue;
      } catch (error) {
        this.telemetry.increment('worker_errors_total');
        this.telemetry.log(
          'worker_error',
          { errorType: error instanceof Error ? error.name : 'Unknown' },
          'error',
        );
      }
      if (!this.stopping) {
        try {
          await delay(interval, undefined, { signal: this.shutdown.signal });
        } catch (error) {
          if (!this.shutdown.signal.aborted) throw error;
        }
      }
    }
  }
}
