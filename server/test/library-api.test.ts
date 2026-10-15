import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { CHAPTER_WINDOW } from '../src/library/chapters.js';
import { StateStore } from '../src/state/store.js';
import { PNG, baseSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const spec = baseSpec();
  spec.characters[0]!.image = 'assets/face-a.png';
  spec.assets = { 'assets/face-a.png': PNG(31) };
  const h = makeHarness({ spec });
  await h.sync();
  const state = new StateStore(h.dataDir);
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state });
  opened.push(app);
  return { h, app, state };
}
const j = (r: { body: string }) => JSON.parse(r.body);
const pos = (msgIdx: number) => ({ msgIdx, blockIdx: 0, charOffset: 0, anchorHash: 'x' });

describe('chapter window', () => {
  it('matches the web client (both use the shared chapter split)', () => {
    const web = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'src', 'lib', 'chapters.ts'), 'utf8');
    expect(web).toContain("from '../../../server/src/shared/chapter-split'");
    expect(CHAPTER_WINDOW).toBe(40);
  });
});

describe('char image API', () => {
  it('serves the stored image with an ETag, 404 otherwise', async () => {
    const { app } = await setup();
    const r = await app.inject('/api/char-image/main/c1');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload).toEqual(PNG(31));
    const again = await app.inject({ url: '/api/char-image/main/c1', headers: { 'if-none-match': String(r.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect((await app.inject('/api/char-image/main/c2')).statusCode).toBe(404);
    expect((await app.inject('/api/char-image/zzz/c1')).statusCode).toBe(404);
  });

  it('lists carry imageUrl', async () => {
    const { app } = await setup();
    const chars = j(await app.inject('/api/chars?source=main')) as { charId: string; imageUrl: string | null }[];
    expect(chars.find((c) => c.charId === 'c1')!.imageUrl).toBe('/api/char-image/main/c1');
    expect(chars.find((c) => c.charId === 'c2')!.imageUrl).toBeNull();
  });
});

describe('shelves API', () => {
  it('returns characters with chat summaries, aliases and reading progress', async () => {
    const { app, state, h } = await setup();
    state.setAlias('main', 'chat', 'c1', 'a1', '첫 권', 1);
    state.putPosition('main', 'c1', 'a1', pos(1), h.clock.now());
    const shelves = j(await app.inject('/api/shelves?source=main')) as {
      charId: string; displayName: string; imageUrl: string | null; chatCount: number;
      chats: { chatId: string; displayName: string; msgCount: number | null; progress: number | null; readAt: number | null }[];
    }[];
    expect(shelves.map((s) => s.charId)).toEqual(['c1', 'c2']);
    const c1 = shelves[0]!;
    expect(c1).toMatchObject({ displayName: 'Alice', imageUrl: '/api/char-image/main/c1', chatCount: 2 });
    expect(c1.chats.find((c) => c.chatId === 'a1')).toMatchObject({ displayName: '첫 권', msgCount: 4, progress: 0.5, readAt: h.clock.now() });
    expect(c1.chats.find((c) => c.chatId === 'a2')).toMatchObject({ progress: null, readAt: null });
    expect((await app.inject('/api/shelves?source=zzz')).statusCode).toBe(404);
  });

  it('includes characters and chats deleted in the source, flagged, with keptAt; chatCount is what the home shelf shows', async () => {
    const { app, state, h } = await setup();
    h.rewrite((s) => { s.characters[0]!.chats = s.characters[0]!.chats.slice(0, 1); s.characters = [s.characters[0]!]; });
    h.clock.advance(60_000);
    await h.sync({ force: true, acceptMassDeletion: true });
    state.setKept('main', 'c1', 'a2', true, 77);
    const shelves = j(await app.inject('/api/shelves?source=main')) as {
      charId: string; deleted: boolean; chatCount: number; chats: { chatId: string; deleted: boolean; keptAt: number | null }[];
    }[];
    expect(shelves.map((s) => [s.charId, s.deleted, s.chatCount])).toEqual([['c1', false, 1], ['c2', true, 1]]);
    expect(shelves[0]!.chats.map((c) => [c.chatId, c.deleted, c.keptAt])).toEqual([['a1', false, null], ['a2', true, 77]]);
    expect(shelves[1]!.chats.map((c) => [c.chatId, c.deleted])).toEqual([['b1', true]]);
  });

  it('chats list carries progress and readAt too', async () => {
    const { app, state, h } = await setup();
    state.putPosition('main', 'c1', 'a1', pos(3), h.clock.now());
    const chats = j(await app.inject('/api/chats?source=main&char=c1')) as { chatId: string; progress: number | null; readAt: number | null }[];
    expect(chats.find((c) => c.chatId === 'a1')).toMatchObject({ progress: 1, readAt: h.clock.now() });
  });
});

describe('recent API', () => {
  it('lists recently read chats, newest first, including chats deleted in the source; skips unknown ones', async () => {
    const { app, state, h } = await setup();
    state.putPosition('main', 'c1', 'a1', pos(1), 100);
    state.putPosition('main', 'c2', 'b1', pos(0), 300);
    state.putPosition('main', 'c1', 'nope', pos(0), 400);
    state.putPosition('gone', 'c1', 'a1', pos(0), 500);
    state.putPosition('main', 'c1', 'a2', pos(1), 200);
    let items = j(await app.inject('/api/recent?limit=10')) as { chatId: string; charName: string; title: string; chapter: number; progress: number; imageUrl: string | null; updatedAt: number }[];
    expect(items.map((i) => i.chatId)).toEqual(['b1', 'a2', 'a1']);
    expect(items[1]).toMatchObject({ charName: 'Alice', title: 'chat-a2', chapter: 1, progress: 1, imageUrl: '/api/char-image/main/c1', updatedAt: 200 });
    expect(j(await app.inject('/api/recent')).length).toBe(3); // 기본 3
    h.rewrite((s) => { s.characters[1]!.chats = []; });
    h.clock.advance(60_000);
    await h.sync({ force: true, acceptMassDeletion: true });
    items = j(await app.inject('/api/recent?limit=10'));
    expect(items.map((i) => i.chatId)).toEqual(['b1', 'a2', 'a1']); // 지워진 채팅도 읽을 수 있으므로 남는다 (3D E5)
    expect(items.map((i) => (i as unknown as { deleted: boolean }).deleted)).toEqual([true, false, false]);
    expect((await app.inject('/api/recent?limit=99')).statusCode).toBe(400);
  });
});
