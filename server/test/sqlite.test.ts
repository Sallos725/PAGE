import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isBusyError, openSourceDb, retryBusy } from '../src/sqlite.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-sqlite-'));

function makeDb(dir: string, name = 'risuai.db') {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB)');
  db.exec("INSERT INTO kv VALUES('a', x'01')");
  db.close();
  return file;
}

describe('openSourceDb', () => {
  it('refuses any file name other than risuai.db', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '__password'), 'x');
    expect(() => openSourceDb(path.join(dir, '__password'))).toThrow(/not allowed/);
    expect(() => openSourceDb(path.join(dir, 'logs.db'))).toThrow(/not allowed/);
    expect(() => openSourceDb(path.join(dir, 'risuai.db-wal'))).toThrow(/not allowed/);
  });

  it('opens read-only: reads work, any write throws', () => {
    const file = makeDb(tmp());
    const db = openSourceDb(file);
    expect(db.prepare('SELECT count(*) AS c FROM kv').get()).toEqual({ c: 1 });
    expect(() => db.exec("INSERT INTO kv VALUES('b', x'02')")).toThrow();
    expect(() => db.exec('CREATE TABLE t(x)')).toThrow();
    db.close();
  });
});

describe('retryBusy', () => {
  const busy = Object.assign(new Error('database is locked'), { errcode: 5 });

  it('recognises busy/locked error codes (including extended codes)', () => {
    expect(isBusyError(busy)).toBe(true);
    expect(isBusyError(Object.assign(new Error('x'), { errcode: 517 }))).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(isBusyError(Object.assign(new Error('x'), { errcode: 1 }))).toBe(false);
    expect(isBusyError(new Error('x'))).toBe(false);
  });

  it('retries with exponential backoff, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await retryBusy(
      () => { if (++calls < 3) throw busy; return 'ok'; },
      { baseMs: 10, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([10, 20]);
  });

  it('gives up after N attempts and rethrows', async () => {
    let calls = 0;
    await expect(retryBusy(() => { calls++; throw busy; }, { attempts: 3, sleep: async () => {} })).rejects.toBe(busy);
    expect(calls).toBe(3);
  });

  it('does not retry non-busy errors', async () => {
    let calls = 0;
    await expect(retryBusy(() => { calls++; throw new Error('boom'); }, { sleep: async () => {} })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
