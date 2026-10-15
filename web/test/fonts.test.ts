// 단계 3-0: 본문 폰트 MaruBuri 서브셋이 번들에 들어가고 기본 스택 첫 자리에 온다 (스펙 §4.3, D23).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_STACKS } from '../src/lib/settings-core';

const SRC = path.join(import.meta.dirname, '..', 'src');
const FONTS = path.join(SRC, 'assets', 'fonts');

describe('MaruBuri subset fonts', () => {
  it.each(['Regular', 'SemiBold'])('%s exists, is woff2, and is at most 400KB', (w) => {
    const buf = fs.readFileSync(path.join(FONTS, `MaruBuri-${w}.subset.woff2`));
    expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(buf.length).toBeLessThanOrEqual(400 * 1024);
  });

  it('ships the OFL license', () => {
    expect(fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it('fonts.css declares both weights with relative urls and swap', () => {
    const css = fs.readFileSync(path.join(SRC, 'fonts.css'), 'utf8');
    expect(css).toMatch(/url\("\.\/assets\/fonts\/MaruBuri-Regular\.subset\.woff2"\)[^}]*font-weight:\s*400/);
    expect(css).toMatch(/url\("\.\/assets\/fonts\/MaruBuri-SemiBold\.subset\.woff2"\)[^}]*font-weight:\s*600/);
    expect(css.match(/font-display:\s*swap/g)).toHaveLength(2);
  });

  it('main.ts loads fonts.css', () => {
    expect(fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8')).toMatch(/import '\.\/fonts\.css';/);
  });

  it('MaruBuri leads the serif preset and the app body font; sans prefers the device gothic', () => {
    expect(FONT_STACKS.serif.startsWith('"MaruBuri", ')).toBe(true);
    expect(FONT_STACKS.sans.startsWith('"Apple SD Gothic Neo", ')).toBe(true);
    expect(fs.readFileSync(path.join(SRC, 'app.css'), 'utf8')).toMatch(/--font-body:\s*"MaruBuri", /);
  });
});
