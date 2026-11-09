import { Injectable } from '@nestjs/common';
import { ProcessWager } from '../../application/use-cases/process-wager';
import { PendingReferenceReader } from '../../application/ports/pending-reference-reader';
import { Telemetry } from '../../observability/telemetry';
import { MESSAGING_POLICY } from './messaging-policy';
@Injectable()
export class PendingReferenceWorker {
  private stopping = false;
  constructor(
    private readonly reader: PendingReferenceReader,
    private readonly processor: ProcessWager,
    private readonly telemetry: Telemetry,
  ) {}
  stop(): void {
    this.stopping = true;
  }
  async referencesOnce(): Promise<void> {
    for (const id of await this.reader.dueIds(
      MESSAGING_POLICY.referenceBatchSize,
    )) {
      if (this.stopping) return;
      if (await this.processor.retryPending(id))
        this.telemetry.increment('reference_retries_total');
    }
  }
}
