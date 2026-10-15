// 테마 파일(.css + 머리 주석)과 테마·글꼴 이름 규칙 (스펙 2.1, 2.6, 3.1). 서버와 웹이 같이 쓴다 — web/src/lib/theme-file.ts 가 다시 내보낸다.

export const THEME_BASES = ['light', 'dark', 'sepia'] as const;
export type ThemeBase = (typeof THEME_BASES)[number];
export const THEME_LIMITS = { cssBytes: 256 * 1024, nameMax: 60, maxThemes: 50 } as const;
export const FONT_LIMITS = { fileBytes: 10 * 1024 * 1024, maxFonts: 30, totalBytes: 200 * 1024 * 1024, familyMax: 60 } as const;

export type ThemeFile = { name: string; base: ThemeBase; css: string };

export const isThemeBase = (v: unknown): v is ThemeBase => typeof v === 'string' && (THEME_BASES as readonly string[]).includes(v);

const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join('');

/** 제어 문자와 `*` `/` 이어짐(머리 주석을 닫아 버린다 — 빼고 나서 새로 생기는 이어짐까지)을 빼고 앞뒤 공백을 다듬어 60자(코드포인트)로 자른다. */
export function cleanThemeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u001f\u007f]/g, '');
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\*\//g, ''); }
  return cut(t.trim(), THEME_LIMITS.nameMax).trim();
}
export const isThemeName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && cleanThemeName(v) === v;

// 패밀리 이름: 글자·숫자·공백·하이픈·밑줄·점만. 따옴표·세미콜론 같은 CSS 구문 글자는 받지 않는다 (fonts.css 에 그대로 넣는다).
const FAMILY_RE = /^[\p{L}\p{N} \-_.]+$/u;
export const isFamily = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && Array.from(v).length <= FONT_LIMITS.familyMax && v.trim() === v && v === v.normalize('NFC') && FAMILY_RE.test(v);

export function familyFromFileName(fileName: string): string {
  const s = cut(fileName.normalize('NFC').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} \-_.]+/gu, ' ').replace(/\s+/g, ' ').trim(), FONT_LIMITS.familyMax).trim();
  return s || '내 글꼴';
}

/** 이미 있는 이름이면 ` 2`, ` 3` … 을 붙인다. 붙인 뒤에도 max 자를 넘지 않게 앞을 자른다. key 로 비교 기준을 바꾼다(글꼴 이름은 대소문자 무시). */
export function uniqueName(name: string, taken: Iterable<string>, max: number = THEME_LIMITS.nameMax, key: (s: string) => string = (s) => s): string {
  const set = new Set(Array.from(taken, key));
  const first = cut(name, max).trimEnd();
  if (!set.has(key(first))) return first;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const cand = `${cut(name, max - suffix.length).trimEnd()}${suffix}`;
    if (!set.has(key(cand))) return cand;
  }
}

const HEADER = /^\s*\/\*\s*@page-theme\b([\s\S]*?)\*\//;

/** 파일 맨 앞(BOM·공백 허용)의 첫 주석이 `@page-theme` 이면 name·base 를 읽고 떼어 낸다. */
export function parseThemeFile(text: string, fileName: string): ThemeFile {
  let css = text.replace(/^﻿/, '');
  let name = '';
  let base: ThemeBase = 'light';
  const m = HEADER.exec(css);
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = /^\s*(name|base)\s*:\s*(.*?)\s*$/.exec(line);
      if (!kv) continue;
      if (kv[1] === 'name') name = kv[2]!;
      else if (isThemeBase(kv[2])) base = kv[2];
    }
    css = css.slice(m[0].length).replace(/^[ \t]*\r?\n/, '');
  }
  name = cleanThemeName(name) || cleanThemeName(fileName.replace(/\.css$/i, '')) || '가져온 테마';
  return { name, base, css };
}

export function composeThemeFile(t: ThemeFile): string {
  return `/* @page-theme\n   name: ${t.name}\n   base: ${t.base}\n*/\n${t.css}`;
}

export const cssBytes = (css: string): number => new TextEncoder().encode(css).length;

/** 내려받을 파일 이름: 파일 이름에 못 쓰는 글자를 뺀다 (제어 문자는 이름 규칙에서 이미 빠져 있다). */
export function themeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '').trim();
  return `${s || 'theme'}.css`;
}
