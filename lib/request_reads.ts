/** Share in-flight reads only within a single availability request, never across bookings. */
export type RequestReads = Map<string, Promise<unknown>>;
export function readOnce<T>(reads: RequestReads | undefined, key: unknown[], load: () => Promise<T>): Promise<T> {
  if (!reads) return load();
  const id = JSON.stringify(key);
  let pending = reads.get(id);
  if (!pending) {
    pending = Promise.resolve().then(load);
    reads.set(id, pending);
  }
  return pending as Promise<T>;
}
