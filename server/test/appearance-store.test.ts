// server/test/appearance-store.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceStore, fontsCss, sniffFont } from '../src/state/appearance.js';
import { StateStore } from '../src/state/store.js';

const dirs: string[] = [];
const states: StateStore[] = [];
afterEach(() => {
  while (states.length) states.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-appearance-'));
  dirs.push(dataDir);
  const state = new StateStore(dataDir);
  states.push(state);
  return { dataDir, state, a: new AppearanceStore(state.db, dataDir) };
}

describe('AppearanceStore themes', () => {
  it('creates, lists (meta only), gets, updates and deletes', () => {
    const { a } = setup();
    const t = a.createTheme({ name: '밤바다', base: 'dark', css: 'body{}' }, 10);
    if (typeof t === 'string') throw new Error(t);
    expect(t).toMatchObject({ name: '밤바다', base: 'dark', css: 'body{}', createdAt: 10, updatedAt: 10 });
    expect(t.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.listThemes()).toEqual([{ id: t.id, name: '밤바다', base: 'dark', updatedAt: 10 }]);
    const u = a.updateTheme(t.id, { css: 'p{}', base: 'sepia' }, 20);
    expect(u).toMatchObject({ name: '밤바다', base: 'sepia', css: 'p{}', createdAt: 10, updatedAt: 20 });
    expect(a.updateTheme('0'.repeat(32), { css: '' }, 30)).toBeNull();
    expect(a.deleteTheme(t.id)).toBe(true);
    expect(a.deleteTheme(t.id)).toBe(false);
    expect(a.getTheme(t.id)).toBeNull();
  });

  it('keeps creation order', () => {
    const { a } = setup();
    a.createTheme({ name: 'b', base: 'light', css: '' }, 1);
    a.createTheme({ name: 'a', base: 'light', css: '' }, 2);
    expect(a.listThemes().map((t) => t.name)).toEqual(['b', 'a']);
  });

  it('rejects bad names, oversized css and the 51st theme', () => {
    const { a } = setup();
    expect(a.createTheme({ name: 'a*/b', base: 'light', css: '' }, 1)).toBe('bad-name');
    expect(a.createTheme({ name: 'x', base: 'neon' as 'light', css: '' }, 1)).toBe('bad-name');
    expect(a.createTheme({ name: 'x', base: 'light', css: '가'.repeat(90_000) }, 1)).toBe('too-large'); // 270,000 바이트
    for (let i = 0; i < 50; i++) expect(typeof a.createTheme({ name: `t${i}`, base: 'light', css: '' }, i)).toBe('object');
    expect(a.createTheme({ name: 'over', base: 'light', css: '' }, 99)).toBe('too-many');
    const first = a.listThemes()[0]!;
    expect(a.updateTheme(first.id, { css: '가'.repeat(90_000) }, 100)).toBe('too-large');
    expect(a.updateTheme(first.id, { name: '' }, 100)).toBe('bad-name');
    expect(a.updateTheme(first.id, { name: 5 as unknown as string }, 100)).toBe('bad-name');
    expect(a.createTheme({ name: 'y', base: 'light', css: 5 as unknown as string }, 100)).toBe('bad-name');
  });
});

/** 형식 판정만 통과하는 합성 글꼴 바이트 (진짜 글꼴이 아니다). */
const fakeFont = (tag: string | number[], size = 64): Buffer => {
  const b = Buffer.alloc(size);
  if (typeof tag === 'string') b.write(tag, 0, 'latin1'); else Buffer.from(tag).copy(b);
  return b;
};

describe('font sniffing', () => {
  it('recognises woff2, ttf and otf by magic bytes only', () => {
    expect(sniffFont(fakeFont('wOF2'))).toBe('woff2');
    expect(sniffFont(fakeFont([0, 1, 0, 0]))).toBe('ttf');
    expect(sniffFont(fakeFont('true'))).toBe('ttf');
    expect(sniffFont(fakeFont('OTTO'))).toBe('otf');
    expect(sniffFont(fakeFont('wOFF'))).toBeNull();
    expect(sniffFont(fakeFont('<svg'))).toBeNull();
    expect(sniffFont(Buffer.from('wOF2'))).toBeNull(); // 너무 짧다
  });
});

describe('AppearanceStore fonts', () => {
  it('adds a font file, lists it, renames and deletes it with the file', () => {
    const { a, dataDir } = setup();
    const f = a.addFont('나눔 명조', fakeFont('wOF2'), 10);
    if (typeof f === 'string') throw new Error(f);
    expect(f).toMatchObject({ family: '나눔 명조', format: 'woff2', size: 64, createdAt: 10 });
    const file = path.join(dataDir, 'fonts', `${f.id}.woff2`);
    expect(fs.existsSync(file)).toBe(true);
    expect(a.fontFile(f)).toBe(file);
    expect(a.listFonts()).toEqual([f]);
    expect(a.renameFont(f.id, '명조 2')).toMatchObject({ id: f.id, family: '명조 2' });
    expect(a.renameFont('0'.repeat(32), 'x')).toBeNull();
    expect(a.deleteFont(f.id)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(a.deleteFont(f.id)).toBe(false);
  });

  it('rejects bad family names, unknown formats, taken names (case-insensitive) and oversize files', () => {
    const { a } = setup();
    expect(a.addFont('a"b', fakeFont('wOF2'), 1)).toBe('bad-family');
    expect(a.addFont('x', fakeFont('wOFF'), 1)).toBe('bad-font');
    expect(a.addFont('x', Buffer.alloc(10 * 1024 * 1024 + 1), 1)).toBe('too-large');
    expect(typeof a.addFont('Maru', fakeFont('OTTO'), 1)).toBe('object');
    expect(a.addFont('maru', fakeFont('OTTO'), 2)).toBe('family-taken');
    const other = a.addFont('other', fakeFont('true'), 3);
    if (typeof other === 'string') throw new Error(other);
    expect(a.renameFont(other.id, 'MARU')).toBe('family-taken');
    expect(a.renameFont(other.id, 'a;b')).toBe('bad-family');
    expect(a.renameFont(other.id, 'other')).toMatchObject({ family: 'other' }); // 자기 이름 그대로는 된다
  });

  it('limits the count to 30 and the total to 200MB', () => {
    const { a } = setup();
    for (let i = 0; i < 30; i++) expect(typeof a.addFont(`f${i}`, fakeFont('wOF2'), i)).toBe('object');
    expect(a.addFont('f30', fakeFont('wOF2'), 31)).toBe('too-many');
    const big = setup().a;
    const nine = fakeFont('wOF2', 9 * 1024 * 1024);
    for (let i = 0; i < 22; i++) expect(typeof big.addFont(`b${i}`, nine, i)).toBe('object'); // 198MB
    expect(big.addFont('b22', nine, 22)).toBe('library-full');
  });

  it('fontsCss declares every font with its format and the API url', () => {
    const { a } = setup();
    const w = a.addFont('Maru Buri', fakeFont('wOF2'), 1);
    const t = a.addFont('Other', fakeFont('true'), 2);
    if (typeof w === 'string' || typeof t === 'string') throw new Error('add');
    expect(fontsCss(a.listFonts())).toBe(
      `@font-face { font-family: "Maru Buri"; src: url("/api/fonts/${w.id}") format("woff2"); font-display: swap; }\n` +
      `@font-face { font-family: "Other"; src: url("/api/fonts/${t.id}") format("truetype"); font-display: swap; }\n`,
    );
    expect(fontsCss([])).toBe('');
  });
});
