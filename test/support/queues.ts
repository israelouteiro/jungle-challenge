import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { Sqs, sqsConfiguration } from '../../src/infrastructure/messaging/sqs';
/** Real isolated LocalStack queues, so retry/chaos tests cannot consume another scenario's messages. */
export async function isolatedQueues() {
  const endpoint = new URL(sqsConfiguration().endpoint);
  const admin = new Sqs();
  const urls: string[] = [];
  try {
    for (const kind of ['incoming', 'events', 'dlq']) {
      const result = await admin.client.send(
        new CreateQueueCommand({
          QueueName: `test-${kind}-${randomUUID()}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'true',
            VisibilityTimeout: '2',
          },
        }),
      );
      // LocalStack can advertise a host-local QueueUrl. Route through the endpoint
      // reachable by this caller (host or Docker network), preserving the queue path.
      const queueUrl = new URL(result.QueueUrl!);
      queueUrl.protocol = endpoint.protocol;
      queueUrl.host = endpoint.host;
      urls.push(queueUrl.toString());
    }
    const [incoming, events, dlq] = urls as [string, string, string];
    const attributes = await admin.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq,
        AttributeNames: ['QueueArn'],
      }),
    );
    await admin.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: incoming,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attributes.Attributes!.QueueArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    const configuration = { ...sqsConfiguration(), incoming, events, dlq };
    const sqs = new Sqs(configuration);
    return {
      sqs,
      configuration,
      async close() {
        sqs.client.destroy();
        try {
          await Promise.all(
            urls.map((QueueUrl) =>
              admin.client.send(new DeleteQueueCommand({ QueueUrl })),
            ),
          );
        } finally {
          admin.client.destroy();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled(
      urls.map((QueueUrl) =>
        admin.client.send(new DeleteQueueCommand({ QueueUrl })),
      ),
    );
    admin.client.destroy();
    throw error;
  }
}
