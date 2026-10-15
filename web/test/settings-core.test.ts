import { describe, expect, it } from 'vitest';
import {
  DEFAULTS, FONT_STACKS, cssVars, customThemeId, fromServer, layoutSignature, normalizeFont, normalizeMode, normalizeSettings, parseLocal,
} from '../src/lib/settings-core';

describe('settings core', () => {
  it('accepts custom:<32 hex> themes and rejects other custom values', () => {
    const id = 'a'.repeat(32);
    expect(normalizeSettings({ theme: `custom:${id}` }).theme).toBe(`custom:${id}`);
    expect(normalizeSettings({ theme: 'custom:xyz' }).theme).toBe('system');
    expect(normalizeSettings({ theme: `custom:${id}0` }).theme).toBe('system');
    expect(customThemeId(`custom:${id}`)).toBe(id);
    expect(customThemeId('dark')).toBeNull();
  });

  it('normalizeMode only accepts "book"; everything else is scroll', () => {
    expect(normalizeMode('book')).toBe('book');
    for (const v of ['scroll', '', 'BOOK', 1, null, undefined, {}]) expect(normalizeMode(v)).toBe('scroll');
  });

  it('normalizeSettings clamps numbers, validates enums and booleans, falls back to defaults', () => {
    expect(normalizeSettings({})).toEqual(DEFAULTS);
    const s = normalizeSettings({ fontSize: 5, lineHeight: 9, paraSpacing: -1, width: 100, theme: 'neon', justify: 'yes', indent: true, bubble: 1, mode: 'book', hideUser: 'yes' });
    expect(s).toMatchObject({ fontSize: 14, lineHeight: 2.4, paraSpacing: 0, width: 52, theme: 'system', justify: false, indent: true, bubble: false, mode: 'book', hideUser: false });
    expect(normalizeSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULTS.fontSize);
    expect(normalizeSettings({ fontSize: '20' }).fontSize).toBe(DEFAULTS.fontSize);
  });

  it('fonts: presets, or a custom family list without CSS syntax', () => {
    expect(normalizeFont('sans')).toBe('sans');
    expect(normalizeFont('  Noto Serif KR, 바탕 ')).toBe('Noto Serif KR, 바탕');
    expect(normalizeFont('"Iropke Batang"')).toBe('"Iropke Batang"');
    for (const bad of ['x; color: red', 'url(evil)', 'a{b}', '', 'x'.repeat(200), 3]) expect(normalizeFont(bad)).toBe(DEFAULTS.font);
  });

  it('parseLocal merges a partial cache over the defaults and survives garbage', () => {
    expect(parseLocal(null)).toEqual(DEFAULTS);
    expect(parseLocal('not json')).toEqual(DEFAULTS);
    expect(parseLocal('[]')).toEqual(DEFAULTS);
    expect(parseLocal('{"mode":"book","fontSize":20}')).toEqual({ ...DEFAULTS, mode: 'book', fontSize: 20 });
  });

  it('fromServer maps only reader.* keys that are present', () => {
    expect(fromServer({ 'reader.mode': 'book', 'reader.fontSize': 99, 'reader.theme': 'sepia', 'reader.hideUser': true, other: 1 }))
      .toEqual({ mode: 'book', fontSize: 28, theme: 'sepia', hideUser: true });
    expect(fromServer({})).toEqual({});
  });

  it('cssVars turns settings into CSS custom properties and a theme attribute', () => {
    const d = cssVars(DEFAULTS);
    expect(d.theme).toBeNull();
    expect(d.vars).toEqual({
      '--reader-font': FONT_STACKS.serif, '--reader-size': '18px', '--reader-lh': '1.85', '--reader-para': '0.9em',
      '--reader-width': '38rem', '--reader-align': 'start', '--reader-indent': '0',
    });
    const c = cssVars({ ...DEFAULTS, font: 'My Font', justify: true, indent: true, theme: 'sepia' });
    expect(c.vars['--reader-font']).toBe(`My Font, ${FONT_STACKS.serif}`);
    expect(c.vars['--reader-align']).toBe('justify');
    expect(c.vars['--reader-indent']).toBe('1em');
    expect(c.theme).toBe('sepia');
  });

  it('layoutSignature changes with layout settings only (not theme or mode)', () => {
    const base = layoutSignature(DEFAULTS);
    expect(layoutSignature({ ...DEFAULTS, theme: 'dark', mode: 'book' })).toBe(base);
    for (const patch of [{ fontSize: 19 }, { bubble: true }, { font: 'sans' }, { lineHeight: 2 }, { paraSpacing: 0 }, { width: 44 }, { justify: true }, { indent: true }, { hideUser: true }]) {
      expect(layoutSignature({ ...DEFAULTS, ...patch })).not.toBe(base);
    }
  });
});
