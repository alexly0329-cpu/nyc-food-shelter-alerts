import { describe, expect, it, vi } from 'vitest';
import { createQueue, type BossLike } from '../src/queue.js';

function fakeBoss() {
  const boss = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    createQueue: vi.fn(async () => {}),
    send: vi.fn(async () => 'job-1'),
    work: vi.fn(async () => 'w'),
    on: vi.fn(),
  };
  return boss satisfies BossLike;
}
const deps = { pool: {} as never, sender: {} as never };

describe('createQueue', () => {
  it('enqueue sends a delayed, retryable job', async () => {
    const boss = fakeBoss();
    const q = createQueue(deps, boss);
    const runAt = new Date('2026-06-01T12:00:00Z');
    await q.enqueue('alert-1', runAt);
    expect(boss.send).toHaveBeenCalledTimes(1);
    const [name, data, opts] = boss.send.mock.calls[0] as unknown as [string, unknown, { startAfter: Date; retryLimit: number; retryDelay: number; retryBackoff: boolean }];
    expect(name).toBe('send-alert');
    expect(data).toEqual({ alertId: 'alert-1' });
    expect(opts.startAfter).toEqual(runAt);
    expect(opts.retryLimit).toBeGreaterThan(0);
    expect(opts.retryDelay).toBeGreaterThan(0);
    expect(opts.retryBackoff).toBe(true);
  });

  it('start creates the queue and registers a single-concurrency worker; stop stops boss', async () => {
    const boss = fakeBoss();
    const q = createQueue(deps, boss);
    await q.start();
    expect(boss.start).toHaveBeenCalled();
    expect(boss.createQueue).toHaveBeenCalledWith('send-alert');
    expect(boss.work).toHaveBeenCalledWith('send-alert', expect.objectContaining({ localConcurrency: 1 }), expect.any(Function));
    await q.stop();
    expect(boss.stop).toHaveBeenCalled();
  });
});
