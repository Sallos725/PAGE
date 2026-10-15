import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { normalizeMessage } from '../src/source/normalize.js';
import { extractAssetNames, isTrackedAssetName } from '../src/source/pocketrisu/refs.js';
import { assetMime, createAssetResolver } from '../src/source/pocketrisu/assets.js';
import { coldKeyOf, readColdChat } from '../src/source/pocketrisu/cold.js';
import { openSourceDb } from '../src/sqlite.js';
import { AM, COLD_HEADER, PNG, baseSpec, writeSource } from './helpers/synthetic-source.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-parts-'));

describe('normalizeMessage', () => {
  it('maps role/data/time; unknown shapes degrade safely', () => {
    expect(normalizeMessage('pocketrisu-sqlite', { role: 'user', data: 'hi', time: 5, generationInfo: {} }, 3)).toEqual({ idx: 3, role: 'user', text: 'hi', time: 5 });
    expect(normalizeMessage('pocketrisu-sqlite', { role: 'char', data: 'yo' }, 0)).toEqual({ idx: 0, role: 'char', text: 'yo' });
    expect(normalizeMessage('pocketrisu-sqlite', { role: 'weird', data: 42 }, 1)).toEqual({ idx: 1, role: 'char', text: '' });
    expect(normalizeMessage('pocketrisu-sqlite', null, 2)).toEqual({ idx: 2, role: 'char', text: '' });
  });
});

describe('extractAssetNames', () => {
  it('finds CBS marker names and data-am-asset attributes, distinct', () => {
    const t = `a {{raw::${AM(1)}}} b {{img::pic one}} <img data-am-asset="${AM(1)}" src="{{raw::${AM(1)}}}"> {{inlay::zzz}} {{random::1}}`;
    expect(extractAssetNames([{ data: t }, { data: 5 }, null]).sort()).toEqual([AM(1), 'pic one'].sort());
  });
  it('tracks only Asset Maid names when unresolved', () => {
    expect(isTrackedAssetName(AM(1))).toBe(true);
    expect(isTrackedAssetName('plain')).toBe(false);
  });
});

describe('asset resolver', () => {
  const spec = () => {
    const s = baseSpec();
    s.characters[0]!.modules = ['m1'];
    s.manifests = [
      { kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png']] },
      { kind: 'module', ownerId: 'm1', items: [['ModAsset', 'assets/p3.png', 'png']] },
    ];
    s.characters[0]!.additionalAssets = [[AM(2), 'assets/p2.png', 'png']];
    s.assets = { 'assets/p1.png': PNG(1), 'assets/p2.png': PNG(2), 'assets/p3.png': PNG(3) };
    return s;
  };

  it('unions manifest, inline additionalAssets and module manifests; case-insensitive exact match', () => {
    const s = spec();
    const db = openSourceDb(writeSource(tmp(), s));
    const r = createAssetResolver(db);
    const c = s.characters[0]!;
    expect(r.names(c).sort()).toEqual([AM(1), AM(2), 'ModAsset'].sort());
    expect(Buffer.from(r.resolveAsset(c, AM(1))!)[7]).toBe(1);
    expect(Buffer.from(r.resolveAsset(c, AM(2))!)[7]).toBe(2); // 인라인에만 있는 에셋 (findings §3.1-3)
    expect(Buffer.from(r.resolveAsset(c, 'modasset')!)[7]).toBe(3);
    expect(r.resolveAsset(c, 'nope')).toBeNull();
    expect(r.resolveAsset(s.characters[1]!, AM(1))).toBeNull(); // 다른 캐릭터의 에셋은 안 보인다
    db.close();
  });

  it('works when the manifest tables do not exist', () => {
    const dir = tmp();
    const file = path.join(dir, 'risuai.db');
    const w = new DatabaseSync(file);
    w.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER)');
    w.prepare('INSERT INTO kv VALUES(?,?,?)').run('assets/p.png', PNG(9), 1);
    w.close();
    const db = openSourceDb(file);
    const r = createAssetResolver(db);
    const c = { chaId: 'x', additionalAssets: [['A', 'assets/p.png', 'png']] };
    expect(r.names(c)).toEqual(['A']);
    expect(r.resolveAsset(c, 'a')).not.toBeNull();
    db.close();
  });

  it('sniffs mime from magic bytes', () => {
    expect(assetMime(PNG(1))).toBe('image/png');
    expect(assetMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(assetMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(assetMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(assetMime(Buffer.from('zzzz'))).toBe('application/octet-stream');
  });
});

describe('cold chat', () => {
  it('detects the header on message[0].data', () => {
    expect(coldKeyOf({ message: [{ data: `${COLD_HEADER}k1` }] })).toBe('k1');
    expect(coldKeyOf({ message: [{ data: 'plain' }] })).toBeNull();
    expect(coldKeyOf({ message: [] })).toBeNull();
    expect(coldKeyOf({})).toBeNull();
  });

  it('restores messages from coldstorage/<key> (gzip JSON), array or object shape', () => {
    const s = baseSpec();
    s.cold = { k1: [{ role: 'user', data: 'cold-1' }], k2: { message: [{ role: 'char', data: 'cold-2' }], scriptstate: { a: 1 }, other: 'ignored' } };
    const db = openSourceDb(writeSource(tmp(), s));
    expect(readColdChat(db, 'k1')).toEqual({ ok: true, messages: [{ role: 'user', data: 'cold-1' }], extra: {} });
    expect(readColdChat(db, 'k2')).toEqual({ ok: true, messages: [{ role: 'char', data: 'cold-2' }], extra: { scriptstate: { a: 1 } } });
    db.close();
  });

  it('fails closed: missing, unreadable, unsafe key, unknown shape', () => {
    const dir = tmp();
    const file = path.join(dir, 'risuai.db');
    const w = new DatabaseSync(file);
    w.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER)');
    w.prepare('INSERT INTO kv VALUES(?,?,?)').run('coldstorage/bad', Buffer.from('not gzip'), 1);
    w.prepare('INSERT INTO kv VALUES(?,?,?)').run('coldstorage/shape', gzipSync(Buffer.from('{"x":1}')), 1);
    w.prepare('INSERT INTO kv VALUES(?,?,?)').run('coldstorage/old.json', Buffer.from('[{"role":"user","data":"legacy"}]'), 1);
    w.close();
    const db = openSourceDb(file);
    expect(readColdChat(db, 'missing')).toEqual({ ok: false, reason: 'cold storage entry missing' });
    expect(readColdChat(db, 'bad')).toEqual({ ok: false, reason: 'cold storage entry unreadable' });
    expect(readColdChat(db, 'shape')).toEqual({ ok: false, reason: 'cold storage entry has unknown shape' });
    expect(readColdChat(db, '../x')).toEqual({ ok: false, reason: 'invalid cold storage key' });
    expect(readColdChat(db, 'old')).toEqual({ ok: true, messages: [{ role: 'user', data: 'legacy' }], extra: {} }); // 레거시 .json 키 + 평문
    db.close();
  });
});
