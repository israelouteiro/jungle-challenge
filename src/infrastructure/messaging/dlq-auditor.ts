import { Injectable } from '@nestjs/common';
import {
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { FailWager } from '../../application/use-cases/fail-wager';
import { DomainError, DomainInvariantError } from '../../domain/domain-error';
import { ResourceNotFoundError } from '../../application/errors';
import { Sqs } from './sqs';
import { readWagerRequest } from './wager-request';
import { MESSAGING_POLICY } from './messaging-policy';
import { Telemetry } from '../../observability/telemetry';
/** Recover native-redrive cases after PostgreSQL returns. DLQ records are NEVER deleted. */
@Injectable()
export class DlqAuditor {
  private stopping = false;
  constructor(
    private readonly failures: FailWager,
    private readonly sqs: Sqs,
    private readonly telemetry: Telemetry,
  ) {}
  stop(): void {
    this.stopping = true;
  }
  async auditOnce(): Promise<void> {
    const batch = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.sqs.dlq,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
      }),
    );
    for (const message of batch.Messages ?? []) {
      if (this.stopping) {
        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.dlq,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: 0,
          }),
        );
        continue;
      }
      try {
        const request = readWagerRequest(message.Body ?? '');
        const result = await this.failures.execute(request.input, request.key, {
          ...request.inbox,
          consumerName: 'dlq-audit-v1',
        });
        this.telemetry.increment('dlq_audits_total');
        this.telemetry.log('dlq_audited', {
          messageId: request.messageId,
          correlationId: result.transactionId,
          transactionId: result.transactionId,
          walletId: request.input.walletId,
          providerId: request.input.providerId,
          status: result.status,
        });
      } catch (error) {
        const invalid =
          (error instanceof DomainError &&
            !(error instanceof DomainInvariantError)) ||
          error instanceof SyntaxError ||
          error instanceof ResourceNotFoundError;
        if (!invalid) throw error;
        this.telemetry.log(
          'dlq_audit_invalid',
          { messageId: message.MessageId },
          'warn',
        );
      }
      // Keep the message for operators. Suppress repeated audits for a bounded interval.
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqs.dlq,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: MESSAGING_POLICY.auditVisibilitySeconds,
        }),
      );
    }
  }
}
