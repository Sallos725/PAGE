import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/sync/scheduler.js';
import { makeHarness } from './helpers/harness.js';

describe('Scheduler', () => {
  it('tick syncs every source and survives an adapter failure', async () => {
    const h = makeHarness();
    const failing = { id: 'broken', kind: h.adapter.kind, health: async () => { throw new Error('boom'); }, fingerprint: async () => null, scan: async () => ({ complete: false, seen: new Map(), unreadable: 0 }) };
    const errors: string[] = [];
    const s = new Scheduler({ syncer: h.syncer, adapters: [failing as never, h.adapter], intervalMs: 1000, onError: (id) => errors.push(id) });
    await s.tick();
    expect(errors).toEqual(['broken']);
    expect(h.store.stats('main').chats).toBe(3);
  });

  it('start runs immediately and then on the interval; stop cancels', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const spy = vi.spyOn(h.syncer, 'syncSource');
      const s = new Scheduler({ syncer: h.syncer, adapters: [h.adapter], intervalMs: 1000, onError: () => {} });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).toHaveBeenCalledTimes(2);
      s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
