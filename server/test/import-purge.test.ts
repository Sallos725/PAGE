import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canon, sha256Hex } from '../src/canon.js';
import { ImportStore } from '../src/import/store.js';
import { LibraryStore } from '../src/library/store.js';
import { ImportAdapter } from '../src/source/import/adapter.js';
import type { ScanOptions } from '../src/source/types.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';
import { PNG_1X1, baseSpec } from './helpers/synthetic-source.js';
import { Syncer } from '../src/sync/syncer.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
// Windows 는 SQLite 가 연 파일을 지울 수 없다 (FILE_SHARE_DELETE 없이 연다). DB 를 먼저 닫고 폴더를 지운다.
afterEach(() => {
  vi.restoreAllMocks();
  while (closers.length) closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const policy = { debounceMs: 0, massDeletionRatio: 0.5, warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9, freeSpace: () => ({ freeBytes: 1e12, totalBytes: 2e12 }) };
const parsed = (id: string, msgs: string[], title = '합성') => {
  const messages = msgs.map((m, i) => ({ role: i % 2 ? 'char' : 'user', data: m }));
  return { id, title, lastDate: 1, messages, raw: { id, name: title, lastDate: 1, message: messages } };
};
const msgHash = (data: string, i: number) => sha256Hex(canon({ role: i % 2 ? 'char' : 'user', data }));
function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-purge-')); dirs.push(d);
  const imports = new ImportStore(d);
  const store = new LibraryStore(d);
  const state = new StateStore(d);
  closers.push(() => store.close(), () => state.close());
  let t = 1000;
  const syncer = new Syncer({ store, now: () => ++t, policy });
  return { d, imports, store, state, syncer, adapter: new ImportAdapter(imports) };
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
function sharedSpec() {
  const spec = baseSpec();
  spec.characters[0]!.image = 'assets/alice.png';
  spec.assets = { 'assets/alice.png': PNG_1X1 };
  return spec;
}
const hasMsg = (store: LibraryStore, hash: string) =>
  (store.db.prepare('SELECT count(*) AS n FROM lib_msgs WHERE msg_hash = ?').get(hash) as { n: number }).n > 0;
const count = (store: LibraryStore, table: string, where: string, ...p: string[]) =>
  (store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...p) as { n: number }).n;
const pos = { msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: 'h' };
const bm = (text: string) => ({ kind: 'highlight' as const, start: pos, end: pos, note: '', color: '', text });

describe('library purge', () => {
  it('purgeChat drops the chat and its unique messages, keeps messages another character still uses', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const b = imports.createChar('B', 2);
    imports.putChats(a, [parsed('a1', ['공유', 'A-고유'])]);
    imports.putChats(b, [parsed('b1', ['공유', 'B-고유'])]);
    await syncer.syncSource(adapter, { force: true });
    expect(hasMsg(store, msgHash('A-고유', 1))).toBe(true);

    store.purgeChat('imported', a, 'a1');
    expect(store.getChat('imported', a, 'a1')).toBeNull();
    expect(store.listVersions('imported', a, 'a1')).toEqual([]);
    expect(hasMsg(store, msgHash('A-고유', 1))).toBe(false);
    expect(hasMsg(store, msgHash('공유', 0))).toBe(true);
    expect(hasMsg(store, msgHash('B-고유', 1))).toBe(true);
    expect(store.getChat('imported', b, 'b1')?.headVersion).not.toBeNull();
  });

  it('purgeChat keeps messages that another version of the same chat still uses', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const other = imports.createChar('O', 2);
    imports.putChats(a, [parsed('a1', ['1', '2'])]);
    await syncer.syncSource(adapter, { force: true });
    imports.putChats(a, [parsed('a1', ['1', '2', '3'])]);
    imports.putChats(other, [parsed('o1', ['2'])]);
    await syncer.syncSource(adapter, { force: true });
    expect(store.listVersions('imported', a, 'a1')).toHaveLength(2);
    store.purgeChat('imported', a, 'a1');
    expect(hasMsg(store, msgHash('1', 0))).toBe(false);
    expect(hasMsg(store, msgHash('3', 0))).toBe(false);
    expect(count(store, 'lib_manifests', '1=1')).toBe(1); // 다른 캐릭터의 매니페스트만 남는다
  });

  it('purgeChar removes the character and its image blob; a blob another character shares stays', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const b = imports.createChar('B', 2);
    const c = imports.createChar('C', 3);
    const other = Buffer.concat([PNG, Buffer.from([1, 2, 3])]);
    imports.setImage(a, PNG);
    imports.setImage(b, PNG); // A 와 같은 그림
    imports.setImage(c, other); // C 만 쓰는 그림
    imports.putChats(a, [parsed('a1', ['x'])]);
    await syncer.syncSource(adapter, { force: true });
    const shared = store.getCharImage('imported', a)!.hash!;
    const solo = store.getCharImage('imported', c)!.hash!;
    expect(shared).toBe(store.getCharImage('imported', b)!.hash);
    expect(fs.existsSync(store.blobPath(shared))).toBe(true);

    store.purgeChar('imported', a);
    expect(store.listChars('imported', true).map((x) => x.charId)).not.toContain(a);
    expect(store.getCharImage('imported', a)).toBeNull();
    expect(count(store, 'lib_chats', 'char_id = ?', a)).toBe(0);
    expect(fs.existsSync(store.blobPath(shared))).toBe(true); // B 가 아직 쓴다
    expect(store.hasAsset(shared)).toBe(true);

    store.purgeChar('imported', c);
    expect(store.hasAsset(solo)).toBe(false);
    expect(fs.existsSync(store.blobPath(solo))).toBe(false);
    store.purgeChar('imported', b);
    expect(fs.existsSync(store.blobPath(shared))).toBe(false);
  });

  it('a blob file that cannot be removed does not fail the purge: the row goes, the orphan file stays', async () => {
    const { imports, store, syncer, adapter } = setup();
    const c = imports.createChar('C', 1);
    imports.setImage(c, PNG);
    imports.putChats(c, [parsed('c1', ['x'])]);
    await syncer.syncSource(adapter, { force: true });
    const hash = store.getCharImage('imported', c)!.hash!;
    const blob = store.blobPath(hash);
    const real = fs.rmSync.bind(fs);
    // 다시 해도 안 풀리는 잠금 (EPERM 계속)
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === blob) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real(p, o);
    }) as typeof fs.rmSync);
    expect(() => store.purgeChar('imported', c)).not.toThrow();
    expect(store.hasAsset(hash)).toBe(false);
    expect(store.getCharImage('imported', c)).toBeNull();
    expect(fs.existsSync(blob)).toBe(true); // 고아 blob — 같은 내용이 다시 들어오면 덮어쓴다
  });

  it('is safe to repeat', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    imports.setImage(a, PNG);
    imports.putChats(a, [parsed('a1', ['1'])]);
    await syncer.syncSource(adapter, { force: true });
    store.purgeChat('imported', a, 'a1');
    expect(() => store.purgeChat('imported', a, 'a1')).not.toThrow();
    store.purgeChar('imported', a);
    expect(() => store.purgeChar('imported', a)).not.toThrow();
    expect(() => store.purgeChat('imported', 'nope', 'nope')).not.toThrow();
  });

  it('leaves no trace of purged text in the db files or their -wal after checkpoint() (secure_delete)', async () => {
    const { d, imports, store, state, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const TITLE = 'ZQXJ-합성고유제목-7731';
    const NOTE = 'ZQXJ-합성고유문장-9042';
    imports.putChats(a, [parsed('a1', ['m'], TITLE)]);
    await syncer.syncSource(adapter, { force: true });
    state.addBookmark('imported', a, 'a1', bm(NOTE), 5);
    const files = {
      lib: [path.join(d, 'library', 'library.db'), path.join(d, 'library', 'library.db-wal')],
      st: [path.join(d, 'state', 'state.db'), path.join(d, 'state', 'state.db-wal')],
    };
    const bytes = (fs_: string[]) => fs_.map((f) => (fs.existsSync(f) ? fs.readFileSync(f).toString('latin1') : '')).join('\n');
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
    // 대조군: 지우기 전에는 (db + wal 합쳐) 글자가 있다 — 이게 없으면 아래 검사가 아무것도 증명하지 못한다
    expect(bytes(files.lib)).toContain(enc(TITLE));
    expect(bytes(files.st)).toContain(enc(NOTE));

    store.purgeChat('imported', a, 'a1');
    state.purgeChatState('imported', a, 'a1');
    store.checkpoint();
    state.checkpoint();
    expect(bytes(files.lib)).not.toContain(enc(TITLE));
    expect(bytes(files.st)).not.toContain(enc(NOTE));
  });

  it('refuses to purge anything but the imported source', () => {
    const { store, state } = setup();
    expect(() => store.purgeChat('main', 'c', 'x')).toThrow('only for the imported source');
    expect(() => store.purgeChar('main', 'c')).toThrow('only for the imported source');
    expect(() => state.purgeChatState('main', 'c', 'x')).toThrow('only for the imported source');
    expect(() => state.purgeCharState('main', 'c')).toThrow('only for the imported source');
  });

  it('does not touch another source that shares the same message and image', async () => {
    const h = makeHarness({ spec: sharedSpec() });
    await h.sync();
    const imports = new ImportStore(h.dataDir);
    const importAdapter = new ImportAdapter(imports);
    // main 의 첫 메시지를 그대로 가져온 채팅에도 넣고, main 캐릭터와 같은 그림을 쓴다
    const mainChat = h.store.getChat('main', 'c1', 'a1')!;
    const mainHashes = h.store.getManifest(h.store.getVersion(mainChat.headVersion!)!.manifestHash)!;
    const shared = JSON.parse(h.store.getMsgJson([mainHashes[0]!])[0]!) as unknown;
    const c = imports.createChar('가져온', 1);
    imports.setImage(c, PNG_1X1);
    const messages = [shared, { role: 'char', data: '가져온-고유' }];
    imports.putChats(c, [{ id: 'i1', title: '합성', lastDate: 1, messages, raw: { id: 'i1', name: '합성', lastDate: 1, message: messages } }]);
    await h.syncer.syncSource(importAdapter, { force: true });
    const imgHash = h.store.getCharImage('imported', c)!.hash!;
    expect(imgHash).toBe(h.store.getCharImage('main', 'c1')!.hash);
    const sharedHash = sha256Hex(canon(shared));
    const uniqueHash = sha256Hex(canon(messages[1]));
    expect(hasMsg(h.store, sharedHash)).toBe(true);

    h.store.purgeChar('imported', c);
    expect(hasMsg(h.store, sharedHash)).toBe(true);
    expect(hasMsg(h.store, uniqueHash)).toBe(false);
    expect(h.store.hasAsset(imgHash)).toBe(true);
    expect(fs.existsSync(h.store.blobPath(imgHash))).toBe(true);
    expect(h.store.getCharImage('main', 'c1')?.hash).toBe(imgHash);
    expect(h.store.getChat('main', 'c1', 'a1')?.headVersion).not.toBeNull();
    expect(h.store.getMsgJson(mainHashes).map((j) => JSON.parse(j) as unknown)).toHaveLength(mainHashes.length);
  });
});

describe('state purge', () => {
  it('purgeChatState removes only that chat', () => {
    const { state } = setup();
    const s = 'imported';
    for (const chat of ['a1', 'a2']) {
      state.putPosition(s, 'A', chat, pos, 1);
      state.addBookmark(s, 'A', chat, bm('t'), 1);
      state.setAlias(s, 'chat', 'A', chat, 'n', 1);
      state.setKept(s, 'A', chat, true, 1);
    }
    state.setAlias(s, 'char', 'A', '', '캐릭터', 1);
    state.purgeChatState(s, 'A', 'a1');
    expect(state.getPosition(s, 'A', 'a1')).toBeNull();
    expect(state.countBookmarks(s, 'A', 'a1')).toBe(0);
    expect(state.aliasMap(s, 'chat', 'A').has('a1')).toBe(false);
    expect(state.keptMap(s, 'A').has(`A\u0000a1`)).toBe(false);
    expect(state.getPosition(s, 'A', 'a2')).not.toBeNull();
    expect(state.countBookmarks(s, 'A', 'a2')).toBe(1);
    expect(state.aliasMap(s, 'chat', 'A').has('a2')).toBe(true);
    expect(state.keptMap(s, 'A').has(`A\u0000a2`)).toBe(true);
    expect(state.aliasMap(s, 'char').get('A')).toBe('캐릭터');
  });

  it('purgeCharState removes the character alias, char-scoped hide rules and card image rule switches, not other characters or global rules', () => {
    const { state } = setup();
    const s = 'imported';
    const rule = (scope: 'global' | 'char', charId: string) => ({ scope, charId, name: 'r', pattern: 'p', flags: '', enabled: true, origin: 'manual' as const });
    state.putPosition(s, 'A', 'a1', pos, 1);
    state.putPosition(s, 'B', 'b1', pos, 1);
    state.setAlias(s, 'char', 'A', '', 'A명', 1);
    state.setAlias(s, 'char', 'B', '', 'B명', 1);
    state.addHideRule(s, rule('char', 'A'), 1);
    state.addHideRule(s, rule('char', 'B'), 1);
    state.addHideRule(s, rule('global', ''), 1);
    state.setImageRuleEnabled(s, 'A', 'k', false, 1);
    state.setImageRuleEnabled(s, 'B', 'k', false, 1);
    state.addBookmark(s, 'A', 'a1', bm('t'), 1);
    state.setKept(s, 'A', 'a1', true, 1);

    state.purgeCharState(s, 'A');
    expect(state.getPosition(s, 'A', 'a1')).toBeNull();
    expect(state.aliasMap(s, 'char').has('A')).toBe(false);
    expect(state.imageRulesOff(s, 'A').size).toBe(0);
    expect(state.countBookmarks(s, 'A', 'a1')).toBe(0);
    expect(state.keptMap(s, 'A').size).toBe(0);
    expect(state.getPosition(s, 'B', 'b1')).not.toBeNull();
    expect(state.aliasMap(s, 'char').get('B')).toBe('B명');
    expect(state.imageRulesOff(s, 'B').size).toBe(1);
    expect(state.countHideRules(s)).toBe(2); // B 의 캐릭터 규칙 + 전역 규칙
  });
});

describe('Syncer.exclusive', () => {
  it('runs one after another with syncSource on the same source', async () => {
    const { syncer, adapter } = setup();
    const log: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = Object.create(adapter) as ImportAdapter;
    slow.scan = async (cb, o?: ScanOptions) => { log.push('scan-start'); await sleep(30); const r = await adapter.scan(cb, o); log.push('scan-end'); return r; };
    const p1 = syncer.syncSource(slow, { force: true });
    const p2 = syncer.exclusive('imported', async () => { log.push('ex-start'); await sleep(15); log.push('ex-end'); return 42; });
    const p3 = syncer.syncSource(slow, { force: true });
    expect(await p2).toBe(42);
    await Promise.all([p1, p3]);
    expect(log).toEqual(['scan-start', 'scan-end', 'ex-start', 'ex-end', 'scan-start', 'scan-end']);
  });

  it('keeps the queue alive after a failing task', async () => {
    const { syncer } = setup();
    await expect(syncer.exclusive('imported', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await syncer.exclusive('imported', () => 'ok')).toBe('ok');
  });
});
