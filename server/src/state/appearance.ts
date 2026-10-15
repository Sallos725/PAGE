// server/src/state/appearance.ts
// 커스텀 테마 프리셋과 글꼴 서재 (스펙 2.1, 3.1). state.db 를 같이 쓰고, 글꼴 파일은 page-data/fonts/ 에 둔다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { FONT_LIMITS, THEME_LIMITS, cssBytes, isFamily, isThemeBase, isThemeName, type ThemeBase, type ThemeFile } from '../shared/theme-file.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS themes(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  base TEXT NOT NULL CHECK(base IN ('light','dark','sepia')),
  css TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fonts(
  id TEXT PRIMARY KEY, family TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK(format IN ('woff2','ttf','otf')),
  size INTEGER NOT NULL, created_at INTEGER NOT NULL);
`;

export type ThemeMeta = { id: string; name: string; base: ThemeBase; updatedAt: number };
export type Theme = ThemeMeta & { css: string; createdAt: number };
export type ThemeError = 'bad-name' | 'too-large' | 'too-many';

type ThemeRow = { id: string; name: string; base: ThemeBase; css: string; c: number; u: number };
const toTheme = (r: ThemeRow): Theme => ({ id: r.id, name: r.name, base: r.base, css: r.css, createdAt: r.c, updatedAt: r.u });
export type FontFormat = 'woff2' | 'ttf' | 'otf';
export type FontMeta = { id: string; family: string; format: FontFormat; size: number; createdAt: number };
export type FontError = 'bad-family' | 'bad-font' | 'too-large' | 'too-many' | 'library-full' | 'family-taken';
type FontRow = { id: string; family: string; format: FontFormat; size: number; c: number };
const toFont = (r: FontRow): FontMeta => ({ id: r.id, family: r.family, format: r.format, size: r.size, createdAt: r.c });

/** 앞 4바이트로 형식을 정한다. 확장자·클라이언트 MIME 은 믿지 않는다. woff(1) 는 받지 않는다. */
export function sniffFont(buf: Uint8Array): FontFormat | null {
  if (buf.length < 12) return null;
  const tag = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0)) return 'ttf';
  return null;
}

const CSS_FORMAT: Record<FontFormat, string> = { woff2: 'woff2', ttf: 'truetype', otf: 'opentype' };
export const FONT_MIME: Record<FontFormat, string> = { woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };

/** 패밀리 이름은 isFamily 를 통과한 것뿐이라 따옴표 안에 그대로 넣어도 된다. */
export function fontsCss(fonts: FontMeta[]): string {
  return fonts.map((f) => `@font-face { font-family: "${f.family}"; src: url("/api/fonts/${f.id}") format("${CSS_FORMAT[f.format]}"); font-display: swap; }\n`).join('');
}

export const newId = (): string => randomBytes(16).toString('hex');

export class AppearanceStore {
  readonly fontDir: string;

  constructor(private readonly db: DatabaseSync, dataDir: string) {
    this.db.exec(SCHEMA);
    this.fontDir = path.join(dataDir, 'fonts');
    fs.mkdirSync(this.fontDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.fontDir, 0o700); } catch { /* 권한이 없으면 무시 */ }
  }

  // ── 테마
  listThemes(): ThemeMeta[] {
    const rows = this.db.prepare('SELECT id, name, base, updated_at AS u FROM themes ORDER BY created_at, rowid').all() as { id: string; name: string; base: ThemeBase; u: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, base: r.base, updatedAt: r.u }));
  }

  getTheme(id: string): Theme | null {
    const r = this.db.prepare('SELECT id, name, base, css, created_at AS c, updated_at AS u FROM themes WHERE id = ?').get(id) as ThemeRow | undefined;
    return r ? toTheme(r) : null;
  }

  private checkTheme(t: ThemeFile): ThemeError | null {
    if (typeof t.name !== 'string' || typeof t.css !== 'string') return 'bad-name';
    if (!isThemeName(t.name) || !isThemeBase(t.base)) return 'bad-name';
    if (cssBytes(t.css) > THEME_LIMITS.cssBytes) return 'too-large';
    return null;
  }

  createTheme(t: ThemeFile, now: number): Theme | ThemeError {
    const bad = this.checkTheme(t);
    if (bad) return bad;
    const n = (this.db.prepare('SELECT count(*) AS n FROM themes').get() as { n: number }).n;
    if (n >= THEME_LIMITS.maxThemes) return 'too-many';
    const id = newId();
    this.db.prepare('INSERT INTO themes(id,name,base,css,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, t.name, t.base, t.css, now, now);
    return this.getTheme(id)!;
  }

  updateTheme(id: string, patch: Partial<ThemeFile>, now: number): Theme | ThemeError | null {
    const cur = this.getTheme(id);
    if (!cur) return null;
    const next: ThemeFile = { name: patch.name ?? cur.name, base: patch.base ?? cur.base, css: patch.css ?? cur.css };
    const bad = this.checkTheme(next);
    if (bad) return bad;
    this.db.prepare('UPDATE themes SET name = ?, base = ?, css = ?, updated_at = ? WHERE id = ?').run(next.name, next.base, next.css, now, id);
    return this.getTheme(id)!;
  }

  deleteTheme(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM themes WHERE id = ?').run(id).changes) > 0;
  }

  // ── 글꼴 서재
  listFonts(): FontMeta[] {
    const rows = this.db.prepare('SELECT id, family, format, size, created_at AS c FROM fonts ORDER BY created_at, rowid').all() as FontRow[];
    return rows.map(toFont);
  }

  getFont(id: string): FontMeta | null {
    const r = this.db.prepare('SELECT id, family, format, size, created_at AS c FROM fonts WHERE id = ?').get(id) as FontRow | undefined;
    return r ? toFont(r) : null;
  }

  fontFile(f: FontMeta): string {
    return path.join(this.fontDir, `${f.id}.${f.format}`);
  }

  /** CSS 의 패밀리 이름은 대소문자를 가리지 않는다 → 겹침도 대소문자 없이 본다. */
  private familyTaken(family: string, exceptId = ''): boolean {
    return this.db.prepare('SELECT 1 FROM fonts WHERE lower(family) = lower(?) AND id <> ?').get(family, exceptId) !== undefined;
  }

  addFont(family: string, buf: Uint8Array, now: number): FontMeta | FontError {
    if (!isFamily(family)) return 'bad-family';
    if (buf.length > FONT_LIMITS.fileBytes) return 'too-large';
    const format = sniffFont(buf);
    if (!format) return 'bad-font';
    const { n, total } = this.db.prepare('SELECT count(*) AS n, coalesce(sum(size), 0) AS total FROM fonts').get() as { n: number; total: number };
    if (n >= FONT_LIMITS.maxFonts) return 'too-many';
    if (total + buf.length > FONT_LIMITS.totalBytes) return 'library-full';
    if (this.familyTaken(family)) return 'family-taken';
    const meta: FontMeta = { id: newId(), family, format, size: buf.length, createdAt: now };
    const file = this.fontFile(meta);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    try {
      this.db.prepare('INSERT INTO fonts(id,family,format,size,created_at) VALUES(?,?,?,?,?)').run(meta.id, family, format, buf.length, now);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    return meta;
  }

  renameFont(id: string, family: string): FontMeta | 'bad-family' | 'family-taken' | null {
    if (!this.getFont(id)) return null;
    if (!isFamily(family)) return 'bad-family';
    if (this.familyTaken(family, id)) return 'family-taken';
    this.db.prepare('UPDATE fonts SET family = ? WHERE id = ?').run(family, id);
    return this.getFont(id);
  }

  deleteFont(id: string): boolean {
    const f = this.getFont(id);
    if (!f) return false;
    this.db.prepare('DELETE FROM fonts WHERE id = ?').run(id);
    try { fs.rmSync(this.fontFile(f), { force: true }); } catch { /* 행은 이미 지웠다. 남은 파일은 조용히 둔다 */ }
    return true;
  }
}
