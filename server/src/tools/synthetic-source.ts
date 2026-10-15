import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { vendor } from '../source/pocketrisu/vendor.js';

export type Tuple = [string, string, string?];
export type SynMsg = { role: 'user' | 'char'; data: string; time?: number; [k: string]: unknown };
export type SynChat = { id: string; name: string; message: SynMsg[]; [k: string]: unknown };
export type SynChar = {
  chaId: string;
  name: string;
  chats: SynChat[];
  additionalAssets?: Tuple[];
  modules?: string[];
  [k: string]: unknown;
};
export type SynSpec = {
  characters: SynChar[];
  manifests?: { kind: 'character' | 'module'; ownerId: string; items: Tuple[] }[];
  assets?: Record<string, Uint8Array>; // kv key ('assets/xxx') → bytes
  cold?: Record<string, unknown>; // cold storage key → coldData (gzip JSON 로 저장)
  formatversion?: number;
};

// server.cjs:5854 — cold chat 은 message[0].data 가 이 헤더로 시작한다.
export const COLD_HEADER = 'COLDSTORAGE';
export const AM = (n: number) => `Alice.__am__.chat.${String(n).padStart(8, '0')}-2222-3333-4444-555555555555`;
export const PNG = (tag: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, tag]);

const MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export const msg = (role: 'user' | 'char', data: string, extra: Record<string, unknown> = {}): SynMsg => ({ role, data, ...extra });
export const chat = (id: string, texts: string[]): SynChat => ({
  id,
  name: `chat-${id}`,
  message: texts.map((t, i) => msg(i % 2 === 0 ? 'user' : 'char', t)),
});

export function baseSpec(): SynSpec {
  return {
    characters: [
      { chaId: 'c1', name: 'Alice', chats: [chat('a1', ['u1', 'm1', 'u2', 'm2']), chat('a2', ['x1', 'y1'])] },
      { chaId: 'c2', name: 'Bob', chats: [chat('b1', ['hello'])] },
    ],
  };
}

function putChunked(db: DatabaseSync, key: string, bytes: Uint8Array, size = 4096) {
  db.prepare('INSERT OR REPLACE INTO kv(key,value,updated_at) VALUES(?,?,?)').run(key, MARKER, 1);
  let seq = 0;
  for (let off = 0; off < bytes.length; off += size) {
    const part = Buffer.from(bytes.subarray(off, off + size));
    const h = sha(part);
    db.prepare('INSERT OR IGNORE INTO chunks(hash,data) VALUES(?,?)').run(h, part);
    db.prepare('INSERT INTO manifest_chunks(manifest_key,seq,hash) VALUES(?,?,?)').run(key, seq++, h);
  }
}

/** spec 대로 dir/risuai.db 를 (원자적으로) 다시 만든다. 시나리오 변경 = 수정한 spec 으로 다시 호출. */
export function writeSource(dir: string, spec: SynSpec, opts: { corruptChunk?: boolean } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(dir, '.build-'));
  const tmpFile = path.join(tmpDir, 'risuai.db');
  const db = new DatabaseSync(tmpFile);
  db.exec(`
    CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER);
    CREATE TABLE chunks(hash TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE manifest_chunks(manifest_key TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(manifest_key, seq));
    CREATE TABLE asset_manifests(manifest_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, format_version INTEGER NOT NULL, item_count INTEGER NOT NULL, content_hash TEXT NOT NULL, raw_bytes INTEGER NOT NULL, payload BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE asset_manifest_live(owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, manifest_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_kind, owner_id));
  `);
  const bin = vendor.encodeRisuSaveLegacy({ formatversion: spec.formatversion ?? 5, characters: spec.characters, botPresets: [] });
  putChunked(db, 'database/database.bin', bin);
  for (const m of spec.manifests ?? []) {
    const raw = Buffer.from(JSON.stringify(m.items), 'utf8');
    const contentHash = sha(raw);
    const id = sha(`${m.kind}\0${m.ownerId}\0${contentHash}`);
    db.prepare('INSERT INTO asset_manifests VALUES(?,?,?,?,?,?,?,?,?)').run(id, m.kind, m.ownerId, 1, m.items.length, contentHash, raw.length, deflateRawSync(raw), 1);
    db.prepare('INSERT INTO asset_manifest_live VALUES(?,?,?,?)').run(m.kind, m.ownerId, id, 1);
  }
  for (const [k, bytes] of Object.entries(spec.assets ?? {})) {
    db.prepare('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)').run(k, Buffer.from(bytes), 2);
  }
  for (const [k, data] of Object.entries(spec.cold ?? {})) {
    db.prepare('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)').run(`coldstorage/${k}`, gzipSync(Buffer.from(JSON.stringify(data))), 3);
  }
  if (opts.corruptChunk) {
    db.exec("UPDATE chunks SET data = x'00' WHERE hash = (SELECT hash FROM manifest_chunks WHERE manifest_key='database/database.bin' AND seq=0)");
  }
  db.close();
  const final = path.join(dir, 'risuai.db');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(final + s, { force: true });
  fs.renameSync(tmpFile, final);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return final;
}

/** 유효한 1x1 PNG (브라우저가 실제로 디코드한다) */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
