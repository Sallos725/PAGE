import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLD_HEADER, chat } from './helpers/synthetic-source.js';
import { MIN, makeHarness } from './helpers/harness.js';

const textsOf = (h: ReturnType<typeof makeHarness>, charId: string, chatId: string, version?: number) => {
  const row = h.store.getChat('main', charId, chatId)!;
  const v = h.store.getVersion(version ?? row.headVersion!)!;
  return h.store.getMsgJson(h.store.getManifest(v.manifestHash)!).map((j) => (JSON.parse(j) as { data: string }).data);
};

describe('Syncer — initial sync', () => {
  it('copies chars, chats and messages into the library as initial versions', async () => {
    const h = makeHarness();
    const r = await h.sync();
    expect(r).toMatchObject({ source: 'main', outcome: 'synced', chats: { created: 3, unreadable: 0 }, chars: { seen: 2 }, errors: 0 });
    expect(h.store.listChars('main', false).map((c) => [c.charId, c.chatCount])).toEqual([['c1', 2], ['c2', 1]]);
    expect(textsOf(h, 'c1', 'a1')).toEqual(['u1', 'm1', 'u2', 'm2']);
    expect(h.store.listVersions('main', 'c1', 'a1').map((v) => v.reason)).toEqual(['initial']);
    expect(h.store.stats('main')).toMatchObject({ chars: 2, chats: 3, versions: 3 });
  });

  it('a second sync with an unchanged source is skipped by fingerprint', async () => {
    const h = makeHarness();
    await h.sync();
    const r = await h.sync();
    expect(r.outcome).toBe('unchanged');
    expect(h.store.stats('main').versions).toBe(3);
  });

  it('title and chat meta changes update in place without a new version', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.name = 'renamed'; s.characters[0]!.chats[0]!.note = 'N'; });
    const r = await h.sync();
    expect(r.outcome).toBe('synced');
    expect(r.chats.unchanged).toBe(3);
    expect(h.store.getChat('main', 'c1', 'a1')!.title).toBe('renamed');
    const head = h.store.getVersion(h.store.getChat('main', 'c1', 'a1')!.headVersion!)!;
    expect(JSON.parse(head.metaJson)).toMatchObject({ note: 'N' });
    expect(h.store.listVersions('main', 'c1', 'a1')).toHaveLength(1);
  });
});

describe('Syncer — changes (spec 3.4.3)', () => {
  it('append: pending first, version after the debounce, previous version kept', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.push({ role: 'user', data: 'u3' }); });
    const r1 = await h.sync();
    expect(r1.chats.pending).toBe(1);
    expect(h.store.listVersions('main', 'c1', 'a1')).toHaveLength(1);
    expect(h.store.getChat('main', 'c1', 'a1')!.pendingFp).not.toBeNull();

    h.clock.advance(9 * MIN);
    expect((await h.sync()).chats.pending).toBe(1); // 아직 안 됨 (소스 지문이 같아도 대기 중이라 건너뛰지 않는다)
    h.clock.advance(2 * MIN);
    const r3 = await h.sync();
    expect(r3.chats.appended).toBe(1);
    const vs = h.store.listVersions('main', 'c1', 'a1');
    expect(vs.map((v) => v.reason)).toEqual(['initial', 'appended']);
    expect(textsOf(h, 'c1', 'a1')).toEqual(['u1', 'm1', 'u2', 'm2', 'u3']);
    expect(textsOf(h, 'c1', 'a1', vs[0]!.versionId)).toEqual(['u1', 'm1', 'u2', 'm2']); // 이전 버전 보존
    expect(h.store.getChat('main', 'c1', 'a1')!.pendingFp).toBeNull();
  });

  it('append with force (chat-open sync) commits immediately', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.push({ role: 'user', data: 'u3' }); });
    const r = await h.syncer.syncSource(h.adapter, { only: { charId: 'c1', chatId: 'a1' }, force: true });
    expect(r.chats.appended).toBe(1);
    expect(h.store.listVersions('main', 'c1', 'a1')).toHaveLength(2);
    expect(h.store.getState('main', 'last_fp')).not.toBeNull(); // only 동기화는 last_fp 를 건드리지 않는다
    expect(r.outcome).toBe('synced');
  });

  it('edit: immediate new version; old text stays readable', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message[1]!.data = 'm1-EDITED'; });
    const r = await h.sync();
    expect(r.chats.edited).toBe(1);
    const vs = h.store.listVersions('main', 'c1', 'a1');
    expect(vs.map((v) => v.reason)).toEqual(['initial', 'edited']);
    expect(textsOf(h, 'c1', 'a1')[1]).toBe('m1-EDITED');
    expect(textsOf(h, 'c1', 'a1', vs[0]!.versionId)[1]).toBe('m1');
  });

  it('message removed from the end counts as an edit (never lost)', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.pop(); });
    const r = await h.sync();
    expect(r.chats.edited).toBe(1);
    const vs = h.store.listVersions('main', 'c1', 'a1');
    expect(textsOf(h, 'c1', 'a1', vs[0]!.versionId)).toHaveLength(4);
  });

  it('chat deleted in the source: tombstone, copies and versions kept; reappearing clears it', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats.pop(); }); // a2 삭제 (1/5 소실)
    const r = await h.sync();
    expect(r.chats.tombstoned).toBe(1);
    expect(h.store.listChats('main', 'c1', false).map((c) => c.chatId)).toEqual(['a1']);
    expect(h.store.listChats('main', 'c1', true).map((c) => [c.chatId, c.deleted])).toEqual([['a1', false], ['a2', true]]);
    expect(textsOf(h, 'c1', 'a2')).toEqual(['x1', 'y1']); // 사본 유지
    h.rewrite((s) => { s.characters[0]!.chats.push(chat('a2', ['x1', 'y1'])); });
    await h.sync();
    expect(h.store.getChat('main', 'c1', 'a2')!.deletedAt).toBeNull();
    expect(h.store.listVersions('main', 'c1', 'a2')).toHaveLength(1); // 내용이 같으면 새 버전 없음
  });

  it('character removed: it and its chats are tombstoned', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters.pop(); }); // Bob(캐릭터 1 + 채팅 1 = 2/5)
    const r = await h.sync();
    expect(r.chars.tombstoned).toBe(1);
    expect(h.store.listChars('main', false).map((c) => c.charId)).toEqual(['c1']);
    expect(h.store.listChars('main', true).find((c) => c.charId === 'c2')!.deleted).toBe(true);
  });
});

describe('Syncer — R6 safety', () => {
  it('mass disappearance (>50%) is held with a warning; accept applies it', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters.shift(); }); // Alice + a1 + a2 = 3/5
    const r = await h.sync();
    expect(r.held).toEqual({ items: 5, missing: 3 });
    expect(r.chats.tombstoned + r.chars.tombstoned).toBe(0);
    expect(h.store.stats('main')).toMatchObject({ chars: 2, chats: 3, charsDeleted: 0 });
    const ok = await h.sync({ acceptMassDeletion: true });
    expect(ok.held).toBeUndefined();
    expect(h.store.stats('main')).toMatchObject({ chars: 1, charsDeleted: 1, chatsDeleted: 2 });
  });

  it('source file missing or chunk-corrupt: skipped, nothing deleted, nothing created', async () => {
    const h = makeHarness();
    await h.sync();
    const before = h.store.stats('main');
    fs.rmSync(path.join(h.srcDir, 'risuai.db'));
    const gone = await h.sync({ force: true });
    expect(gone).toMatchObject({ outcome: 'skipped', reason: 'risuai.db not found' });
    h.rewrite(undefined, { corruptChunk: true });
    const bad = await h.sync({ force: true });
    expect(bad).toMatchObject({ outcome: 'skipped', reason: 'chunk integrity error' });
    expect(h.store.stats('main')).toEqual(before);
    // 복구되면 정상 동작하고 last_fp 는 성공 때만 갱신된다
    h.rewrite();
    expect((await h.sync({ force: true })).outcome).toBe('synced');
  });

  it('unreadable chat is isolated: others sync, its existing copy and head are untouched, not tombstoned', async () => {
    const h = makeHarness();
    h.spec.characters[0]!.chats.push({ id: 'cold1', name: 'cold', message: [{ role: 'user', data: `${COLD_HEADER}k1` }] });
    h.spec.cold = { k1: [{ role: 'user', data: 'cold-text' }] };
    h.rewrite();
    await h.sync();
    expect(textsOf(h, 'c1', 'cold1')).toEqual(['cold-text']);
    const headBefore = h.store.getChat('main', 'c1', 'cold1')!.headVersion;

    h.spec.cold = {}; // cold 항목이 사라짐 → 읽을 수 없음 (삭제가 아님)
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.push({ role: 'user', data: 'newer' }); });
    const r = await h.sync({ force: true });
    expect(r.chats.unreadable).toBe(1);
    expect(r.chats.appended).toBe(1); // 다른 채팅은 정상 처리
    const row = h.store.getChat('main', 'c1', 'cold1')!;
    expect(row.headVersion).toBe(headBefore);
    expect(row.deletedAt).toBeNull();
    expect(row.lastError).toBe('cold storage entry missing');
    expect(textsOf(h, 'c1', 'cold1')).toEqual(['cold-text']);
    expect(h.store.getState('main', 'last_fp')).not.toBe(await h.adapter.fingerprint()); // 오류가 있으면 지문을 확정하지 않는다 → 다음에 재시도
  });

  it('concurrent syncs of one source are serialized', async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.sync(), h.sync()]);
    expect([a.outcome, b.outcome].sort()).toEqual(['synced', 'unchanged']);
    expect(h.store.stats('main').versions).toBe(3);
  });

  it('persists the last report', async () => {
    const h = makeHarness();
    await h.sync();
    expect(JSON.parse(h.store.getState('main', 'last_report')!)).toMatchObject({ source: 'main', outcome: 'synced' });
  });
});
