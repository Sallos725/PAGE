import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const h = makeHarness();
  await h.sync();
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state: new StateStore(h.dataDir) });
  opened.push(app);
  return { h, app };
}
const j = (r: { body: string }) => JSON.parse(r.body);
const Q = 'source=main&char=c1&chat=a1';
const P = (m: number, b = 0, o = 0) => ({ msgIdx: m, blockIdx: b, charOffset: o, anchorHash: 'h' });

describe('bookmarks API', () => {
  it('lists, adds a bookmark and a highlight, keeps insertion order', async () => {
    const { app } = await setup();
    expect(j(await app.inject(`/api/state/bookmarks?${Q}`))).toEqual({ bookmarks: [] });
    const r1 = await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'bookmark', start: P(3) } });
    expect(r1.statusCode).toBe(201);
    expect(j(r1).bookmark).toMatchObject({ kind: 'bookmark', start: P(3), end: null, note: '', color: '' });
    const r2 = await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'highlight', start: P(1, 0, 2), end: P(1, 1, 4), note: 'memo' } });
    expect(j(r2).bookmark).toMatchObject({ kind: 'highlight', color: 'yellow', note: 'memo' });
    const list = j(await app.inject(`/api/state/bookmarks?${Q}`)).bookmarks;
    expect(list.map((b: { kind: string }) => b.kind)).toEqual(['bookmark', 'highlight']);
  });

  it('stores a text snippet, returns it, and patches it within the chat scope', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'highlight', start: P(1), end: P(1, 0, 5), text: '합성 문장' } });
    expect(j(r).bookmark).toMatchObject({ text: '합성 문장' });
    const id = j(r).bookmark.id as string;
    const b = await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'bookmark', start: P(2) } });
    expect(j(b).bookmark.text).toBe('');
    const p = await app.inject({ method: 'PATCH', url: `/api/state/bookmarks/${id}?${Q}`, payload: { text: '고친 문장' } });
    expect(p.statusCode).toBe(200);
    expect(j(p)).toEqual({ id, text: '고친 문장' });
    expect(j(await app.inject(`/api/state/bookmarks?${Q}`)).bookmarks[0].text).toBe('고친 문장');
    expect((await app.inject({ method: 'PATCH', url: `/api/state/bookmarks/${id}?source=main&char=c1&chat=a2`, payload: { text: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/state/bookmarks/${id}?${Q}`, payload: { text: 'x'.repeat(2001) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/state/bookmarks/${id}?${Q}`, payload: { text: 'x', extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'bookmark', start: P(2), text: 'x'.repeat(2001) } })).statusCode).toBe(400);
  });

  it('validates kind, ends, note and colour', async () => {
    const { app } = await setup();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: payload as object });
    expect((await post({ kind: 'highlight', start: P(1) })).statusCode).toBe(400); // 끝 없음
    expect((await post({ kind: 'highlight', start: P(1, 0, 5), end: P(1, 0, 5) })).statusCode).toBe(400); // 빈 범위
    expect((await post({ kind: 'highlight', start: P(2), end: P(1) })).statusCode).toBe(400); // 거꾸로
    expect((await post({ kind: 'bookmark', start: P(1), end: P(2) })).statusCode).toBe(400);
    expect((await post({ kind: 'pin', start: P(1) })).statusCode).toBe(400);
    expect((await post({ kind: 'bookmark', start: { ...P(1), msgIdx: -1 } })).statusCode).toBe(400);
    expect((await post({ kind: 'highlight', start: P(1), end: P(2), color: 'red' })).statusCode).toBe(400);
    expect((await post({ kind: 'bookmark', start: P(1), note: 'x'.repeat(2001) })).statusCode).toBe(400);
  });

  it('rejects unknown sources and chats', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/state/bookmarks?source=ghost&char=c1&chat=a1', payload: { kind: 'bookmark', start: P(1) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/state/bookmarks?source=main&char=c1&chat=nope', payload: { kind: 'bookmark', start: P(1) } })).statusCode).toBe(404);
    expect((await app.inject('/api/state/bookmarks?source=ghost&char=c1&chat=a1')).statusCode).toBe(404);
  });

  it('deletes within the chat scope only', async () => {
    const { app } = await setup();
    const id = j(await app.inject({ method: 'POST', url: `/api/state/bookmarks?${Q}`, payload: { kind: 'bookmark', start: P(3) } })).bookmark.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/state/bookmarks/${id}?source=main&char=c1&chat=a2` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/state/bookmarks/${id}?${Q}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/state/bookmarks/${id}?${Q}` })).statusCode).toBe(404);
  });
});
