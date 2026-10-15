// PocketRisu 가 쓰고 있는 동안(별도 연결이 쓰기 트랜잭션·WAL) PAGE 어댑터가 읽기 전용으로 읽을 수 있어야 한다 (Windows 파일 잠금).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers/harness.js';

describe('쓰는 중 읽기', () => {
  it('쓰기 연결이 열려 있어도 동기화가 된다', async () => {
    const h = makeHarness();
    const writer = new DatabaseSync(path.join(h.srcDir, 'risuai.db'));
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('BEGIN IMMEDIATE');
    // 커밋하지 않은 실제 쓰기 (합성 kv 행). 읽기 쪽은 커밋된 내용만 본다
    writer.prepare('INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?)').run('page-test/uncommitted', Buffer.from([0]), 2);
    try {
      const r = await h.sync();
      expect(r.outcome).toBe('synced');
      expect(r.errors).toBe(0);
      expect(r.chats.created).toBeGreaterThan(0);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      h.store.close();
    }
  });
});
