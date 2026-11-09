import process from 'node:process';
import { Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
export interface SqsConfiguration {
  endpoint: string;
  incoming: string;
  events: string;
  dlq: string;
}
export function sqsConfiguration(): SqsConfiguration {
  return {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    incoming:
      process.env.SQS_QUEUE_URL ??
      'http://localhost:4566/000000000000/wager-transactions.fifo',
    events:
      process.env.SQS_EVENTS_URL ??
      'http://localhost:4566/000000000000/wagering-events.fifo',
    dlq:
      process.env.SQS_DLQ_URL ??
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  };
}
@Injectable()
export class Sqs {
  readonly client: SQSClient;
  readonly incoming: string;
  readonly events: string;
  readonly dlq: string;
  constructor(configuration: SqsConfiguration = sqsConfiguration()) {
    this.incoming = configuration.incoming;
    this.events = configuration.events;
    this.dlq = configuration.dlq;
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: configuration.endpoint,
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? undefined
        : { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    });
  }
  async ready(): Promise<void> {
    await Promise.all(
      [this.incoming, this.events, this.dlq].map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    );
  }
}
