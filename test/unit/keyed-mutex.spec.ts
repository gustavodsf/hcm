import { KeyedMutex } from '../../src/common/keyed-mutex';

describe('KeyedMutex (TRD §6.2, C2)', () => {
  it('serializes runs on the same key (no interleaving)', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (name: string) =>
      mutex.runExclusive('k', async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`${name}:end`);
      });

    await Promise.all([task('a'), task('b'), task('c')]);
    // Each task's start/end must be adjacent — proving exclusivity.
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.runExclusive('x', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('x');
      }),
      mutex.runExclusive('y', async () => {
        order.push('y'); // shorter, should finish first despite starting second
      }),
    ]);
    expect(order).toEqual(['y', 'x']);
  });

  it('releases the lock even if the body throws', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock should be free for the next caller.
    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });
});
