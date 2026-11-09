import { randomUUID } from 'node:crypto';
import { LoadClient } from '../client';
import { assert } from '../assert';
import { ScenarioRunner } from '../scenario';

export async function hotWallet(
  client: LoadClient,
  runner: ScenarioRunner,
  requests: number,
) {
  const hot = await client.wallet();
  await runner.run('hotWallet', async (index) => {
    const result = await client.call(
      '/wagering/transactions',
      client.wager(hot),
      randomUUID(),
      index,
    );
    assert(
      (result.data as { status: string }).status === 'PROCESSED',
      'Unexpected result',
    );
    return result.status;
  });
  await client.check(hot, BigInt(requests), requests);
}
