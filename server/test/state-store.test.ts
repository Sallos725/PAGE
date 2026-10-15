import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-state-'));
const pos = (n: number) => ({ msgIdx: n, blockIdx: 1, charOffset: 7, anchorHash: 'deadbeef' });

describe('StateStore', () => {
  it('lives in its own private directory, separate from the library', () => {
    const dir = tmp();
    const s = new StateStore(dir);
    expect(fs.existsSync(path.join(dir, 'state', 'state.db'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'state')).mode & 0o777).toBe(0o700);
    s.close();
  });

  it('positions: one per (source, char, chat), last write wins, isolated by key', () => {
    const s = new StateStore(tmp());
    expect(s.getPosition('main', 'c1', 'a1')).toBeNull();
    s.putPosition('main', 'c1', 'a1', pos(3), 100);
    s.putPosition('main', 'c1', 'a1', pos(9), 200);
    s.putPosition('main', 'c2', 'a1', pos(1), 300); // 같은 chat id, 다른 캐릭터
    expect(s.getPosition('main', 'c1', 'a1')).toEqual({ position: pos(9), updatedAt: 200 });
    expect(s.getPosition('main', 'c2', 'a1')).toEqual({ position: pos(1), updatedAt: 300 });
    expect(s.getPosition('alt', 'c1', 'a1')).toBeNull();
  });

  it('settings: merge by key, JSON values round-trip, updatedAt tracked', () => {
    const s = new StateStore(tmp());
    expect(s.getSettings()).toEqual({});
    s.putSettings({ theme: 'sepia', 'reader.fontSize': 19, flags: { a: [1, 2] } }, 10);
    s.putSettings({ theme: 'dark' }, 20);
    expect(s.getSettings()).toEqual({ theme: 'dark', 'reader.fontSize': 19, flags: { a: [1, 2] } });
  });

  it('putSettings is atomic: a failure keeps earlier keys unchanged', () => {
    const s = new StateStore(tmp());
    s.putSettings({ a: 1 }, 1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => s.putSettings({ a: 2, b: circular }, 2)).toThrow();
    expect(s.getSettings()).toEqual({ a: 1 });
  });

  it('has the bookmarks table ready for stage 2C', () => {
    const s = new StateStore(tmp());
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'bookmarks'").get()).toBeTruthy();
  });
});
