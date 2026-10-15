import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportStore } from '../src/import/store.js';
import { LibraryStore } from '../src/library/store.js';
import { ImportAdapter } from '../src/source/import/adapter.js';
import { normalizeMessage } from '../src/source/normalize.js';
import { Syncer } from '../src/sync/syncer.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
// Windows 는 SQLite 가 연 파일을 지울 수 없다 (FILE_SHARE_DELETE 없이 연다). DB 를 먼저 닫고 폴더를 지운다.
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const policy = { debounceMs: 0, massDeletionRatio: 0.5, warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9, freeSpace: () => ({ freeBytes: 1e12, totalBytes: 2e12 }) };
const parsed = (id: string, msgs: string[]) => {
  const messages = msgs.map((m, i) => ({ role: i % 2 ? 'char' : 'user', data: m }));
  return { id, title: '합성', lastDate: 1, messages, raw: { id, name: '합성', lastDate: 1, message: messages } };
};
function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-impad-')); dirs.push(d);
  const imports = new ImportStore(d);
  const store = new LibraryStore(d);
  closers.push(() => store.close());
  let t = 1000;
  const syncer = new Syncer({ store, now: () => ++t, policy });
  return { imports, store, syncer, adapter: new ImportAdapter(imports) };
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('ImportAdapter', () => {
  it('is the imported source, healthy, and normalises like PocketRisu', async () => {
    const { adapter } = setup();
    expect(adapter.id).toBe('imported');
    expect((await adapter.health()).status).toBe('ok');
    expect(normalizeMessage('risu-import', { role: 'user', data: 'hi', time: 3 }, 0)).toEqual({ idx: 0, role: 'user', text: 'hi', time: 3 });
  });

  it('syncs characters, chats and the image; re-import with more messages makes a new version', async () => {
    const { imports, store, syncer, adapter } = setup();
    const c = imports.createChar('합성 캐릭터', 1);
    imports.setImage(c, PNG);
    imports.putChats(c, [parsed('a', ['1', '2'])]);
    await syncer.syncSource(adapter, { force: true });
    expect(store.listChars('imported', false).map((x) => x.name)).toEqual(['합성 캐릭터']);
    expect(store.getChat('imported', c, 'a')?.headVersion).not.toBeNull();
    expect(store.getCharImage('imported', c)?.hash).toMatch(/^[0-9a-f]{64}$/);
    imports.putChats(c, [parsed('a', ['1', '2', '3'])]);
    await syncer.syncSource(adapter, { force: true });
    expect(store.listVersions('imported', c, 'a')).toHaveLength(2);
  });

  it('a broken chat file is unreadable without failing the others', async () => {
    const { imports, store, syncer, adapter } = setup();
    const c = imports.createChar('c', 1);
    imports.putChats(c, [parsed('good', ['1'])]);
    fs.writeFileSync(path.join(imports.root, c, 'chats', 'bad.json'), '{not json');
    const r = await syncer.syncSource(adapter, { force: true });
    expect(r.chats.unreadable).toBe(1);
    expect(store.getChat('imported', c, 'good')).not.toBeNull();
  });

  it('replacing the image and syncing again stores the new image', async () => {
    const { imports, store, syncer, adapter } = setup();
    const c = imports.createChar('c', 1);
    imports.setImage(c, PNG);
    await syncer.syncSource(adapter, { force: true });
    const first = store.getCharImage('imported', c)!.hash!;
    imports.setImage(c, Buffer.concat([PNG, Buffer.from([1, 2, 3])]));
    await syncer.syncSource(adapter, { force: true });
    const second = store.getCharImage('imported', c)!.hash!;
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    imports.removeImage(c);
    await syncer.syncSource(adapter, { force: true });
    expect(store.getCharImage('imported', c)).toBeNull();
  });

  it('an unreadable char.json makes the scan incomplete, so nothing is tombstoned because of it', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const b = imports.createChar('B', 2);
    imports.putChats(a, [parsed('a1', ['1'])]);
    imports.putChats(b, [parsed('b1', ['1'])]);
    await syncer.syncSource(adapter, { force: true });
    fs.writeFileSync(path.join(imports.root, b, 'char.json'), '{broken');
    const handed: string[] = [];
    const scan = await adapter.scan((c) => { handed.push(c.charId); });
    expect(scan.complete).toBe(false);
    expect(handed).toEqual([a]); // 깨진 캐릭터는 이름 없는 캐릭터로 넘기지 않는다
    expect(scan.seen.has(b)).toBe(false);
    const r = await syncer.syncSource(adapter, { force: true });
    expect(r.outcome).toBe('skipped');
    expect(store.getChat('imported', b, 'b1')?.deletedAt).toBeNull();
    expect(store.listChars('imported', false).map((x) => x.charId).sort()).toEqual([a, b].sort());
    fs.writeFileSync(path.join(imports.root, b, 'char.json'), JSON.stringify({ name: 'B', createdAt: 2 }));
    expect((await syncer.syncSource(adapter, { force: true })).outcome).toBe('synced');
    expect(store.getChat('imported', b, 'b1')?.deletedAt).toBeNull();
  });

  it('a one-character sync reads only that character and never tombstones the others', async () => {
    const { imports, store, syncer, adapter } = setup();
    const a = imports.createChar('A', 1);
    const b = imports.createChar('B', 2);
    imports.putChats(a, [parsed('a1', ['1'])]);
    imports.putChats(b, [parsed('b1', ['1'])]);
    await syncer.syncSource(adapter, { force: true });
    imports.deleteChat(b, 'b1');
    imports.putChats(a, [parsed('a1', ['1', '2'])]);
    const r = await syncer.syncSource(adapter, { force: true, onlyChar: a });
    expect(r.chars.seen).toBe(1);
    expect(store.listVersions('imported', a, 'a1')).toHaveLength(2);
    expect(store.getChat('imported', b, 'b1')?.deletedAt).toBeNull(); // 삭제 판단은 전체 동기화에서만
    await syncer.syncSource(adapter, { force: true });
    expect(store.getChat('imported', b, 'b1')?.deletedAt).not.toBeNull();
  });
});
