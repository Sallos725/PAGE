// 책등 팔레트는 library.css 한 곳에. 글자 4.5:1, 읽는 중 띠 3:1 (스펙 6.3).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPINE_COLORS } from '../src/lib/spines';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'library.css'), 'utf8');
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe('spine palette', () => {
  const rules = [...css.matchAll(/\.spine\[data-c="(\d)"\]\s*\{[^}]*--spine-bg:\s*(#[0-9a-f]{6});[^}]*--spine-fg:\s*(#[0-9a-f]{6});[^}]*--spine-ribbon:\s*(#[0-9a-f]{6});/g)];
  it('defines every color', () => {
    expect(rules.map((r) => Number(r[1]))).toEqual([...Array(SPINE_COLORS).keys()]);
  });
  it.each(rules.map((r) => [r[1], r[2], r[3], r[4]]))('color %s: text 4.5:1, ribbon 3:1', (_c, bg, fg, ribbon) => {
    expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ribbon!, bg!)).toBeGreaterThanOrEqual(3);
  });
});
