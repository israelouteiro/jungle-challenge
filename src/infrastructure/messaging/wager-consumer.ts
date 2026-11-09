import { trace, SpanStatusCode } from '@opentelemetry/api';
import { inSpan, remoteContext, SpanKind } from '../../observability/tracing';
import process from 'node:process';
import { Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { FailWager } from '../../application/use-cases/fail-wager';
import type { WagerInput } from '../../application/contracts';
import type { InboxContext } from '../../application/use-cases/process-wager';
import type { TransactionResult } from '../../application/ports/financial-unit-of-work';
import { ProcessWager } from '../../application/use-cases/process-wager';
import { ResourceNotFoundError } from '../../application/errors';
import { readWagerRequest } from './wager-request';
import { DomainInvariantError, DomainError } from '../../domain/domain-error';
import { Sqs } from './sqs';
import { Telemetry } from '../../observability/telemetry';

import type { MessagingPolicy } from './messaging-policy';
import { MESSAGING_POLICY } from './messaging-policy';
@Injectable()
export class WagerConsumer {
  private stopping = false;
  constructor(
    private readonly processor: ProcessWager,
    private readonly failureHandler: FailWager,
    private readonly sqs: Sqs,
    private readonly telemetry: Telemetry,
    private readonly policy: MessagingPolicy = MESSAGING_POLICY,
  ) {}
  stop(): void {
    this.stopping = true;
  }
  async consumeOnce(): Promise<void> {
    const response = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.sqs.incoming,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout:
          process.env.NODE_ENV === 'test'
            ? this.policy.testVisibilitySeconds
            : this.policy.visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['traceparent', 'tracestate'],
      }),
    );
    for (const message of response.Messages ?? []) {
      if (this.stopping) {
        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.incoming,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: 0,
          }),
        );
        return;
      }
      const carrier = Object.fromEntries(
        Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [
          key,
          value.StringValue ?? '',
        ]),
      );
      await inSpan(
        'wager.process',
        SpanKind.CONSUMER,
        { 'messaging.system': 'aws_sqs' },
        () => this.processMessage(message),
        remoteContext(carrier),
      );
    }
  }
  private async processMessage(message: Message): Promise<void> {
    const started = performance.now();
    const heartbeat = setInterval(() => {
      void this.sqs.client
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.incoming,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: this.policy.visibilitySeconds,
          }),
        )
        .catch(() =>
          this.telemetry.increment('visibility_extension_failures_total'),
        );
    }, this.policy.visibilityHeartbeatMilliseconds);
    let command:
      { input: WagerInput; key: string; inbox: InboxContext } | undefined;
    let committed: TransactionResult | undefined;
    let messageId = message.MessageId ?? 'unknown';
    let walletId: string | undefined;
    let providerId: string | undefined;
    try {
      command = readWagerRequest(message.Body ?? '');
      const { input, key } = command;
      messageId = command.inbox.messageId;
      walletId = input.walletId;
      providerId = input.providerId;
      const result = await this.processor.execute(input, key, command.inbox);
      committed = result;
      this.telemetry.increment(
        `wager_requests_total{transport="sqs",status="${result.status}"}`,
      );
      if (result.idempotentReplay) this.telemetry.increment('duplicates_total');
      if (result.status === 'FAILED')
        throw new DomainError('INFRASTRUCTURE_RETRY_EXHAUSTED');
      if (
        process.env.NODE_ENV === 'test' &&
        process.env.FAILPOINT === 'afterCommit'
      )
        process.kill(process.pid, 'SIGKILL');
      await this.sqs.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.sqs.incoming,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
      this.telemetry.log('message_processed', {
        messageId,
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        walletId,
        providerId,
      });
    } catch (error) {
      trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
      trace
        .getActiveSpan()
        ?.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Unknown',
        );
      const permanent =
        (error instanceof DomainError &&
          !(error instanceof DomainInvariantError)) ||
        error instanceof SyntaxError ||
        error instanceof ResourceNotFoundError;
      const toDlq =
        permanent ||
        Number(message.Attributes?.ApproximateReceiveCount ?? '1') >=
          this.policy.maxReceiveCount;
      const failurePhase = committed ? 'ACKNOWLEDGEMENT' : 'PROCESSING';
      if (toDlq) {
        if (!permanent && command && !committed) {
          committed = await this.failureHandler.execute(
            command.input,
            command.key,
            command.inbox,
          );
          this.telemetry.log(
            committed.status === 'FAILED'
              ? 'transaction_failed'
              : 'transaction_recovered',
            {
              correlationId: committed.transactionId,
              transactionId: committed.transactionId,
              messageId,
              walletId,
              providerId,
              failureCode: committed.failureCode,
            },
          );
        }
        // Send before deleting. A crash between these calls may duplicate the DLQ record, never lose it.
        await this.sqs.client.send(
          new SendMessageCommand({
            QueueUrl: this.sqs.dlq,
            MessageAttributes: {
              failureCode: {
                DataType: 'String',
                StringValue:
                  committed?.failureCode ??
                  (error instanceof DomainError
                    ? error.code
                    : permanent
                      ? 'INVALID_ENVELOPE'
                      : 'INFRASTRUCTURE_RETRY_EXHAUSTED'),
              },
              failurePhase: {
                DataType: 'String',
                StringValue: failurePhase,
              },
            },
            MessageBody: message.Body ?? '{}',
            MessageGroupId: walletId ?? 'invalid',
            MessageDeduplicationId: message.MessageId ?? messageId,
          }),
        );
        await this.sqs.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.sqs.incoming,
            ReceiptHandle: message.ReceiptHandle!,
          }),
        );
        this.telemetry.increment('dlq_messages_total');
      } else {
        const attempts = Number(
          message.Attributes?.ApproximateReceiveCount ?? '1',
        );
        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.incoming,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: Math.min(
              this.policy.maxRetrySeconds,
              2 ** attempts,
            ),
          }),
        );
        this.telemetry.increment('retries_total');
      }
      this.telemetry.log(
        toDlq ? 'message_dlq' : 'message_retry',
        {
          messageId,
          walletId,
          providerId,
          failureCode: error instanceof DomainError ? error.code : undefined,
        },
        'warn',
      );
    } finally {
      clearInterval(heartbeat);
      this.telemetry.observeMilliseconds(performance.now() - started);
    }
  }
}
