export async function pool<T>(
  count: number,
  concurrency: number,
  work: (index: number, lane: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = Array(count);
  let cursor = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(count, concurrency) }, async (_, lane) => {
      while (cursor < count) {
        const index = cursor++;
        results[index] = await work(index, lane);
      }
    }),
  );
  const failed = outcomes.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}
