import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryStore } from '../src/library/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-store-'));
const H = (c: string) => c.repeat(64).slice(0, 64);

describe('LibraryStore', () => {
  it('creates a private library dir with db + blobs', () => {
    const dir = tmp();
    const s = new LibraryStore(dir);
    const lib = path.join(dir, 'library');
    expect(fs.existsSync(path.join(lib, 'library.db'))).toBe(true);
    expect(fs.statSync(lib).mode & 0o777).toBe(0o700);
    s.close();
  });

  it('stores chars/chats/versions and reads them back; msgs and manifests are content-addressed', () => {
    const s = new LibraryStore(tmp());
    s.tx(() => {
      s.upsertChar('src', 'c1', 'Alice', '{"name":"Alice"}', 100);
      s.ensureChat('src', 'c1', 'a1', 'title', 100);
      s.putMsgs([{ hash: H('a'), json: '{"x":1}' }, { hash: H('b'), json: '{"x":2}' }]);
      s.putMsgs([{ hash: H('a'), json: '{"x":1}' }]); // 중복 무시
      s.putManifest('m1', [H('a'), H('b')]);
      const v = s.insertVersion({ source: 'src', charId: 'c1', chatId: 'a1', createdAt: 100, msgCount: 2, manifestHash: 'm1', metaJson: '{}', reason: 'initial' });
      s.setHead('src', 'c1', 'a1', v);
    });
    const chat = s.getChat('src', 'c1', 'a1')!;
    expect(chat.headVersion).toBeTypeOf('number');
    const ver = s.getVersion(chat.headVersion!)!;
    expect(ver).toMatchObject({ msgCount: 2, reason: 'initial', manifestHash: 'm1' });
    expect(s.getManifest('m1')).toEqual([H('a'), H('b')]);
    expect(s.getMsgJson([H('b'), H('a')])).toEqual(['{"x":2}', '{"x":1}']);
    expect(s.db.prepare('SELECT count(*) AS c FROM lib_msgs').get()).toEqual({ c: 2 });
  });

  it('rolls the transaction back on error', () => {
    const s = new LibraryStore(tmp());
    expect(() => s.tx(() => { s.upsertChar('src', 'c1', 'A', '{}', 1); throw new Error('boom'); })).toThrow('boom');
    expect(s.liveCharIds('src')).toEqual([]);
  });

  it('tombstones keep rows and are cleared when the item reappears', () => {
    const s = new LibraryStore(tmp());
    s.tx(() => { s.upsertChar('src', 'c1', 'A', '{}', 1); s.ensureChat('src', 'c1', 'a1', 't', 1); });
    s.tx(() => s.tombstoneChats('src', [{ charId: 'c1', chatId: 'a1' }], 5));
    expect(s.getChat('src', 'c1', 'a1')!.deletedAt).toBe(5);
    expect(s.liveChatKeys('src')).toEqual([]);
    s.tx(() => s.ensureChat('src', 'c1', 'a1', 't', 9));
    expect(s.getChat('src', 'c1', 'a1')!.deletedAt).toBeNull();
    s.tx(() => s.tombstoneChars('src', ['c1'], 10));
    expect(s.listChars('src', false)).toEqual([]);
    expect(s.listChars('src', true)).toMatchObject([{ charId: 'c1', deleted: true }]);
    expect(s.getChat('src', 'c1', 'a1')!.deletedAt).toBe(10); // 캐릭터와 함께 채팅도 표시
  });

  it('blobs are content-addressed files, written once, mode 0600', () => {
    const dir = tmp();
    const s = new LibraryStore(dir);
    const bytes = Buffer.from([1, 2, 3]);
    s.putAssetBlob(H('c'), 'image/png', bytes, 7);
    s.putAssetBlob(H('c'), 'image/png', bytes, 8); // 두 번째는 무시
    expect(s.hasAsset(H('c'))).toBe(true);
    const p = s.blobPath(H('c'));
    expect(p.endsWith(path.join('blobs', 'cc', 'cc', H('c')))).toBe(true);
    expect(fs.readFileSync(p)).toEqual(bytes);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(s.assetInfo(H('c'))).toEqual({ mime: 'image/png', size: 3 });
    expect(s.db.prepare('SELECT count(*) AS c FROM lib_assets').get()).toEqual({ c: 1 });
  });

  it('version assets: set, read, fill deferred in place, find latest hash by ref', () => {
    const s = new LibraryStore(tmp());
    let v1 = 0;
    s.tx(() => {
      s.upsertChar('src', 'c1', 'A', '{}', 1);
      s.ensureChat('src', 'c1', 'a1', 't', 1);
      s.putManifest('m', []);
      v1 = s.insertVersion({ source: 'src', charId: 'c1', chatId: 'a1', createdAt: 1, msgCount: 0, manifestHash: 'm', metaJson: '{}', reason: 'initial' });
      s.setHead('src', 'c1', 'a1', v1);
      s.setVersionAssets(v1, [{ ref: 'A', hash: null, status: 'deferred' }, { ref: 'B', hash: H('d'), status: 'ok' }, { ref: 'C', hash: null, status: 'unresolved' }]);
    });
    expect(s.hasPendingOrDeferred('src')).toBe(true);
    expect(s.findAssetHash('src', 'c1', 'B')).toBe(H('d'));
    expect(s.findAssetHash('src', 'c1', 'A')).toBeNull();
    s.tx(() => s.updateVersionAsset(v1, 'A', H('e'), 'ok'));
    expect(s.hasPendingOrDeferred('src')).toBe(false); // unresolved 는 빠른 경로를 막지 않는다
    expect(s.getVersionAssets(v1).map((r) => r.status).sort()).toEqual(['ok', 'ok', 'unresolved']);
    expect(s.findAssetHash('src', 'c1', 'A')).toBe(H('e'));
  });

  it('sync state and pending flag', () => {
    const s = new LibraryStore(tmp());
    expect(s.getState('src', 'last_fp')).toBeNull();
    s.setState('src', 'last_fp', 'x');
    s.setState('src', 'last_fp', 'y');
    expect(s.getState('src', 'last_fp')).toBe('y');
    s.tx(() => { s.upsertChar('src', 'c1', 'A', '{}', 1); s.ensureChat('src', 'c1', 'a1', 't', 1); s.updateChatState('src', 'c1', 'a1', { lastDate: 3, pending: { fp: 'f', since: 4 }, fingerprint: 'fp' }); });
    expect(s.getChat('src', 'c1', 'a1')).toMatchObject({ lastDate: 3, pendingFp: 'f', pendingSince: 4, srcFingerprint: 'fp', lastError: null });
    expect(s.hasPendingOrDeferred('src')).toBe(true);
    s.tx(() => s.markChatError('src', 'c1', 'a1', 'why'));
    expect(s.getChat('src', 'c1', 'a1')!.lastError).toBe('why');
    s.tx(() => s.markChatError('src', 'c1', 'nope', 'ignored')); // 없는 채팅은 만들지 않는다
    expect(s.getChat('src', 'c1', 'nope')).toBeNull();
  });
});

describe('LibraryStore.getCharMeta', () => {
  it('returns the parsed meta of a known character, null otherwise', () => {
    const s = new LibraryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'page-store-meta-')));
    s.upsertChar('main', 'c1', 'A', JSON.stringify({ name: 'A', displayScripts: [{ comment: 'n', in: 'x', flag: 'g' }] }), 1);
    expect(s.getCharMeta('main', 'c1')).toEqual({ name: 'A', displayScripts: [{ comment: 'n', in: 'x', flag: 'g' }] });
    expect(s.getCharMeta('main', 'nope')).toBeNull();
  });
});
