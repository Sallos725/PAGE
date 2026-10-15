import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportError, ExportManager, downloadName, noWarnings } from '../src/export/jobs.js';

const H = 3600_000;
function setup(opts: { maxPending?: number; onError?: (code: string) => void } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-ex-')), 'exports');
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const m = new ExportManager({ dir, now: clock.now, ...opts });
  return { dir, clock, m };
}
const write = (body: string) => async (tmp: string) => { fs.writeFileSync(tmp, body); return { warnings: noWarnings() }; };

describe('ExportManager', () => {
  it('runs jobs one at a time, in order, and keeps the file with size and warnings', async () => {
    const { dir, m } = setup();
    const order: string[] = [];
    const a = m.start('json', async (tmp) => { order.push('a'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); fs.writeFileSync(tmp, 'A'); return { warnings: noWarnings() }; })!;
    const b = m.start('json', async (tmp) => { order.push('b'); fs.writeFileSync(tmp, 'BB'); return { warnings: { missingImages: 1, skippedImages: 0, slowRules: [] } }; })!;
    expect(a.jobId).toMatch(/^[0-9a-f]{32}$/);
    expect(m.get(a.jobId)!.state).toMatch(/queued|running/);
    await m.idle();
    expect(order).toEqual(['a', 'a-end', 'b']);
    expect(m.get(a.jobId)).toMatchObject({ state: 'done', ext: 'json', size: 1 });
    expect(m.get(b.jobId)).toMatchObject({ state: 'done', size: 2, warnings: { missingImages: 1 } });
    expect(fs.readFileSync(m.filePath(b.jobId)!, 'utf8')).toBe('BB');
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
  });

  it('records the error code; unknown errors become internal; the temp file is removed', async () => {
    const { dir, m } = setup();
    const a = m.start('epub', async (tmp) => { fs.writeFileSync(tmp, 'x'); throw new ExportError('slow-rules'); })!;
    const b = m.start('epub', async () => { throw new Error('boom with private text'); })!;
    await m.idle();
    expect(m.get(a.jobId)).toMatchObject({ state: 'failed', error: 'slow-rules' });
    expect(m.get(b.jobId)).toMatchObject({ state: 'failed', error: 'internal' });
    expect(m.filePath(a.jobId)).toBeNull();
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, `${b.jobId}.status.json`), 'utf8')).not.toContain('private');
  });

  it('reports only the error code to onError; a throwing callback does not break the queue', async () => {
    const seen: string[] = [];
    const { m } = setup({ onError: (c) => { seen.push(c); throw new Error('callback boom'); } });
    m.start('epub', async () => { throw new ExportError('slow-rules'); });
    m.start('epub', async () => { throw new Error('boom with private text'); });
    const ok = m.start('json', write('x'))!;
    await m.idle();
    expect(seen).toEqual(['slow-rules', 'internal']);
    expect(seen.join()).not.toContain('private');
    expect(m.get(ok.jobId)).toMatchObject({ state: 'done' });
  });

  it('ignores a status file whose createdAt is not a number, and uses the requested id', async () => {
    const { dir, clock, m } = setup();
    const id = 'a'.repeat(32);
    fs.writeFileSync(path.join(dir, `${id}.status.json`), JSON.stringify({ jobId: id, ext: 'json', state: 'done', createdAt: 'x' }));
    expect(m.get(id)).toBeNull();
    const id2 = 'b'.repeat(32);
    fs.writeFileSync(path.join(dir, `${id2}.status.json`), JSON.stringify({ jobId: 'c'.repeat(32), ext: 'json', state: 'done', createdAt: clock.now() }));
    expect(m.get(id2)!.jobId).toBe(id2);
  });

  it('refuses new jobs when too many are pending', async () => {
    const { m } = setup({ maxPending: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    expect(m.start('json', async (tmp) => { await gate; fs.writeFileSync(tmp, '1'); return { warnings: noWarnings() }; })).not.toBeNull();
    expect(m.start('json', write('2'))).toBeNull();
    release();
    await m.idle();
    expect(m.start('json', write('3'))).not.toBeNull();
    await m.idle();
  });

  it('a new manager (restart) still serves finished jobs and clears leftover temp files', async () => {
    const { dir, clock, m } = setup();
    const a = m.start('json', write('{}'))!;
    await m.idle();
    fs.writeFileSync(path.join(dir, '.tmp', 'leftover.epub'), 'x');
    const m2 = new ExportManager({ dir, now: clock.now });
    expect(m2.get(a.jobId)).toMatchObject({ state: 'done', size: 2 });
    expect(m2.filePath(a.jobId)).not.toBeNull();
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
  });

  it('deletes results older than the TTL on the next start', async () => {
    const { dir, clock, m } = setup();
    const a = m.start('json', write('{}'))!;
    await m.idle();
    clock.advance(24 * H + 1);
    m.start('json', write('{}'));
    await m.idle();
    expect(m.get(a.jobId)).toBeNull();
    expect(fs.existsSync(path.join(dir, `${a.jobId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${a.jobId}.status.json`))).toBe(false);
  });

  it('serves a finished .pdf job after restart and drops it past the TTL', async () => {
    const { dir, clock, m } = setup();
    const a = m.start('pdf', write('%PDF-1.7'))!;
    await m.idle();
    expect(fs.existsSync(path.join(dir, `${a.jobId}.pdf`))).toBe(true);
    const m2 = new ExportManager({ dir, now: clock.now });
    expect(m2.get(a.jobId)).toMatchObject({ state: 'done', ext: 'pdf', size: 8 });
    expect(m2.filePath(a.jobId)).toBe(path.join(dir, `${a.jobId}.pdf`));
    clock.advance(24 * H + 1);
    expect(m2.get(a.jobId)).toBeNull();
    expect(m2.filePath(a.jobId)).toBeNull();
    const m3 = new ExportManager({ dir, now: clock.now });
    m3.start('json', write('{}'));
    await m3.idle();
    expect(m3.get(a.jobId)).toBeNull();
    expect(fs.existsSync(path.join(dir, `${a.jobId}.pdf`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${a.jobId}.status.json`))).toBe(false);
  });

  it('rejects malformed ids and names downloads without chat text', () => {
    const { m } = setup();
    expect(m.get('../etc/passwd')).toBeNull();
    expect(m.get('0'.repeat(32))).toBeNull();
    expect(downloadName({ jobId: 'abcdef0123456789abcdef0123456789', ext: 'epub', createdAt: Date.UTC(2026, 9, 14, 12) }))
      .toBe('page-20261014-abcdef01.epub');
  });

  it('keeps the queue alive when cleanup of a failed job throws', async () => {
    const { m } = setup();
    const a = m.start('json', async (tmp) => { fs.mkdirSync(tmp); fs.writeFileSync(path.join(tmp, 'x'), '1'); throw new Error('x'); })!;
    const b = m.start('json', write('ok'))!;
    await m.idle();
    expect(m.get(a.jobId)).toMatchObject({ state: 'failed', error: 'internal' });
    expect(m.get(b.jobId)).toMatchObject({ state: 'done', size: 2 });
  });

  it('does not serve results past the TTL even before a sweep runs', async () => {
    const { clock, m } = setup();
    const a = m.start('json', write('{}'))!;
    await m.idle();
    expect(m.filePath(a.jobId)).not.toBeNull();
    clock.advance(24 * H + 1);
    expect(m.get(a.jobId)).toBeNull();
    expect(m.filePath(a.jobId)).toBeNull();
  });

  it('ignores status files with an unknown ext', () => {
    const { dir, clock, m } = setup();
    const id = 'a'.repeat(32);
    fs.writeFileSync(path.join(dir, `${id}.status.json`), JSON.stringify({ jobId: id, ext: '../x', state: 'done', createdAt: clock.now() }));
    expect(m.get(id)).toBeNull();
  });
});
