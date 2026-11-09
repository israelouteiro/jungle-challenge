import { randomUUID } from 'node:crypto';
import { LoadClient } from '../client';
import { assert } from '../assert';
import { ScenarioRunner } from '../scenario';

export async function idempotentReplays(
  client: LoadClient,
  runner: ScenarioRunner,
) {
  const duplicate = await client.wallet();
  const input = client.wager(duplicate);
  const key = randomUUID();
  const ids = new Set<string>();
  let fresh = 0;
  await runner.run('idempotentReplays', async (index) => {
    const result = await client.call(
      '/wagering/transactions',
      input,
      key,
      index,
    );
    const data = result.data as {
      transactionId: string;
      idempotentReplay: boolean;
      status: string;
    };
    assert(data.status === 'PROCESSED', 'Unexpected result');
    ids.add(data.transactionId);
    if (!data.idempotentReplay) fresh++;
    return result.status;
  });
  assert(ids.size === 1 && fresh === 1, 'Idempotency invariant failed');
  await client.check(duplicate, 1n, 1);

  return { duplicate, input, key };
}
