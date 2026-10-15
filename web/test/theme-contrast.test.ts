// 단계 3-0: 색 토큰은 src/tokens.css 한 곳에만 있고, 모든 테마가 WCAG 대비를 지킨다 (스펙 §4.1).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `선택자 { --x: v; }` 블록을 선택자별 변수 맵으로. @media 안의 블록도 잡힌다 (중괄호 없는 본문만 매칭). */
function blocks(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const v of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) out.set(sel, { ...out.get(sel), ...vars });
  }
  return out;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const REQUIRED = [
  '--bg', '--fg', '--muted', '--ink-faint', '--line', '--rule-strong', '--accent', '--on-accent', '--accent-wash',
  '--surface-raised', '--surface-sunken', '--surface-strong', '--bubble', '--hl-yellow', '--hl-green', '--hl-blue', '--hl-pink',
] as const;

const B = blocks(read('tokens.css'));
const get = (sel: string) => {
  const v = B.get(sel);
  if (!v) throw new Error(`tokens.css 에 ${sel} 블록이 없다`);
  return v;
};
const THEMES = {
  light: get(':root'),
  dark: get(':root[data-theme="dark"]'),
  sepia: get(':root[data-theme="sepia"]'),
};

describe('color tokens (src/tokens.css)', () => {
  it.each(Object.entries(THEMES))('%s defines every required token as #rrggbb', (_n, t) => {
    for (const k of REQUIRED) expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
    expect(t['--shadow-overlay'], '--shadow-overlay').toBeTruthy();
  });

  it('explicit light equals the default, and system-dark equals explicit dark', () => {
    expect(get(':root[data-theme="light"]')).toEqual(THEMES.light);
    expect(get(':root:not([data-theme])')).toEqual(THEMES.dark);
  });

  it.each(Object.entries(THEMES))('%s meets WCAG contrast', (_n, t) => {
    const text = ['--fg', '--muted', '--ink-faint', '--accent'];
    const grounds = ['--bg', '--surface-raised', '--surface-sunken'];
    for (const fg of text) for (const bg of grounds) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const fg of ['--fg', '--accent']) expect(contrast(t[fg], t['--accent-wash']), `${fg} on --accent-wash`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--on-accent'], t['--accent']), '--on-accent on --accent').toBeGreaterThanOrEqual(4.5);
    for (const bg of ['--bg', '--surface-raised']) expect(contrast(t['--rule-strong'], t[bg]), `--rule-strong on ${bg}`).toBeGreaterThanOrEqual(3);
    for (const hl of ['--hl-yellow', '--hl-green', '--hl-blue', '--hl-pink']) expect(contrast(t['--fg'], t[hl]), `--fg on ${hl}`).toBeGreaterThanOrEqual(4.5);
  });

  it('no other stylesheet defines color tokens', () => {
    for (const f of ['app.css', 'theme.css']) expect(read(f)).not.toMatch(/--(bg|fg|muted|line|accent|bubble|hl-[a-z]+)\s*:/);
  });
});
