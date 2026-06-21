/**
 * A tiny per-key async mutex. Serializes the reserve critical section per
 * (employeeId, locationId) so a check-then-reserve cannot interleave with
 * another for the same key (TRD §6.2, C2). This guarantees no-double-spend at
 * the application layer regardless of the SQLite driver's transaction
 * concurrency semantics; on Postgres this would be a row lock (TRD §12).
 */
export class KeyedMutex {
  /** key -> promise that resolves when the current holder releases. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `fn` while holding the lock for `key`. FIFO per key. */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, mine);

    await previous; // wait for the prior holder to release
    try {
      return await fn();
    } finally {
      release();
      // If we are still the tail (nobody queued behind us), drop the entry.
      if (this.tails.get(key) === mine) {
        this.tails.delete(key);
      }
    }
  }
}
