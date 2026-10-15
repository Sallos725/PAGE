import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertImported } from '../import/constants.js';

export type ReadingPosition = { msgIdx: number; blockIdx: number; charOffset: number; anchorHash: string };
export type BookmarkKind = 'bookmark' | 'highlight';
export type Bookmark = {
  id: string; kind: BookmarkKind; start: ReadingPosition; end: ReadingPosition | null;
  note: string; color: string; text: string; createdAt: number;
};
export type NewBookmark = Omit<Bookmark, 'id' | 'createdAt'>;
export type AliasKind = 'char' | 'chat';
export type HideRuleScope = 'global' | 'char';
export type HideRule = {
  id: string; scope: HideRuleScope; charId: string; name: string; pattern: string; flags: string;
  enabled: boolean; origin: 'manual' | 'card'; createdAt: number; updatedAt: number;
};
export type NewHideRule = Omit<HideRule, 'id' | 'createdAt' | 'updatedAt'>;
export type HideRulePatch = Partial<Pick<HideRule, 'name' | 'pattern' | 'flags' | 'enabled'>>;

// 스펙 5.2 (positions 는 char_id 를 키에 포함 — 단계 2A 결정).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS positions(
  source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  pos_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source, char_id, chat_id));
CREATE TABLE IF NOT EXISTS bookmarks(
  id TEXT PRIMARY KEY, source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  start_json TEXT NOT NULL, end_json TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('bookmark','highlight')),
  note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bookmarks_chat ON bookmarks(source, char_id, chat_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aliases(
  source TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('char','chat')),
  char_id TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source, kind, char_id, chat_id));
CREATE TABLE IF NOT EXISTS hide_rules(
  id TEXT PRIMARY KEY, source TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('global','char')), char_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, pattern TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL CHECK(origin IN ('manual','card')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hide_rules_src ON hide_rules(source, scope, char_id);
CREATE TABLE IF NOT EXISTS image_rules_off(
  source TEXT NOT NULL, char_id TEXT NOT NULL, rule_key TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source, char_id, rule_key));
CREATE TABLE IF NOT EXISTS kept_chats(
  source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL, kept_at INTEGER NOT NULL,
  PRIMARY KEY(source, char_id, chat_id));
`;

/** 보관 맵의 키. id 에 어떤 글자가 와도 겹치지 않게 NUL 로 잇는다. */
export const keptKey = (charId: string, chatId: string): string => `${charId}\u0000${chatId}`;

/** 사용자 상태(위치·북마크·설정). 라이브러리와 파일을 분리한다 — 둘 다 재생성 불가, 백업 대상. */
export class StateStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* 마운트 루트 등 권한이 없으면 무시 */ }
    this.db = new DatabaseSync(path.join(dir, 'state.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    // 형광펜 모아 보기: 문장 미리보기 열 (옛 DB 에는 없다 — 있으면 그대로).
    const cols = this.db.prepare('PRAGMA table_info(bookmarks)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'text')) this.db.exec("ALTER TABLE bookmarks ADD COLUMN text TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_kind ON bookmarks(kind, created_at)');
  }

  close() { this.db.close(); }

  getPosition(source: string, charId: string, chatId: string): { position: ReadingPosition; updatedAt: number } | null {
    const r = this.db
      .prepare('SELECT pos_json AS p, updated_at AS u FROM positions WHERE source = ? AND char_id = ? AND chat_id = ?')
      .get(source, charId, chatId) as { p: string; u: number } | undefined;
    return r ? { position: JSON.parse(r.p) as ReadingPosition, updatedAt: r.u } : null;
  }

  putPosition(source: string, charId: string, chatId: string, pos: ReadingPosition, now: number) {
    this.db
      .prepare(
        `INSERT INTO positions(source,char_id,chat_id,pos_json,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(source,char_id,chat_id) DO UPDATE SET pos_json = excluded.pos_json, updated_at = excluded.updated_at`,
      )
      .run(source, charId, chatId, JSON.stringify(pos), now);
  }

  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json AS v FROM settings').all() as { key: string; v: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.v) as unknown]));
  }

  putSettings(entries: Record<string, unknown>, now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      );
      for (const [k, v] of Object.entries(entries)) stmt.run(k, JSON.stringify(v), now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── 책갈피 · 하이라이트 (스펙 5.2 bookmarks). 삽입 순서(rowid)로 돌려준다.
  listBookmarks(source: string, charId: string, chatId: string): Bookmark[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, start_json AS s, end_json AS e, note, color, text, created_at AS c FROM bookmarks
         WHERE source = ? AND char_id = ? AND chat_id = ? ORDER BY created_at, rowid`,
      )
      .all(source, charId, chatId) as { id: string; kind: string; s: string; e: string | null; note: string; color: string; text: string; c: number }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as BookmarkKind,
      start: JSON.parse(r.s) as ReadingPosition,
      end: r.e ? (JSON.parse(r.e) as ReadingPosition) : null,
      note: r.note,
      color: r.color,
      text: r.text,
      createdAt: r.c,
    }));
  }

  countBookmarks(source: string, charId: string, chatId: string): number {
    const r = this.db.prepare('SELECT count(*) AS n FROM bookmarks WHERE source = ? AND char_id = ? AND chat_id = ?').get(source, charId, chatId) as { n: number };
    return r.n;
  }

  addBookmark(source: string, charId: string, chatId: string, b: NewBookmark, now: number): Bookmark {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO bookmarks(id,source,char_id,chat_id,start_json,end_json,kind,note,color,text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, source, charId, chatId, JSON.stringify(b.start), b.end ? JSON.stringify(b.end) : null, b.kind, b.note, b.color, b.text, now);
    return { id, kind: b.kind, start: b.start, end: b.end, note: b.note, color: b.color, text: b.text, createdAt: now };
  }

  /** 해당 채팅 범위 안에서만 지운다 (다른 채팅의 id 를 알아도 지우지 못한다). */
  deleteBookmark(source: string, charId: string, chatId: string, id: string): boolean {
    const r = this.db.prepare('DELETE FROM bookmarks WHERE id = ? AND source = ? AND char_id = ? AND chat_id = ?').run(id, source, charId, chatId);
    return Number(r.changes) > 0;
  }

  /** 문장 미리보기만 바꾼다. 해당 채팅 범위 안에서만. */
  setBookmarkText(source: string, charId: string, chatId: string, id: string, text: string): boolean {
    const r = this.db.prepare('UPDATE bookmarks SET text = ? WHERE id = ? AND source = ? AND char_id = ? AND chat_id = ?').run(text, id, source, charId, chatId);
    return Number(r.changes) > 0;
  }

  /** 모든 채팅의 형광펜, 최신 순. limit+1 개를 읽어 더 있는지 알린다. */
  listAllHighlights(limit: number): { rows: (Bookmark & { source: string; charId: string; chatId: string })[]; hasMore: boolean } {
    const rows = this.db.prepare(
      `SELECT id, source, char_id AS ch, chat_id AS c, start_json AS s, end_json AS e, note, color, text, created_at AS t
       FROM bookmarks WHERE kind = 'highlight' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(limit + 1) as { id: string; source: string; ch: string; c: string; s: string; e: string | null; note: string; color: string; text: string; t: number }[];
    return {
      hasMore: rows.length > limit,
      rows: rows.slice(0, limit).map((r) => ({
        id: r.id, source: r.source, charId: r.ch, chatId: r.c, kind: 'highlight' as const,
        start: JSON.parse(r.s) as ReadingPosition, end: r.e ? (JSON.parse(r.e) as ReadingPosition) : null,
        note: r.note, color: r.color, text: r.text, createdAt: r.t,
      })),
    };
  }

  // ── 표시 이름 (스펙 §5.1). kind='char' 면 chat_id 는 ''.
  setAlias(source: string, kind: AliasKind, charId: string, chatId: string, name: string, now: number) {
    this.db
      .prepare(
        `INSERT INTO aliases(source,kind,char_id,chat_id,name,updated_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(source,kind,char_id,chat_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(source, kind, charId, chatId, name, now);
  }

  deleteAlias(source: string, kind: AliasKind, charId: string, chatId: string): boolean {
    const r = this.db.prepare('DELETE FROM aliases WHERE source = ? AND kind = ? AND char_id = ? AND chat_id = ?').run(source, kind, charId, chatId);
    return Number(r.changes) > 0;
  }

  /** kind='char': charId → 이름. kind='chat': 해당 캐릭터의 chatId → 이름. */
  aliasMap(source: string, kind: AliasKind, charId?: string): Map<string, string> {
    const rows = kind === 'char'
      ? (this.db.prepare("SELECT char_id AS k, name FROM aliases WHERE source = ? AND kind = 'char'").all(source) as { k: string; name: string }[])
      : (this.db.prepare("SELECT chat_id AS k, name FROM aliases WHERE source = ? AND kind = 'chat' AND char_id = ?").all(source, charId ?? '') as { k: string; name: string }[]);
    return new Map(rows.map((r) => [r.k, r.name]));
  }

  // ── 숨김 규칙 (스펙 §5.2). 검증은 호출자(API)가 한다.
  private static ruleOf(r: Record<string, unknown>): HideRule {
    return {
      id: r.id as string, scope: r.scope as HideRuleScope, charId: r.char_id as string, name: r.name as string,
      pattern: r.pattern as string, flags: r.flags as string, enabled: r.enabled === 1, origin: r.origin as HideRule['origin'],
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }

  listHideRules(source: string, charId: string): HideRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hide_rules WHERE source = ? AND (scope = 'global' OR (scope = 'char' AND char_id = ?))
         ORDER BY created_at, rowid`,
      )
      .all(source, charId) as Record<string, unknown>[];
    return rows.map(StateStore.ruleOf);
  }

  getHideRule(source: string, id: string): HideRule | null {
    const r = this.db.prepare('SELECT * FROM hide_rules WHERE source = ? AND id = ?').get(source, id) as Record<string, unknown> | undefined;
    return r ? StateStore.ruleOf(r) : null;
  }

  countHideRules(source: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM hide_rules WHERE source = ?').get(source) as { n: number }).n;
  }

  addHideRule(source: string, r: NewHideRule, now: number): HideRule {
    const id = randomUUID();
    const charId = r.scope === 'char' ? r.charId : '';
    this.db
      .prepare('INSERT INTO hide_rules(id,source,scope,char_id,name,pattern,flags,enabled,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, source, r.scope, charId, r.name, r.pattern, r.flags, r.enabled ? 1 : 0, r.origin, now, now);
    return { ...r, charId, id, createdAt: now, updatedAt: now };
  }

  updateHideRule(source: string, id: string, patch: HideRulePatch, now: number): HideRule | null {
    const cur = this.getHideRule(source, id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: now };
    this.db
      .prepare('UPDATE hide_rules SET name = ?, pattern = ?, flags = ?, enabled = ?, updated_at = ? WHERE source = ? AND id = ?')
      .run(next.name, next.pattern, next.flags, next.enabled ? 1 : 0, now, source, id);
    return next;
  }

  deleteHideRule(source: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM hide_rules WHERE source = ? AND id = ?').run(source, id).changes) > 0;
  }

  // ── 서고 화면용 위치 조회
  positionsForChar(source: string, charId: string): Map<string, { position: ReadingPosition; updatedAt: number }> {
    const rows = this.db
      .prepare('SELECT chat_id AS c, pos_json AS p, updated_at AS u FROM positions WHERE source = ? AND char_id = ?')
      .all(source, charId) as { c: string; p: string; u: number }[];
    return new Map(rows.map((r) => [r.c, { position: JSON.parse(r.p) as ReadingPosition, updatedAt: r.u }]));
  }

  recentPositions(limit: number): { source: string; charId: string; chatId: string; position: ReadingPosition; updatedAt: number }[] {
    const rows = this.db
      .prepare('SELECT source AS s, char_id AS ch, chat_id AS c, pos_json AS p, updated_at AS u FROM positions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as { s: string; ch: string; c: string; p: string; u: number }[];
    return rows.map((r) => ({ source: r.s, charId: r.ch, chatId: r.c, position: JSON.parse(r.p) as ReadingPosition, updatedAt: r.u }));
  }

  // ── 카드 그림 규칙 끄기 (스펙 3C §3.4). 기본은 켜짐 — 꺼진 key 만 둔다.
  imageRulesOff(source: string, charId: string): Set<string> {
    const rows = this.db.prepare('SELECT rule_key AS k FROM image_rules_off WHERE source = ? AND char_id = ?').all(source, charId) as { k: string }[];
    return new Set(rows.map((r) => r.k));
  }
  setImageRuleEnabled(source: string, charId: string, key: string, enabled: boolean, now: number) {
    if (enabled) this.db.prepare('DELETE FROM image_rules_off WHERE source = ? AND char_id = ? AND rule_key = ?').run(source, charId, key);
    else this.db.prepare('INSERT OR REPLACE INTO image_rules_off(source,char_id,rule_key,updated_at) VALUES(?,?,?,?)').run(source, charId, key, now);
  }

  /** 가져온 채팅 완전히 지우기 — 그 채팅의 사용자 상태 (임포트 스펙 §5-5). 형광펜 문장(bookmarks.text)도 같이 지워진다. */
  purgeChatState(source: string, charId: string, chatId: string) {
    assertImported(source);
    this.secureTx(() => {
      for (const t of ['positions', 'bookmarks', 'kept_chats']) this.db.prepare(`DELETE FROM ${t} WHERE source = ? AND char_id = ? AND chat_id = ?`).run(source, charId, chatId);
      this.db.prepare("DELETE FROM aliases WHERE source = ? AND kind = 'chat' AND char_id = ? AND chat_id = ?").run(source, charId, chatId);
    });
  }

  /** 캐릭터 단위: 위치·책갈피·별칭·보관·카드 그림 규칙 끔 + 캐릭터 범위 숨김 규칙. 전역 규칙과 설정은 건드리지 않는다. */
  purgeCharState(source: string, charId: string) {
    assertImported(source);
    this.secureTx(() => {
      for (const t of ['positions', 'bookmarks', 'kept_chats', 'aliases', 'image_rules_off']) this.db.prepare(`DELETE FROM ${t} WHERE source = ? AND char_id = ?`).run(source, charId);
      this.db.prepare("DELETE FROM hide_rules WHERE source = ? AND scope = 'char' AND char_id = ?").run(source, charId);
    });
  }

  /** WAL 을 원본 DB 파일로 내리고 비운다 (secure_delete 로 지운 글자가 -wal 에 남지 않게). */
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }

  private secureTx(fn: () => void) {
    this.db.exec('PRAGMA secure_delete = ON');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } finally { this.db.exec('PRAGMA secure_delete = OFF'); }
  }

  // ── 보관 (스펙 3D E3). 보관한 채팅만 둔다. 값 = 보관한 시각.
  keptMap(source: string, charId?: string): Map<string, number> {
    const rows = (charId === undefined
      ? this.db.prepare('SELECT char_id AS ch, chat_id AS c, kept_at AS t FROM kept_chats WHERE source = ?').all(source)
      : this.db.prepare('SELECT char_id AS ch, chat_id AS c, kept_at AS t FROM kept_chats WHERE source = ? AND char_id = ?').all(source, charId)
    ) as { ch: string; c: string; t: number }[];
    return new Map(rows.map((r) => [keptKey(r.ch, r.c), r.t]));
  }
  setKept(source: string, charId: string, chatId: string, kept: boolean, now: number) {
    // 이미 보관한 채팅을 다시 보관해도 kept_at 은 그대로 (보관함은 보관 시각 순).
    if (kept) this.db.prepare('INSERT INTO kept_chats(source,char_id,chat_id,kept_at) VALUES(?,?,?,?) ON CONFLICT(source,char_id,chat_id) DO NOTHING').run(source, charId, chatId, now);
    else this.db.prepare('DELETE FROM kept_chats WHERE source = ? AND char_id = ? AND chat_id = ?').run(source, charId, chatId);
  }
}
