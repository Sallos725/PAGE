import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const h = makeHarness();
  await h.sync();
  const state = new StateStore(h.dataDir);
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state });
  opened.push(app);
  return { h, app, state };
}
const j = (r: { body: string }) => JSON.parse(r.body);
const POS = { msgIdx: 2, blockIdx: 1, charOffset: 5, anchorHash: 'abc12345' };
const Q = 'source=main&char=c1&chat=a1';

describe('position API', () => {
  it('returns null when nothing is saved, then round-trips a saved position', async () => {
    const { app, h } = await setup();
    expect(j(await app.inject(`/api/state/position?${Q}`))).toEqual({ position: null, updatedAt: null });
    const put = await app.inject({ method: 'PUT', url: `/api/state/position?${Q}`, payload: POS });
    expect(put.statusCode).toBe(200);
    expect(j(put)).toEqual({ position: POS, updatedAt: h.clock.now() });
    expect(j(await app.inject(`/api/state/position?${Q}`))).toEqual({ position: POS, updatedAt: h.clock.now() });
  });

  it('is last-write-wins and shared (one position per chat, not per device)', async () => {
    const { app, h } = await setup();
    await app.inject({ method: 'PUT', url: `/api/state/position?${Q}`, payload: POS });
    h.clock.advance(1000);
    await app.inject({ method: 'PUT', url: `/api/state/position?${Q}`, payload: { ...POS, msgIdx: 3 } });
    expect(j(await app.inject(`/api/state/position?${Q}`)).position.msgIdx).toBe(3);
  });

  it('validates the body and the target', async () => {
    const { app } = await setup();
    const put = (payload: unknown, q = Q) => app.inject({ method: 'PUT', url: `/api/state/position?${q}`, payload: payload as object });
    expect((await put({ ...POS, msgIdx: -1 })).statusCode).toBe(400);
    expect((await put({ ...POS, msgIdx: 1.5 })).statusCode).toBe(400);
    expect((await put({ msgIdx: 1 })).statusCode).toBe(400);
    expect((await put({ ...POS, anchorHash: 'x'.repeat(65) })).statusCode).toBe(400);
    expect((await put(POS, 'source=ghost&char=c1&chat=a1')).statusCode).toBe(404);
    expect((await put(POS, 'source=main&char=c1&chat=nope')).statusCode).toBe(404); // 라이브러리에 없는 채팅
    expect((await app.inject('/api/state/position?source=main&char=c1')).statusCode).toBe(400);
  });
});

describe('settings API', () => {
  it('merges keys and returns everything', async () => {
    const { app } = await setup();
    expect(j(await app.inject('/api/state/settings'))).toEqual({ settings: {} });
    const r1 = await app.inject({ method: 'PUT', url: '/api/state/settings', payload: { theme: 'sepia', 'reader.fontSize': 19 } });
    expect(j(r1)).toEqual({ settings: { theme: 'sepia', 'reader.fontSize': 19 } });
    const r2 = await app.inject({ method: 'PUT', url: '/api/state/settings', payload: { theme: 'dark' } });
    expect(j(r2)).toEqual({ settings: { theme: 'dark', 'reader.fontSize': 19 } });
  });

  it('rejects bad keys, too many keys and oversized values', async () => {
    const { app } = await setup();
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/state/settings', payload: payload as object });
    expect((await put({ '9bad': 1 })).statusCode).toBe(400);
    expect((await put({ 'has space': 1 })).statusCode).toBe(400);
    expect((await put({ k: 'x'.repeat(5000) })).statusCode).toBe(400);
    expect((await put(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])))).statusCode).toBe(400);
  });
});
