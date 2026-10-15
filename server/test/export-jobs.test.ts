import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportError, ExportManager, downloadName, noWarnings } from '../src/export/jobs.js';

const H = 3600_000;
function setup(opts: { maxPending?: number; onError?: (code: string) => void } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-ex-')), 'exports');
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const m = new ExportManager({ dir, now: clock.now, ...opts });
  return { dir, clock, m };
}
afterEach(() => { vi.restoreAllMocks(); });
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
  describe('purgeOwned', () => {
    const A = { source: 'imported', charId: 'c'.repeat(32), chatId: 'a' };
    const B = { source: 'imported', charId: 'c'.repeat(32), chatId: 'b' };
    const ofA = (o: { source: string; charId: string; chatId: string }) => o.source === 'imported' && o.charId === A.charId && o.chatId === 'a';

    it('stores the owner (ids only) and deletes finished jobs of that owner, keeping others and owner-less jobs', async () => {
      const { dir, m } = setup();
      const a = m.start('json', write('A'), A)!;
      const f = m.start('epub', async () => { throw new ExportError('slow-rules'); }, A)!;
      const b = m.start('json', write('B'), B)!;
      const n = m.start('json', write('N'))!;
      await m.idle();
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${a.jobId}.status.json`), 'utf8')).owner).toEqual(A);
      expect(m.purgeOwned(ofA)).toBe(2);
      expect(m.get(a.jobId)).toBeNull();
      expect(m.get(f.jobId)).toBeNull();
      expect(m.filePath(a.jobId)).toBeNull();
      expect(fs.existsSync(path.join(dir, `${a.jobId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${a.jobId}.status.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${f.jobId}.status.json`))).toBe(false);
      expect(m.filePath(b.jobId)).not.toBeNull();
      expect(m.filePath(n.jobId)).not.toBeNull();
      expect(m.purgeOwned(ofA)).toBe(0);
    });

    it('cancels a running job: no result file, no download, the queue goes on', async () => {
      const { dir, m } = setup();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let started = false;
      const a = m.start('json', async (tmp) => { started = true; await gate; fs.writeFileSync(tmp, 'A'); return { warnings: noWarnings() }; }, A)!;
      const next = m.start('json', write('ok'), B)!;
      await new Promise((r) => setTimeout(r, 0));
      expect(started).toBe(true);
      expect(m.purgeOwned(ofA)).toBe(1);
      expect(m.get(a.jobId)).toBeNull();
      release();
      await m.idle();
      expect(m.get(a.jobId)).toBeNull();
      expect(m.filePath(a.jobId)).toBeNull();
      expect(fs.existsSync(path.join(dir, `${a.jobId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${a.jobId}.status.json`))).toBe(false);
      expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
      expect(m.get(next.jobId)).toMatchObject({ state: 'done' });
    });

    it('skips a queued job that was purged before it ran (produce is never called) and frees its slot', async () => {
      const seen: string[] = [];
      const { m } = setup({ maxPending: 2, onError: (c) => seen.push(c) });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      m.start('json', async (tmp) => { await gate; fs.writeFileSync(tmp, '1'); return { warnings: noWarnings() }; }, B);
      let called = false;
      const q = m.start('json', async (tmp) => { called = true; fs.writeFileSync(tmp, 'Q'); return { warnings: noWarnings() }; }, A)!;
      expect(m.purgeOwned(ofA)).toBe(1);
      expect(m.get(q.jobId)).toBeNull();
      release();
      await m.idle();
      expect(called).toBe(false);
      expect(m.get(q.jobId)).toBeNull();
      expect(seen).toEqual([]);
      expect(m.start('json', write('x'))).not.toBeNull();
      expect(m.start('json', write('y'))).not.toBeNull();
      await m.idle();
    });

    it('after a restart, deletes jobs known only from their status files; leaves owner-less and other-owner files', async () => {
      const { dir, clock, m } = setup();
      const a = m.start('pdf', write('%PDF'), A)!;
      const b = m.start('json', write('B'), B)!;
      const n = m.start('json', write('N'))!;
      await m.idle();
      const old = 'd'.repeat(32); // owner 없는 옛 상태 파일
      fs.writeFileSync(path.join(dir, `${old}.status.json`), JSON.stringify({ jobId: old, ext: 'json', state: 'done', createdAt: clock.now() }));
      fs.writeFileSync(path.join(dir, `${old}.json`), '{}');
      const m2 = new ExportManager({ dir, now: clock.now });
      expect(m2.purgeOwned(ofA)).toBe(1);
      expect(m2.get(a.jobId)).toBeNull();
      expect(fs.existsSync(path.join(dir, `${a.jobId}.pdf`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${a.jobId}.status.json`))).toBe(false);
      expect(m2.filePath(b.jobId)).not.toBeNull();
      expect(m2.filePath(n.jobId)).not.toBeNull();
      expect(m2.filePath(old)).not.toBeNull();
      expect(m2.purgeOwned(() => true)).toBe(1); // owner 가 있는 것만 (B) — owner 없는 작업·옛 파일은 그대로
      expect(m2.filePath(b.jobId)).toBeNull();
      expect(m2.filePath(n.jobId)).not.toBeNull();
      expect(m2.filePath(old)).not.toBeNull();
    });
  });

  describe('orphan result files (no status file, not in memory)', () => {
    it('sweep removes them; status files, other names and .tmp stay', async () => {
      const { dir, m } = setup();
      const done = m.start('json', write('D'))!;
      await m.idle();
      const orphan = 'e'.repeat(32);
      for (const ext of ['json', 'epub', 'pdf']) fs.writeFileSync(path.join(dir, `${orphan}.${ext}`), 'x');
      fs.writeFileSync(path.join(dir, 'notes.json'), 'x'); // 작업 id 꼴이 아니면 건드리지 않는다
      m.sweep();
      for (const ext of ['json', 'epub', 'pdf']) expect(fs.existsSync(path.join(dir, `${orphan}.${ext}`))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'notes.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.tmp'))).toBe(true);
      expect(m.filePath(done.jobId)).not.toBeNull();
    });

    it('purgeOwned cleans them right away', () => {
      const { dir, m } = setup();
      const orphan = 'e'.repeat(32);
      fs.writeFileSync(path.join(dir, `${orphan}.epub`), 'x');
      m.purgeOwned(() => false);
      expect(fs.existsSync(path.join(dir, `${orphan}.epub`))).toBe(false);
    });

    it('never touches the result of a job still in memory (renamed, status file not written yet)', async () => {
      const { dir, m } = setup();
      const real = fs.writeFileSync.bind(fs);
      let swept = false;
      let resultThere = false;
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
        if (!swept && /\.status\.json$/.test(String(f))) { // rename 은 끝났고 상태 파일은 아직이다
          swept = true;
          m.sweep();
          resultThere = fs.readdirSync(dir).some((n) => /^[0-9a-f]{32}\.json$/.test(n));
        }
        return real(f, d, o);
      }) as typeof fs.writeFileSync);
      const job = m.start('json', write('J'))!;
      await m.idle();
      expect(swept).toBe(true);
      expect(resultThere).toBe(true);
      expect(m.filePath(job.jobId)).not.toBeNull();
    });

    it('a result left behind because its removal failed after the job was deleted is cleaned by the next sweep', async () => {
      const { dir, m } = setup();
      const realRename = fs.renameSync.bind(fs);
      const realRm = fs.rmSync.bind(fs);
      let out = '';
      vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
        realRename(a, b);
        out = String(b);
        m.purgeOwned(() => true); // rename 직후(취소 재확인 전) 채팅이 지워졌다
      }) as typeof fs.renameSync);
      vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
        if (String(p) === out) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); // 결과 파일을 못 지운다
        return realRm(p, o);
      }) as typeof fs.rmSync);
      m.start('json', write('S'), { source: 'imported', charId: 'c'.repeat(32), chatId: 'a' });
      await m.idle();
      expect(fs.existsSync(out)).toBe(true); // 상태 파일 없는 고아
      vi.restoreAllMocks();
      m.sweep();
      expect(fs.readdirSync(dir).filter((n) => n !== '.tmp')).toEqual([]);
    });
  });
});
