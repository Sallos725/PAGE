import { describe, expect, it } from 'vitest';
import { trialRun, type TrialWorker } from '../src/lib/hide-trial';

function fakeWorker(reply: ((data: { pattern: string; flags: string; texts: string[] }) => unknown) | null) {
  const w: TrialWorker & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    postMessage(data) {
      if (reply) setTimeout(() => w.onmessage?.({ data: reply(data as { pattern: string; flags: string; texts: string[] }) } as MessageEvent), 0);
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

describe('trialRun', () => {
  it('returns the count from the worker and terminates it', async () => {
    const w = fakeWorker(() => ({ ok: true, count: 4 }));
    expect(await trialRun('x', '', ['x'], 300, () => w)).toEqual({ ok: true, count: 4 });
    expect(w.terminated).toBe(true);
  });
  it('reports slow when the worker does not answer in time, and kills it', async () => {
    const w = fakeWorker(null);
    expect(await trialRun('x', '', ['x'], 20, () => w)).toEqual({ ok: false, error: 'slow' });
    expect(w.terminated).toBe(true);
  });
  it('reports compile when the worker fails', async () => {
    expect(await trialRun('x', '', ['x'], 300, () => fakeWorker(() => ({ ok: false })))).toEqual({ ok: false, error: 'compile' });
  });
});
