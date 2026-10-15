// Default 템플릿의 토큰 = tokens.css 밝게 값, 약속한 data-part 이름표가 실제 컴포넌트에 있다 (커스텀 테마 스펙 2.4–2.5).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIGHT_TOKENS, THEME_PARTS, defaultThemeCss } from '../src/lib/theme-template';

const SRC = path.join(import.meta.dirname, '..', 'src');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function lightBlock(): Record<string, string> {
  const css = strip(fs.readFileSync(path.join(SRC, 'tokens.css'), 'utf8'));
  const m = /:root, :root\[data-theme="light"\]\s*\{([^{}]*)\}/.exec(css);
  if (!m) throw new Error('tokens.css 밝게 블록이 없다');
  return Object.fromEntries([...m[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((v) => [v[1]!, v[2]!.trim()]));
}

function svelteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? svelteFiles(path.join(dir, e.name)) : e.name.endsWith('.svelte') ? [path.join(dir, e.name)] : []);
}

describe('default theme template', () => {
  it('LIGHT_TOKENS equals the light block of tokens.css', () => {
    expect(LIGHT_TOKENS).toEqual(lightBlock());
  });

  it('the template sets every light token under :root[data-theme]', () => {
    const css = defaultThemeCss();
    const m = /:root\[data-theme\] \{([^{}]*)\}/.exec(strip(css));
    expect(m).not.toBeNull();
    for (const [k, v] of Object.entries(LIGHT_TOKENS)) expect(m![1]).toContain(`${k}: ${v};`);
    expect(css).toContain('?theme=off');
    expect(css).toContain('!important');
    for (const [part] of THEME_PARTS) expect(css).toContain(`[data-part="${part}"]`);
  });

  it('part list is real (empty) CSS rules: no stray text once comments are stripped', () => {
    for (const [part, desc] of THEME_PARTS) expect(desc, part).not.toContain('*/');
    const css = defaultThemeCss();
    const tokenLines = new Set(Object.entries(LIGHT_TOKENS).map(([k, v]) => `${k}: ${v};`));
    const partRules = new Set(THEME_PARTS.map(([p]) => `[data-part="${p}"] { }`));
    const lines = strip(css).split('\n').map((l) => l.trim()).filter((l) => /\S/.test(l));
    for (const l of lines) {
      expect(l === ':root[data-theme] {' || l === '}' || tokenLines.has(l) || partRules.has(l), l).toBe(true);
    }
    for (const r of partRules) expect(lines).toContain(r);
    expect((css.match(/\/\*/g) ?? []).length).toBe((css.match(/\*\//g) ?? []).length);
  });

  it('every promised data-part exists in some component', () => {
    const all = [path.join(SRC, 'App.svelte'), ...svelteFiles(path.join(SRC, 'lib'))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const [part] of THEME_PARTS) expect(all, part).toContain(`data-part="${part}"`);
  });
});
