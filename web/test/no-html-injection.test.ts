import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '..', 'src');
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.(svelte|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

describe('message HTML is never injected into the DOM (R7)', () => {
  const all = files(SRC);
  it('finds the sources', () => expect(all.length).toBeGreaterThan(5));
  it.each(all.map((f) => [path.relative(SRC, f), f]))('%s has no HTML injection sinks', (_n, f) => {
    const code = fs.readFileSync(f as string, 'utf8');
    expect(code).not.toMatch(/\{@html\b/);
    expect(code).not.toMatch(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|\beval\(|new Function\(/);
  });
  it('does not log message text', () => {
    for (const f of all) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/console\.(log|debug|info|warn|error)\([^)]*(\.text|\.data|blocks)/);
  });
});
