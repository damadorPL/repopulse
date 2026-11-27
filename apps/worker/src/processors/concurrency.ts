/**
 * Runs `fn` over `items` with at most `concurrency` promises in flight, preserving input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
