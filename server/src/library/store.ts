import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assertImported } from '../import/constants.js';
import { SCHEMA_SQL } from './schema.js';
import { withRetry } from '../util/fs-retry.js';

type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

export type Reason = 'initial' | 'appended' | 'edited' | 'deleted-marker';
export type AssetStatus = 'ok' | 'unresolved' | 'deferred';

export type ChatRow = {
  source: string; charId: string; chatId: string; title: string;
  firstSeen: number; lastSeen: number; deletedAt: number | null;
  headVersion: number | null; srcFingerprint: string | null;
  lastDate: number | null; pendingFp: string | null; pendingSince: number | null; lastError: string | null;
};
export type VersionRow = {
  versionId: number; source: string; charId: string; chatId: string;
  createdAt: number; msgCount: number; manifestHash: string; metaJson: string; reason: Reason;
};
export type AssetRefRow = { ref: string; hash: string | null; status: AssetStatus };

const CHAT_COLS = `source, char_id AS charId, chat_id AS chatId, title, first_seen AS firstSeen, last_seen AS lastSeen,
  deleted_at AS deletedAt, head_version AS headVersion, src_fingerprint AS srcFingerprint, last_date AS lastDate,
  pending_fp AS pendingFp, pending_since AS pendingSince, last_error AS lastError`;
const VERSION_COLS = `version_id AS versionId, source, char_id AS charId, chat_id AS chatId, created_at AS createdAt,
  msg_count AS msgCount, manifest_hash AS manifestHash, meta_json AS metaJson, reason`;

export class LibraryStore {
  readonly db: DatabaseSync;
  private readonly libDir: string;
  private readonly blobsDir: string;

  constructor(dataDir: string) {
    this.libDir = path.join(dataDir, 'library');
    this.blobsDir = path.join(this.libDir, 'blobs');
    fs.mkdirSync(this.blobsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.libDir, 0o700); } catch { /* 마운트 루트 등 권한이 없으면 무시 */ }
    this.db = new DatabaseSync(path.join(this.libDir, 'library.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA_SQL);
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 가져온 채팅 완전히 지우기 (임포트 스펙 §5). 다른 버전·캐릭터가 쓰는 매니페스트·메시지·그림은 남긴다. 반복해도 안전하다. */
  purgeChat(source: string, charId: string, chatId: string): void {
    assertImported(source);
    const assets = new Set<string>();
    this.withSecureDelete(() => this.tx(() => this.purgeChatsIn(source, charId, [chatId], assets)));
    this.dropUnusedAssets(assets);
  }

  /** 캐릭터와 그 채팅 전부. 매니페스트 후보는 한 트랜잭션에서 모아 한 번만 스캔한다. */
  purgeChar(source: string, charId: string): void {
    assertImported(source);
    const img = this.getCharImage(source, charId);
    const assets = new Set<string>(img?.hash ? [img.hash] : []);
    this.withSecureDelete(() => this.tx(() => {
      const ids = new Set([
        ...this.all<{ c: string }>('SELECT chat_id AS c FROM lib_chats WHERE source = ? AND char_id = ?', source, charId).map((r) => r.c),
        ...this.all<{ c: string }>('SELECT DISTINCT chat_id AS c FROM lib_versions WHERE source = ? AND char_id = ?', source, charId).map((r) => r.c),
      ]);
      this.purgeChatsIn(source, charId, [...ids], assets);
      this.run('DELETE FROM lib_char_images WHERE source = ? AND char_id = ?', source, charId);
      this.run('DELETE FROM lib_image_rule_slow WHERE source = ? AND char_id = ?', source, charId);
      this.run('DELETE FROM lib_chars WHERE source = ? AND char_id = ?', source, charId);
    }));
    this.dropUnusedAssets(assets);
  }

  /** 트랜잭션 안에서: 채팅들의 버전·채팅 행을 지우고, 더 이상 안 쓰이는 매니페스트·메시지를 지운다. 그림 후보는 assets 에 모은다. */
  private purgeChatsIn(source: string, charId: string, chatIds: string[], assets: Set<string>) {
    const manifests = new Set<string>();
    for (const chatId of chatIds) {
      const vers = this.all<{ v: number; m: string }>('SELECT version_id AS v, manifest_hash AS m FROM lib_versions WHERE source = ? AND char_id = ? AND chat_id = ?', source, charId, chatId);
      for (const { v, m } of vers) {
        manifests.add(m);
        for (const a of this.all<{ h: string | null }>('SELECT asset_hash AS h FROM lib_version_assets WHERE version_id = ?', v)) if (a.h) assets.add(a.h);
        this.run('DELETE FROM lib_version_assets WHERE version_id = ?', v);
      }
      this.run('DELETE FROM lib_versions WHERE source = ? AND char_id = ? AND chat_id = ?', source, charId, chatId);
      this.run('DELETE FROM lib_chats WHERE source = ? AND char_id = ? AND chat_id = ?', source, charId, chatId);
    }
    const msgCandidates = new Set<string>();
    for (const m of manifests) {
      if (this.get('SELECT 1 AS x FROM lib_versions WHERE manifest_hash = ?', m)) continue; // 다른 버전이 아직 쓴다
      for (const h of this.getManifest(m) ?? []) msgCandidates.add(h);
      this.run('DELETE FROM lib_manifests WHERE manifest_hash = ?', m);
    }
    if (msgCandidates.size === 0) return;
    const still = new Set<string>();
    for (const { m } of this.all<{ m: string }>('SELECT manifest_hash AS m FROM lib_manifests')) for (const h of this.getManifest(m) ?? []) if (msgCandidates.has(h)) still.add(h);
    for (const h of msgCandidates) if (!still.has(h)) this.run('DELETE FROM lib_msgs WHERE msg_hash = ?', h);
  }

  /**
   * 후보 중 어디에서도 안 쓰는 그림만 지운다 (전체 GC 가 아니다 — 동시에 도는 동기화가 막 넣은 그림을 건드리지 않게).
   * 판정~삭제 사이에 await 가 없다(Node 는 한 스레드라 이 구간에 다른 동기화가 끼어들 수 없다. Syncer 의 hasAsset~참조 쓰기 구간도 마찬가지 — 거기에 await 를 넣지 말 것).
   * 행을 지운 뒤 파일 삭제가 실패하면 고아 blob 이 남을 수 있다 (같은 내용이 다시 들어오면 덮어쓴다).
   */
  dropUnusedAssets(candidates: Set<string>) {
    for (const h of candidates) {
      if (this.get('SELECT 1 AS x FROM lib_version_assets WHERE asset_hash = ?', h)) continue;
      if (this.get('SELECT 1 AS x FROM lib_char_images WHERE asset_hash = ?', h)) continue;
      this.withSecureDelete(() => this.run('DELETE FROM lib_assets WHERE asset_hash = ?', h));
      try { withRetry(() => fs.rmSync(this.blobPath(h), { force: true })); } catch { /* 행은 이미 지웠다. 고아 blob 은 남겨 둔다 (위 계약) */ }
    }
  }

  /** WAL 을 원본 DB 파일로 내리고 비운다 (secure_delete 로 지운 글자가 -wal 에 남지 않게). */
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }

  private withSecureDelete<T>(fn: () => T): T {
    this.db.exec('PRAGMA secure_delete = ON');
    try { return fn(); } finally { this.db.exec('PRAGMA secure_delete = OFF'); }
  }

  private get<T>(sql: string, ...p: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...p) as T | undefined; }
  private all<T>(sql: string, ...p: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...p) as T[]; }
  private run(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).run(...p); }

  // ── 동기화 상태
  getState(source: string, key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM lib_sync_state WHERE source = ? AND key = ?', source, key)?.value ?? null;
  }
  setState(source: string, key: string, value: string) {
    this.run('INSERT INTO lib_sync_state(source,key,value) VALUES(?,?,?) ON CONFLICT(source,key) DO UPDATE SET value = excluded.value', source, key, value);
  }
  /** 대기 중인 디바운스나 이월(deferred)된 에셋이 있으면 소스 지문이 같아도 동기화를 건너뛰면 안 된다. */
  hasPendingOrDeferred(source: string): boolean {
    if (this.get('SELECT 1 AS x FROM lib_chats WHERE source = ? AND pending_fp IS NOT NULL LIMIT 1', source)) return true;
    return !!this.get(
      `SELECT 1 AS x FROM lib_version_assets va JOIN lib_chats c ON c.head_version = va.version_id
       WHERE c.source = ? AND va.status = 'deferred' LIMIT 1`, source);
  }

  // ── 캐릭터
  upsertChar(source: string, charId: string, name: string, metaJson: string, now: number) {
    this.run(
      `INSERT INTO lib_chars(source,char_id,name,meta_json,first_seen,last_seen,deleted_at) VALUES(?,?,?,?,?,?,NULL)
       ON CONFLICT(source,char_id) DO UPDATE SET name = excluded.name, meta_json = excluded.meta_json, last_seen = excluded.last_seen, deleted_at = NULL`,
      source, charId, name, metaJson, now, now);
  }
  getCharMeta(source: string, charId: string): Record<string, unknown> | null {
    const r = this.get<{ m: string }>('SELECT meta_json AS m FROM lib_chars WHERE source = ? AND char_id = ?', source, charId);
    return r ? (JSON.parse(r.m) as Record<string, unknown>) : null;
  }
  // ── 캐릭터 대표 이미지 (D27). asset_hash 가 null 이면 아직 못 가져옴(없음·용량 보류).
  getCharImage(source: string, charId: string): { ref: string; hash: string | null } | null {
    return this.get<{ ref: string; hash: string | null }>(
      'SELECT image_ref AS ref, asset_hash AS hash FROM lib_char_images WHERE source = ? AND char_id = ?', source, charId) ?? null;
  }
  setCharImage(source: string, charId: string, ref: string, hash: string | null) {
    this.run(
      `INSERT INTO lib_char_images(source,char_id,image_ref,asset_hash) VALUES(?,?,?,?)
       ON CONFLICT(source,char_id) DO UPDATE SET image_ref = excluded.image_ref, asset_hash = excluded.asset_hash`,
      source, charId, ref, hash);
  }
  clearCharImage(source: string, charId: string) {
    this.run('DELETE FROM lib_char_images WHERE source = ? AND char_id = ?', source, charId);
  }
  getCharName(source: string, charId: string): string | null {
    return this.get<{ n: string }>('SELECT name AS n FROM lib_chars WHERE source = ? AND char_id = ?', source, charId)?.n ?? null;
  }
  // ── 카드 그림 규칙: 시간 제한을 넘긴 캐릭터의 규칙 key (스펙 3C §3.3)
  imageRulesSlow(source: string, charId: string): Set<string> {
    return new Set(this.all<{ k: string }>('SELECT rule_key AS k FROM lib_image_rule_slow WHERE source = ? AND char_id = ?', source, charId).map((r) => r.k));
  }
  setImageRulesSlow(source: string, charId: string, keys: string[]) {
    this.run('DELETE FROM lib_image_rule_slow WHERE source = ? AND char_id = ?', source, charId);
    for (const k of keys) this.run('INSERT OR IGNORE INTO lib_image_rule_slow(source,char_id,rule_key) VALUES(?,?,?)', source, charId, k);
  }
  liveCharIds(source: string): string[] {
    return this.all<{ id: string }>('SELECT char_id AS id FROM lib_chars WHERE source = ? AND deleted_at IS NULL', source).map((r) => r.id);
  }
  tombstoneChars(source: string, charIds: string[], now: number) {
    for (const id of charIds) {
      this.run('UPDATE lib_chars SET deleted_at = ? WHERE source = ? AND char_id = ? AND deleted_at IS NULL', now, source, id);
      this.run('UPDATE lib_chats SET deleted_at = ? WHERE source = ? AND char_id = ? AND deleted_at IS NULL', now, source, id);
    }
  }
  listChars(source: string, includeDeleted: boolean) {
    const inc = includeDeleted ? 1 : 0;
    return this.all<{ charId: string; name: string; deletedAt: number | null; chatCount: number }>(
      `SELECT c.char_id AS charId, c.name AS name, c.deleted_at AS deletedAt,
         (SELECT count(*) FROM lib_chats h WHERE h.source = c.source AND h.char_id = c.char_id AND (? = 1 OR h.deleted_at IS NULL)) AS chatCount
       FROM lib_chars c WHERE c.source = ? AND (? = 1 OR c.deleted_at IS NULL) ORDER BY c.name, c.char_id`, inc, source, inc,
    ).map((r) => ({ charId: r.charId, name: r.name, deleted: r.deletedAt !== null, chatCount: r.chatCount }));
  }

  // ── 채팅
  getChat(source: string, charId: string, chatId: string): ChatRow | null {
    return this.get<ChatRow>(`SELECT ${CHAT_COLS} FROM lib_chats WHERE source = ? AND char_id = ? AND chat_id = ?`, source, charId, chatId) ?? null;
  }
  ensureChat(source: string, charId: string, chatId: string, title: string, now: number) {
    this.run(
      `INSERT INTO lib_chats(source,char_id,chat_id,title,first_seen,last_seen) VALUES(?,?,?,?,?,?)
       ON CONFLICT(source,char_id,chat_id) DO UPDATE SET title = excluded.title, last_seen = excluded.last_seen, deleted_at = NULL`,
      source, charId, chatId, title, now, now);
  }
  liveChatKeys(source: string): { charId: string; chatId: string }[] {
    return this.all<{ charId: string; chatId: string }>('SELECT char_id AS charId, chat_id AS chatId FROM lib_chats WHERE source = ? AND deleted_at IS NULL', source);
  }
  tombstoneChats(source: string, items: { charId: string; chatId: string }[], now: number) {
    for (const it of items) {
      this.run('UPDATE lib_chats SET deleted_at = ? WHERE source = ? AND char_id = ? AND chat_id = ? AND deleted_at IS NULL', now, source, it.charId, it.chatId);
    }
  }
  updateChatState(source: string, charId: string, chatId: string, s: { lastDate?: number | null; pending?: { fp: string; since: number } | null; fingerprint: string }) {
    this.run(
      `UPDATE lib_chats SET last_date = ?, pending_fp = ?, pending_since = ?, last_error = NULL, src_fingerprint = ?
       WHERE source = ? AND char_id = ? AND chat_id = ?`,
      s.lastDate ?? null, s.pending?.fp ?? null, s.pending?.since ?? null, s.fingerprint, source, charId, chatId);
  }
  /** 읽을 수 없는 채팅의 사유만 남긴다. 기존 사본은 건드리지 않고, 없는 채팅은 만들지 않는다. */
  markChatError(source: string, charId: string, chatId: string, reason: string) {
    this.run('UPDATE lib_chats SET last_error = ? WHERE source = ? AND char_id = ? AND chat_id = ?', reason, source, charId, chatId);
  }
  listChats(source: string, charId: string, includeDeleted: boolean) {
    return this.all<{ chatId: string; title: string; deletedAt: number | null; headVersion: number | null; lastDate: number | null; lastError: string | null; msgCount: number | null }>(
      `SELECT h.chat_id AS chatId, h.title AS title, h.deleted_at AS deletedAt, h.head_version AS headVersion,
              h.last_date AS lastDate, h.last_error AS lastError, v.msg_count AS msgCount
       FROM lib_chats h LEFT JOIN lib_versions v ON v.version_id = h.head_version
       WHERE h.source = ? AND h.char_id = ? AND (? = 1 OR h.deleted_at IS NULL) ORDER BY h.first_seen, h.chat_id`,
      source, charId, includeDeleted ? 1 : 0,
    ).map((r) => ({ ...r, deleted: r.deletedAt !== null }));
  }

  // ── 메시지 · 매니페스트 · 버전
  putMsgs(entries: { hash: string; json: string }[]) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO lib_msgs(msg_hash, body) VALUES(?,?)');
    for (const e of entries) stmt.run(e.hash, gzipSync(Buffer.from(e.json, 'utf8')));
  }
  getMsgJson(hashes: string[]): string[] {
    const stmt = this.db.prepare('SELECT body FROM lib_msgs WHERE msg_hash = ?');
    return hashes.map((h) => {
      const r = stmt.get(h) as { body: Uint8Array } | undefined;
      if (!r) throw new Error('library message missing');
      return gunzipSync(Buffer.from(r.body)).toString('utf8');
    });
  }
  putManifest(hash: string, msgHashes: string[]) {
    this.run('INSERT OR IGNORE INTO lib_manifests(manifest_hash, msg_hashes) VALUES(?,?)', hash, Buffer.from(msgHashes.join('\n'), 'utf8'));
  }
  getManifest(hash: string): string[] | null {
    const r = this.get<{ b: Uint8Array }>('SELECT msg_hashes AS b FROM lib_manifests WHERE manifest_hash = ?', hash);
    if (!r) return null;
    const s = Buffer.from(r.b).toString('utf8');
    return s === '' ? [] : s.split('\n');
  }
  insertVersion(v: { source: string; charId: string; chatId: string; createdAt: number; msgCount: number; manifestHash: string; metaJson: string; reason: Reason }): number {
    const r = this.run(
      'INSERT INTO lib_versions(source,char_id,chat_id,created_at,msg_count,manifest_hash,meta_json,reason) VALUES(?,?,?,?,?,?,?,?)',
      v.source, v.charId, v.chatId, v.createdAt, v.msgCount, v.manifestHash, v.metaJson, v.reason);
    return Number(r.lastInsertRowid);
  }
  setHead(source: string, charId: string, chatId: string, versionId: number) {
    this.run('UPDATE lib_chats SET head_version = ? WHERE source = ? AND char_id = ? AND chat_id = ?', versionId, source, charId, chatId);
  }
  updateVersionMeta(versionId: number, metaJson: string) {
    this.run('UPDATE lib_versions SET meta_json = ? WHERE version_id = ?', metaJson, versionId);
  }
  getVersion(versionId: number): VersionRow | null {
    return this.get<VersionRow>(`SELECT ${VERSION_COLS} FROM lib_versions WHERE version_id = ?`, versionId) ?? null;
  }
  listVersions(source: string, charId: string, chatId: string): VersionRow[] {
    return this.all<VersionRow>(`SELECT ${VERSION_COLS} FROM lib_versions WHERE source = ? AND char_id = ? AND chat_id = ? ORDER BY version_id`, source, charId, chatId);
  }

  // ── 에셋
  blobPath(hash: string): string { return path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash); }
  hasAsset(hash: string): boolean { return !!this.get('SELECT 1 AS x FROM lib_assets WHERE asset_hash = ?', hash); }
  assetInfo(hash: string): { mime: string; size: number } | null {
    return this.get<{ mime: string; size: number }>('SELECT mime, size FROM lib_assets WHERE asset_hash = ?', hash) ?? null;
  }
  /** 파일을 먼저 (임시 파일 → rename) 쓰고 행을 넣는다. 크래시로 남는 고아 파일은 무해하다. */
  putAssetBlob(hash: string, mime: string, bytes: Uint8Array, now: number) {
    if (this.hasAsset(hash)) return;
    const p = this.blobPath(hash);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    withRetry(() => fs.renameSync(tmp, p)); // Windows: 백신·OneDrive 의 순간 잠금
    this.run('INSERT OR IGNORE INTO lib_assets(asset_hash, mime, size, first_seen) VALUES(?,?,?,?)', hash, mime, bytes.length, now);
  }
  setVersionAssets(versionId: number, rows: AssetRefRow[]) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO lib_version_assets(version_id, asset_ref, asset_hash, status) VALUES(?,?,?,?)');
    for (const r of rows) stmt.run(versionId, r.ref, r.hash, r.status);
  }
  getVersionAssets(versionId: number): AssetRefRow[] {
    return this.all<AssetRefRow>('SELECT asset_ref AS ref, asset_hash AS hash, status FROM lib_version_assets WHERE version_id = ? ORDER BY asset_ref', versionId);
  }
  updateVersionAsset(versionId: number, ref: string, hash: string | null, status: AssetStatus) {
    this.run('UPDATE lib_version_assets SET asset_hash = ?, status = ? WHERE version_id = ? AND asset_ref = ?', hash, status, versionId, ref);
  }
  /** 해당 캐릭터의 가장 최근 버전에서 이 이름이 가리키는 해시 */
  findAssetHash(source: string, charId: string, ref: string): string | null {
    return this.get<{ h: string }>(
      `SELECT va.asset_hash AS h FROM lib_version_assets va JOIN lib_versions v ON v.version_id = va.version_id
       WHERE v.source = ? AND v.char_id = ? AND va.asset_ref = ? AND va.asset_hash IS NOT NULL
       ORDER BY v.version_id DESC LIMIT 1`, source, charId, ref)?.h ?? null;
  }

  // ── 통계 (상태 API)
  stats(source: string) {
    const n = (sql: string, ...p: SQLInputValue[]) => this.get<{ c: number }>(sql, ...p)?.c ?? 0;
    return {
      chars: n('SELECT count(*) AS c FROM lib_chars WHERE source = ? AND deleted_at IS NULL', source),
      charsDeleted: n('SELECT count(*) AS c FROM lib_chars WHERE source = ? AND deleted_at IS NOT NULL', source),
      chats: n('SELECT count(*) AS c FROM lib_chats WHERE source = ? AND deleted_at IS NULL', source),
      chatsDeleted: n('SELECT count(*) AS c FROM lib_chats WHERE source = ? AND deleted_at IS NOT NULL', source),
      chatsUnreadable: n('SELECT count(*) AS c FROM lib_chats WHERE source = ? AND last_error IS NOT NULL', source),
      versions: n('SELECT count(*) AS c FROM lib_versions WHERE source = ?', source),
    };
  }
  /** 에셋 총량(전 소스 공통 — 내용 주소로 공유됨) */
  assetTotals(): { count: number; bytes: number } {
    const r = this.get<{ c: number; b: number }>('SELECT count(*) AS c, coalesce(sum(size),0) AS b FROM lib_assets');
    return { count: r?.c ?? 0, bytes: r?.b ?? 0 };
  }
  dbBytes(): number {
    let n = 0;
    for (const s of ['', '-wal']) { try { n += fs.statSync(path.join(this.libDir, `library.db${s}`)).size; } catch { /* 없음 */ } }
    return n;
  }
}
