import { randomUUID } from 'node:crypto';
import { LoadClient } from '../client';
import { assert } from '../assert';
import { pool } from '../pool';

export async function warmup(client: LoadClient, concurrency: number) {
  const warm = await client.wallet();
  await pool(20, concurrency, async (index) => {
    const result = await client.call(
      '/wagering/transactions',
      client.wager(warm),
      randomUUID(),
      index,
    );
    assert(
      (result.data as { status: string }).status === 'PROCESSED',
      'Warmup failed',
    );
  });
  await client.check(warm, 20n, 20);
}
