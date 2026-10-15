import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// 스펙 3.3: 소스에서 열 수 있는 DB 는 risuai.db 하나뿐이다. -wal/-shm 은 SQLite 가 알아서 연다.
const SOURCE_DB_ALLOWLIST = new Set(['risuai.db']);

// 소스 DB 는 항상 mode=ro. immutable=1 은 WAL 을 무시하므로 쓰지 않는다 (findings §1).
export function openSourceDb(file: string): DatabaseSync {
  const abs = path.resolve(file);
  if (!SOURCE_DB_ALLOWLIST.has(path.basename(abs))) throw new Error('open not allowed for this file name');
  const url = pathToFileURL(abs);
  url.search = 'mode=ro';
  const db = new DatabaseSync(url.href);
  db.exec('PRAGMA query_only=ON');
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

// SQLITE_BUSY(5) / SQLITE_LOCKED(6), 확장 코드 포함 (하위 8비트).
export function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

export async function retryBusy<T>(
  fn: () => T | Promise<T>,
  o: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = o.attempts ?? 5;
  const base = o.baseMs ?? 50;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusyError(e) || i + 1 >= attempts) throw e;
      await sleep(base * 2 ** i);
    }
  }
}
