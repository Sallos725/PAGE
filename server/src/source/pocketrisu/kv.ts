import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// chunkStore.cjs:47 와 같은 13바이트 마커.
export const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export class ChunkIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkIntegrityError';
  }
}

type ValueRow = { value: Uint8Array };

// kv 값 읽기. 마커면 manifest_chunks(seq 순) → chunks 이어붙임, 청크마다 sha256 검증.
// 매니페스트·청크 조회는 하나의 read 트랜잭션 (storage-notes 6.4). 바이트를 모은 직후 트랜잭션을 닫는다.
export function readKv(db: DatabaseSync, key: string, opts: { verify?: boolean } = {}): Buffer | null {
  const verify = opts.verify ?? true;
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as ValueRow | undefined;
    if (!row) return null;
    const v = Buffer.from(row.value);
    if (!v.equals(CHUNK_MARKER)) return v;
    const rows = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(key) as { hash: string }[];
    if (rows.length === 0) return v;
    const sel = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const parts = rows.map(({ hash }) => {
      const r = sel.get(hash) as { data: Uint8Array } | undefined;
      if (!r) throw new ChunkIntegrityError('missing chunk');
      const d = Buffer.from(r.data);
      if (verify && sha256(d) !== hash) throw new ChunkIntegrityError('chunk hash mismatch');
      return d;
    });
    return Buffer.concat(parts);
  } finally {
    db.exec('ROLLBACK');
  }
}

// 앞 n 바이트만 (헤더 판별용). 청크 하나만 읽는다.
export function peekKv(db: DatabaseSync, key: string, n: number): Buffer | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as ValueRow | undefined;
  if (!row) return null;
  const v = Buffer.from(row.value);
  if (!v.equals(CHUNK_MARKER)) return v.subarray(0, n);
  const first = db
    .prepare('SELECT c.data AS data FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ? AND m.seq = 0')
    .get(key) as { data: Uint8Array } | undefined;
  return first ? Buffer.from(first.data).subarray(0, n) : null;
}

// 값을 읽지 않고 내용 지문을 만든다: 청크는 내용 주소(sha256)이므로 청크 해시열이 곧 내용 정체성.
export function fingerprintKv(db: DatabaseSync, key: string): string | null {
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as ValueRow | undefined;
    if (!row) return null;
    const v = Buffer.from(row.value);
    if (!v.equals(CHUNK_MARKER)) return sha256(v);
    const rows = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').all(key) as { hash: string }[];
    if (rows.length === 0) return sha256(v);
    return sha256(Buffer.from(rows.map((r) => r.hash).join(',')));
  } finally {
    db.exec('ROLLBACK');
  }
}
