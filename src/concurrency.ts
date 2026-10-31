/** Process an arbitrary list while limiting simultaneous external operations. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  action: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Concurrency must be a positive integer.");
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failure) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await action(items[index], index);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  // Finish already-started work before propagating failure. Callers can then
  // retry without leaving unobserved work running against the same task.
  if (failure) throw failure.error;
  return results;
}
