import { describe, expect, it } from 'vitest';
import {
  THEME_LIMITS, cleanThemeName, composeThemeFile, cssBytes, familyFromFileName, isFamily, isThemeBase, isThemeName,
  parseThemeFile, themeFileName, uniqueName,
} from '../src/shared/theme-file.js';

/** 짝 잃은 서로게이트가 없는가. */
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('theme file', () => {
  it('round-trips name, base and css through the header comment', () => {
    const file = composeThemeFile({ name: '밤바다', base: 'dark', css: ':root[data-theme] { --bg: #0d1b2a; }\n' });
    expect(file.startsWith('/* @page-theme\n')).toBe(true);
    expect(parseThemeFile(file, 'x.css')).toEqual({ name: '밤바다', base: 'dark', css: ':root[data-theme] { --bg: #0d1b2a; }\n' });
  });

  it('accepts a BOM and leading whitespace before the header', () => {
    const t = parseThemeFile('﻿\n  /* @page-theme\nname: 종이\nbase: sepia\n*/\nbody{}', 'x.css');
    expect(t).toEqual({ name: '종이', base: 'sepia', css: 'body{}' });
  });

  it('falls back to the file name and light when there is no header', () => {
    expect(parseThemeFile('body { color: red; }', '내 테마.css')).toEqual({ name: '내 테마', base: 'light', css: 'body { color: red; }' });
    expect(parseThemeFile('/* 그냥 주석 */ body{}', 'a.CSS')).toEqual({ name: 'a', base: 'light', css: '/* 그냥 주석 */ body{}' });
    expect(parseThemeFile('', '.css').name).toBe('가져온 테마');
  });

  it('ignores unknown keys and unknown base values', () => {
    expect(parseThemeFile('/* @page-theme\nname: n\nbase: neon\nauthor: x\n*/\n', 'f.css')).toEqual({ name: 'n', base: 'light', css: '' });
  });

  it('cleans names: control characters, comment terminators, length', () => {
    expect(cleanThemeName(' a\u0000b*/c ')).toBe('abc');
    expect(cleanThemeName('가'.repeat(80))).toHaveLength(THEME_LIMITS.nameMax);
    expect(isThemeName('밤바다')).toBe(true);
    expect(isThemeName('a*/b')).toBe(false);
    expect(isThemeName(' a')).toBe(false);
    expect(isThemeName('')).toBe(false);
    expect(isThemeBase('sepia')).toBe(true);
    expect(isThemeBase('system')).toBe(false);
  });

  it('font family rules and defaults from the file name', () => {
    expect(isFamily('MaruBuri-Regular.subset')).toBe(true);
    expect(isFamily('나눔 명조')).toBe(true);
    expect(isFamily('a"b')).toBe(false);
    expect(isFamily('a;b')).toBe(false);
    expect(isFamily(' a')).toBe(false);
    expect(isFamily('x'.repeat(61))).toBe(false);
    expect(familyFromFileName('MaruBuri-Regular.subset.woff2')).toBe('MaruBuri-Regular.subset');
    expect(familyFromFileName('my"font;1.ttf')).toBe('my font 1');
    expect(familyFromFileName('".otf')).toBe('내 글꼴');
  });

  it('rejects family names that could break out of a CSS string or are not NFC', () => {
    for (const bad of ['a\\b', 'a\nb', 'a}b', 'a<b', 'a/b']) expect(isFamily(bad)).toBe(false);
    expect(isFamily('Caf\u00e9')).toBe(true);
  });

  it('cleanThemeName never leaves a comment terminator and is idempotent', () => {
    const out = cleanThemeName('**\u0001//');
    expect(out).not.toContain('*/');
    expect(cleanThemeName(out)).toBe(out);
    for (const s of ['*/*/', '**//', 'a*\u0000/b', '* /', '*/ x']) {
      const c = cleanThemeName(s);
      expect(c).not.toContain('*/');
      expect(cleanThemeName(c)).toBe(c);
    }
  });

  it('truncates by code point and never leaves a lone surrogate', () => {
    const name = cleanThemeName(`${'a'.repeat(59)}\u{20000}\u{20000}`);
    expect(Array.from(name)).toHaveLength(60);
    expect(name.endsWith('\u{20000}')).toBe(true);
    expect(wellFormed(name)).toBe(true);
    expect(isThemeName(name)).toBe(true);
    const u = uniqueName(`${'a'.repeat(58)}\u{20000}`, [`${'a'.repeat(58)}\u{20000}`]);
    expect(wellFormed(u)).toBe(true);
    expect(Array.from(u).length).toBeLessThanOrEqual(60);
    expect(u.endsWith(' 2')).toBe(true);
    const fam = familyFromFileName(`${'\u{20000}'.repeat(70)}.ttf`);
    expect(wellFormed(fam)).toBe(true);
    expect(isFamily(fam)).toBe(true);
  });

  it('familyFromFileName normalises to NFC', () => {
    expect(familyFromFileName('Cafe\u0301.ttf')).toBe('Caf\u00e9');
    expect(isFamily('Cafe\u0301')).toBe(false);
  });

  it('uniqueName appends a number until free and keeps the length limit', () => {
    expect(uniqueName('새 테마', [])).toBe('새 테마');
    expect(uniqueName('새 테마', ['새 테마', '새 테마 2'])).toBe('새 테마 3');
    const long = 'x'.repeat(60);
    expect(uniqueName(long, [long])).toBe(`${'x'.repeat(58)} 2`);
    expect(uniqueName('y'.repeat(61), [])).toBe('y'.repeat(60));
  });

  it('uniqueName compares through the key function', () => {
    const lower = (s: string) => s.toLowerCase();
    expect(uniqueName('Noto', ['noto'], 60, lower)).toBe('Noto 2');
    expect(uniqueName('Noto', ['noto', 'NOTO 2'], 60, lower)).toBe('Noto 3');
    expect(uniqueName('Noto', ['noto'])).toBe('Noto');
  });

  it('file names drop characters files cannot hold', () => {
    expect(themeFileName('밤/바:다?')).toBe('밤바다.css');
    expect(themeFileName('***')).toBe('theme.css');
  });

  it('cssBytes counts UTF-8 bytes', () => {
    expect(cssBytes('가')).toBe(3);
  });
});
