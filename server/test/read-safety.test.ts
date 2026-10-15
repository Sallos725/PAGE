import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_DIR = path.join(import.meta.dirname, '..', 'src', 'source');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('source code never writes to the save', () => {
  const files = tsFiles(SOURCE_DIR);
  it('finds the source modules', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [path.relative(SOURCE_DIR, f), f]))('%s has no write SQL', (_name, file) => {
    const code = stripComments(fs.readFileSync(file as string, 'utf8'));
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|REINDEX)\b/);
    expect(code).not.toMatch(/journal_mode|wal_checkpoint|writable_schema/i);
    expect(code).not.toMatch(/\b(writeFile|appendFile|createWriteStream|unlink|rmSync|rename|mkdir|copyFile|truncate)(Sync)?\b/);
  });

  it('only sqlite.ts opens databases, and it only knows risuai.db', () => {
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (path.basename(f) === 'adapter.ts' || path.basename(f) === 'kv.ts') {
        expect(code).not.toMatch(/new DatabaseSync/);
      }
    }
    const sqlite = fs.readFileSync(path.join(SOURCE_DIR, '..', 'sqlite.ts'), 'utf8');
    expect(sqlite).toMatch(/new Set\(\['risuai\.db'\]\)/);
  });
});
