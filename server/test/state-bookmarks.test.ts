import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-bm-'));
const P = (m: number, b = 0, o = 0) => ({ msgIdx: m, blockIdx: b, charOffset: o, anchorHash: 'h' });

describe('StateStore bookmarks', () => {
  it('adds, lists in insertion order and isolates by (source, char, chat)', () => {
    const s = new StateStore(tmp());
    const a = s.addBookmark('main', 'c1', 'a1', { kind: 'bookmark', start: P(5), end: null, note: '', color: '', text: '' }, 10);
    const b = s.addBookmark('main', 'c1', 'a1', { kind: 'highlight', start: P(2, 0, 1), end: P(2, 0, 9), note: 'n', color: 'yellow', text: '' }, 10);
    s.addBookmark('main', 'c2', 'a1', { kind: 'bookmark', start: P(1), end: null, note: '', color: '', text: '' }, 11);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.listBookmarks('main', 'c1', 'a1')).toEqual([a, b]);
    expect(s.listBookmarks('main', 'c2', 'a1')).toHaveLength(1);
    expect(s.countBookmarks('main', 'c1', 'a1')).toBe(2);
    expect(b).toMatchObject({ kind: 'highlight', end: P(2, 0, 9), note: 'n', color: 'yellow', createdAt: 10 });
  });

  it('deletes only within the same chat', () => {
    const s = new StateStore(tmp());
    const a = s.addBookmark('main', 'c1', 'a1', { kind: 'bookmark', start: P(5), end: null, note: '', color: '', text: '' }, 1);
    expect(s.deleteBookmark('main', 'c2', 'a1', a.id)).toBe(false);
    expect(s.deleteBookmark('main', 'c1', 'a1', a.id)).toBe(true);
    expect(s.deleteBookmark('main', 'c1', 'a1', a.id)).toBe(false);
    expect(s.listBookmarks('main', 'c1', 'a1')).toEqual([]);
  });
});

describe('StateStore bookmarks text column', () => {
  it('adds the text column to an old bookmarks table and keeps existing rows', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-bm-mig-'));
    fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
    const old = new DatabaseSync(path.join(dataDir, 'state', 'state.db'));
    old.exec(`CREATE TABLE bookmarks(
      id TEXT PRIMARY KEY, source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      start_json TEXT NOT NULL, end_json TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('bookmark','highlight')),
      note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
    old.prepare('INSERT INTO bookmarks(id,source,char_id,chat_id,start_json,end_json,kind,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('b1', 'main', 'c1', 'a1', JSON.stringify({ msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: 'h' }), null, 'bookmark', 5);
    old.close();
    const s = new StateStore(dataDir);
    expect(s.listBookmarks('main', 'c1', 'a1')).toEqual([expect.objectContaining({ id: 'b1', text: '' })]);
    expect(s.setBookmarkText('main', 'c1', 'a1', 'b1', '채움')).toBe(true);
    expect(s.listBookmarks('main', 'c1', 'a1')[0]!.text).toBe('채움');
    s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
