import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore, keptKey } from '../src/state/store.js';
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
const put = (app: Awaited<ReturnType<typeof setup>>['app'], q: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/state/kept?${q}`, payload: payload as object });

describe('kept chats', () => {
  it('state: set, map per character and per source, unset', async () => {
    const { state } = await setup();
    state.setKept('main', 'c1', 'a1', true, 10);
    state.setKept('main', 'c2', 'b1', true, 20);
    expect(state.keptMap('main', 'c1')).toEqual(new Map([[keptKey('c1', 'a1'), 10]]));
    expect(state.keptMap('main').size).toBe(2);
    state.setKept('main', 'c1', 'a1', false, 30);
    expect(state.keptMap('main', 'c1').size).toBe(0);
  });

  it('API: toggles keep and the chats list carries keptAt', async () => {
    const { app, h } = await setup();
    const on = await put(app, 'source=main&char=c1&chat=a1', { kept: true });
    expect(on.statusCode).toBe(200);
    expect(j(on)).toEqual({ kept: true, keptAt: h.clock.now() });
    const chats = j(await app.inject('/api/chats?source=main&char=c1')) as { chatId: string; keptAt: number | null }[];
    expect(chats.find((c) => c.chatId === 'a1')!.keptAt).toBe(h.clock.now());
    expect(chats.find((c) => c.chatId === 'a2')!.keptAt).toBeNull();
    expect(j(await put(app, 'source=main&char=c1&chat=a1', { kept: false }))).toEqual({ kept: false, keptAt: null });
  });

  it('API: validates the target and body', async () => {
    const { app } = await setup();
    expect((await put(app, 'source=main&char=c1&chat=nope', { kept: true })).statusCode).toBe(404);
    expect((await put(app, 'source=zzz&char=c1&chat=a1', { kept: true })).statusCode).toBe(404);
    expect((await put(app, 'source=main&char=c1&chat=a1', { kept: 'yes' })).statusCode).toBe(400);
    expect((await put(app, 'source=main&char=c1&chat=a1', {})).statusCode).toBe(400);
  });

  it('API: keeping again does not reset the keep time', async () => {
    const { app, h, state } = await setup();
    const t0 = h.clock.now();
    expect(j(await put(app, 'source=main&char=c1&chat=a1', { kept: true })).keptAt).toBe(t0);
    h.clock.advance(60_000);
    const again = await put(app, 'source=main&char=c1&chat=a1', { kept: true });
    expect(again.statusCode).toBe(200);
    expect(j(again)).toEqual({ kept: true, keptAt: t0 });
    expect(state.keptMap('main', 'c1').get(keptKey('c1', 'a1'))).toBe(t0);
  });

  it('API: a chat deleted in the source can still be kept', async () => {
    const { app, h } = await setup();
    h.rewrite((s) => { s.characters[0]!.chats = s.characters[0]!.chats.slice(0, 1); });
    h.clock.advance(60_000);
    await h.sync({ force: true, acceptMassDeletion: true });
    const res = await put(app, 'source=main&char=c1&chat=a2', { kept: true });
    expect(res.statusCode).toBe(200);
    expect(j(res)).toEqual({ kept: true, keptAt: h.clock.now() });
  });
});
