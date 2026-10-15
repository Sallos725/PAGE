import { gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { readKv } from './kv.js';

// cold chat 읽기 전용 복원 (findings §2.3). 서버의 readColdStorageJsonEntry(migrateLegacy) 는 kv 에 쓰기도 하므로 재사용하지 않는다.
// server.cjs:5854 COLD_STORAGE_HEADER, :2672 readColdStorageJsonEntry, :2645 parseColdStorageJsonBuffer
export const COLD_HEADER = 'COLDSTORAGE';

export function coldKeyOf(chat: unknown): string | null {
  const first = (chat as { message?: unknown[] } | null)?.message?.[0] as { data?: unknown } | undefined;
  const d = first?.data;
  return typeof d === 'string' && d.startsWith(COLD_HEADER) ? d.slice(COLD_HEADER.length) : null;
}

export type ColdResult =
  | { ok: true; messages: unknown[]; extra: Record<string, unknown> }
  | { ok: false; reason: string };

// 복원 시 서버가 chat 에 덮어쓰는 부가 필드 (server.cjs restoreColdStorageChat)
const EXTRA_KEYS = ['hypaV3Data', 'scriptstate', 'localLore'];

export function readColdChat(db: DatabaseSync, rawKey: string): ColdResult {
  const key = rawKey.endsWith('.json') ? rawKey.slice(0, -'.json'.length) : rawKey;
  if (!key || key.includes('/') || key === '.' || key === '..') return { ok: false, reason: 'invalid cold storage key' };
  const canonical = `coldstorage/${key}`;
  let buf = readKv(db, canonical);
  let legacy = false;
  if (!buf) {
    buf = readKv(db, `${canonical}.json`);
    legacy = true;
  }
  if (!buf) return { ok: false, reason: 'cold storage entry missing' };

  let data: unknown;
  try {
    data = JSON.parse(gunzipSync(buf).toString('utf8'));
  } catch {
    if (!legacy) return { ok: false, reason: 'cold storage entry unreadable' };
    try {
      data = JSON.parse(buf.toString('utf8')); // 레거시 .json 키는 평문일 수 있다
    } catch {
      return { ok: false, reason: 'cold storage entry unreadable' };
    }
  }
  if (Array.isArray(data)) return { ok: true, messages: data, extra: {} };
  const obj = data as { message?: unknown } | null;
  if (obj && typeof obj === 'object' && Array.isArray(obj.message)) {
    const extra: Record<string, unknown> = {};
    for (const k of EXTRA_KEYS) if (k in (obj as Record<string, unknown>)) extra[k] = (obj as Record<string, unknown>)[k];
    return { ok: true, messages: obj.message, extra };
  }
  return { ok: false, reason: 'cold storage entry has unknown shape' };
}
