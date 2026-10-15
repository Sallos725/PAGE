import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { loggerOptions } from '../src/api/logging.js';
import { StateStore } from '../src/state/store.js';
import { AM, PNG, baseSpec, chat, type SynSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup(spec?: SynSpec, policyOverride = {}) {
  const s = spec ?? baseSpec();
  s.characters[0]!.chats[0]!.message[0]!.data = `hi {{raw::${AM(1)}}}`;
  s.manifests = [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png']] }];
  s.assets = { 'assets/p1.png': PNG(1) };
  const h = makeHarness({ spec: s, policy: policyOverride });
  await h.sync();
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state: new StateStore(h.dataDir), logger: loggerOptions('info', stream) });
  opened.push(app);
  return { h, app, logs };
}
const j = (r: { body: string }) => JSON.parse(r.body);

describe('read API', () => {
  it('GET /api/sources and /api/health', async () => {
    const { app } = await setup();
    expect(j(await app.inject('/api/sources'))).toEqual([expect.objectContaining({ id: 'main', kind: 'pocketrisu-sqlite', status: 'ok' })]);
    const health = j(await app.inject('/api/health'));
    expect(health).toEqual({ app: 'page', portable: false, sources: [{ id: 'main', kind: 'pocketrisu-sqlite', status: 'ok', reasons: [] }] });
  });

  it('GET /api/chars and /api/chats (includeDeleted)', async () => {
    const { app, h } = await setup();
    expect(j(await app.inject('/api/chars?source=main'))).toEqual([
      { charId: 'c1', name: 'Alice', deleted: false, chatCount: 2, originalName: 'Alice', displayName: 'Alice', imageUrl: null },
      { charId: 'c2', name: 'Bob', deleted: false, chatCount: 1, originalName: 'Bob', displayName: 'Bob', imageUrl: null },
    ]);
    const chats = j(await app.inject('/api/chats?source=main&char=c1'));
    expect(chats.map((c: { chatId: string; msgCount: number }) => [c.chatId, c.msgCount])).toEqual([['a1', 4], ['a2', 2]]);
    h.rewrite((s) => { s.characters[0]!.chats.pop(); });
    await h.sync();
    expect(j(await app.inject('/api/chats?source=main&char=c1')).map((c: { chatId: string }) => c.chatId)).toEqual(['a1']);
    expect(j(await app.inject('/api/chats?source=main&char=c1&includeDeleted=1')).map((c: { chatId: string; deleted: boolean }) => [c.chatId, c.deleted])).toEqual([['a1', false], ['a2', true]]);
  });

  it('GET messages: requested range only, normalized, with total and version', async () => {
    const { app } = await setup();
    const r = j(await app.inject('/api/chat/a1/messages?source=main&char=c1&from=1&limit=2'));
    expect(r).toMatchObject({ total: 4, from: 1 });
    expect(r.messages).toEqual([{ idx: 1, role: 'char', text: 'm1' }, { idx: 2, role: 'user', text: 'u2' }]);
    expect(typeof r.version).toBe('number');
    const first = j(await app.inject('/api/chat/a1/messages?source=main&char=c1'));
    expect(first.messages[0].text).toContain('{{raw::'); // 원문(마크업 포함) 그대로
  });

  it('messages: limit is capped, bad input rejected, unknown chat is 404', async () => {
    const { app } = await setup();
    const big = j(await app.inject('/api/chat/a1/messages?source=main&char=c1&limit=100000'));
    expect(big.messages).toHaveLength(4);
    expect((await app.inject('/api/chat/a1/messages?source=main&char=c1&limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/chat/a1/messages?source=main')).statusCode).toBe(400);
    expect((await app.inject('/api/chat/nope/messages?source=main&char=c1')).statusCode).toBe(404);
    expect((await app.inject('/api/chat/a1/messages?source=ghost&char=c1')).statusCode).toBe(404);
  });

  it('versions list and reading an older version', async () => {
    const { app, h } = await setup();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message[1]!.data = 'EDITED'; });
    await h.sync();
    const versions = j(await app.inject('/api/chat/a1/versions?source=main&char=c1'));
    expect(versions.map((v: { reason: string }) => v.reason)).toEqual(['initial', 'edited']);
    const old = j(await app.inject(`/api/chat/a1/messages?source=main&char=c1&version=${versions[0].versionId}`));
    expect(old.messages[1].text).toBe('m1');
    const head = j(await app.inject('/api/chat/a1/messages?source=main&char=c1'));
    expect(head.messages[1].text).toBe('EDITED');
    expect((await app.inject('/api/chat/a2/messages?source=main&char=c1&version=' + versions[0].versionId)).statusCode).toBe(404); // 다른 채팅의 버전
  });

  it('GET /api/asset serves bytes with mime, ETag and 304', async () => {
    const { app } = await setup();
    const url = `/api/asset/main/c1/${encodeURIComponent(AM(1))}`;
    const r = await app.inject(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload).toEqual(PNG(1));
    const etag = r.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await app.inject({ url, headers: { 'if-none-match': etag } })).statusCode).toBe(304);
    expect((await app.inject(`/api/asset/main/c1/${encodeURIComponent('unknown')}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/asset/main/c2/${encodeURIComponent(AM(1))}`)).statusCode).toBe(404); // 다른 캐릭터
  });

  it('library status reports counts, sizes, free space and warnings', async () => {
    const { app, h } = await setup();
    const s = j(await app.inject('/api/library/status'));
    expect(s.sources[0]).toMatchObject({ id: 'main', chars: 2, chats: 3, versions: 3, lastReport: { outcome: 'synced' }, warnings: [] });
    expect(s.library).toMatchObject({ assetCount: 1, assetBytes: 8 });
    expect(s.freeSpace).toMatchObject({ freeBytes: 1e12, totalBytes: 2e12 });
    h.free.freeBytes = 1e9;
    const low = j(await app.inject('/api/library/status'));
    expect(low.warnings).toEqual(expect.arrayContaining(['low-free-space', 'new-assets-paused']));
  });
});

describe('sync API', () => {
  it('POST /api/library/sync syncs a source or a single chat; validates input', async () => {
    const { app, h } = await setup();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.push({ role: 'user', data: 'u3' }); });
    const one = j(await app.inject({ method: 'POST', url: '/api/library/sync?source=main&char=c1&chat=a1' }));
    expect(one.chats.appended).toBe(1); // 채팅 열 때 동기화는 디바운스를 무시한다
    h.rewrite((s) => { s.characters[1]!.chats.push(chat('b2', ['q'])); });
    const all = j(await app.inject({ method: 'POST', url: '/api/library/sync?source=main' }));
    expect(all.outcome).toBe('synced');
    expect((await app.inject({ method: 'POST', url: '/api/library/sync?source=main&char=c1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/library/sync?source=ghost' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/library/sync' })).statusCode).toBe(400);
  });

  it('reports a held mass deletion and accepts it explicitly', async () => {
    const { app, h } = await setup();
    h.rewrite((s) => { s.characters.shift(); });
    const held = j(await app.inject({ method: 'POST', url: '/api/library/sync?source=main' }));
    expect(held.held).toEqual({ items: 5, missing: 3 });
    const status = j(await app.inject('/api/library/status'));
    expect(status.sources[0].warnings).toContain('mass-deletion-held');
    const ok = j(await app.inject({ method: 'POST', url: '/api/library/sync?source=main&acceptMassDeletion=1' }));
    expect(ok.held).toBeUndefined();
  });
});

describe('no content in logs', () => {
  it('request logs carry the route pattern, never ids/queries/bodies', async () => {
    const { app, logs } = await setup();
    await app.inject('/api/chat/SECRETCHAT/messages?source=main&char=SECRETCHAR');
    await app.inject({ method: 'POST', url: '/api/library/sync?source=main&char=SECRETCHAR&chat=SECRETCHAT' });
    await app.inject(`/api/asset/main/c1/${encodeURIComponent('SECRETASSET')}`);
    const all = logs.join('\n');
    expect(all).toContain('/api/chat/:id/messages');
    expect(all).not.toMatch(/SECRET/);
  });
});
