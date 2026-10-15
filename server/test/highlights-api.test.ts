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
const P = (m: number, b = 0, o = 0) => ({ msgIdx: m, blockIdx: b, charOffset: o, anchorHash: 'h' });

describe('library-wide highlights', () => {
  it('lists highlights from every chat newest first with display names; bookmarks are not included', async () => {
    const { app, state } = await setup();
    state.addBookmark('main', 'c1', 'a1', { kind: 'highlight', start: P(0), end: P(0, 0, 3), note: '', color: 'green', text: '첫 문장' }, 10);
    state.addBookmark('main', 'c1', 'a2', { kind: 'highlight', start: P(1), end: P(1, 0, 3), note: '', color: 'yellow', text: '' }, 20);
    state.addBookmark('main', 'c1', 'a1', { kind: 'bookmark', start: P(2), end: null, note: '', color: '', text: '책갈피' }, 30);
    state.setAlias('main', 'chat', 'c1', 'a2', '별칭 채팅', 40);
    const r = j(await app.inject('/api/state/highlights'));
    expect(r.hasMore).toBe(false);
    expect(r.highlights.map((h: { chatId: string }) => h.chatId)).toEqual(['a2', 'a1']);
    expect(r.highlights[0]).toMatchObject({ source: 'main', charId: 'c1', chatId: 'a2', chatTitle: '별칭 채팅', deleted: false, color: 'yellow', text: '', createdAt: 20 });
    expect(r.highlights[1]).toMatchObject({ chatId: 'a1', text: '첫 문장', start: P(0), end: P(0, 0, 3) });
    expect(typeof r.highlights[1].charName).toBe('string');
  });

  it('prefers the character alias over the original name', async () => {
    const { h, app, state } = await setup();
    state.addBookmark('main', 'c1', 'a1', { kind: 'highlight', start: P(0), end: P(0, 0, 3), note: '', color: 'yellow', text: '' }, 10);
    expect(j(await app.inject('/api/state/highlights')).highlights[0].charName).toBe(h.store.getCharName('main', 'c1'));
    state.setAlias('main', 'char', 'c1', '', '별칭 캐릭터', 20);
    expect(j(await app.inject('/api/state/highlights')).highlights[0].charName).toBe('별칭 캐릭터');
  });

  it('marks highlights of tombstoned or unknown chats as deleted', async () => {
    const { h, app, state } = await setup();
    state.addBookmark('main', 'c1', 'a1', { kind: 'highlight', start: P(0), end: P(0, 0, 3), note: '', color: 'yellow', text: '' }, 10);
    state.addBookmark('main', 'c1', 'a2', { kind: 'highlight', start: P(0), end: P(0, 0, 3), note: '', color: 'yellow', text: '' }, 20);
    state.addBookmark('main', 'c1', 'nope', { kind: 'highlight', start: P(0), end: P(0, 0, 3), note: '', color: 'yellow', text: '' }, 30);
    h.store.tombstoneChats('main', [{ charId: 'c1', chatId: 'a2' }], 40);
    const byChat = Object.fromEntries(j(await app.inject('/api/state/highlights')).highlights.map((x: { chatId: string; deleted: boolean }) => [x.chatId, x.deleted]));
    expect(byChat).toEqual({ a1: false, a2: true, nope: true });
  });

  it('limit and hasMore; rejects bad limits', async () => {
    const { app, state } = await setup();
    for (let i = 0; i < 3; i++) state.addBookmark('main', 'c1', 'a1', { kind: 'highlight', start: P(i), end: P(i, 0, 2), note: '', color: 'yellow', text: '' }, i);
    const r = j(await app.inject('/api/state/highlights?limit=2'));
    expect(r.highlights).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect((await app.inject('/api/state/highlights?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/state/highlights?limit=5001')).statusCode).toBe(400);
  });

  it('skips highlights of unknown sources', async () => {
    const { app, state } = await setup();
    state.addBookmark('gone', 'c1', 'a1', { kind: 'highlight', start: P(0), end: P(0, 0, 2), note: '', color: 'yellow', text: '' }, 1);
    expect(j(await app.inject('/api/state/highlights')).highlights).toEqual([]);
  });
});
