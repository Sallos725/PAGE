// 덮어쓰기 rename·파일 지우기가 Windows 의 순간 잠금(EPERM·EBUSY)을 한 번 만나도 다시 해서 끝나는지 (fs-retry 를 쓰는 자리들).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportManager, noWarnings } from '../src/export/jobs.js';
import { ImportStore } from '../src/import/store.js';
import { LibraryStore } from '../src/library/store.js';
import { readSettings, writeSettings } from '../src/portable/settings.js';
import { AppearanceStore } from '../src/state/appearance.js';
import { __setRetryPlatformForTest } from '../src/util/fs-retry.js';
import { StateStore } from '../src/state/store.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
// 다시 하기는 win32 에서만 한다. 이 테스트는 Linux 에서도 그 경로를 보도록 win32 로 둔다.
beforeEach(() => { __setRetryPlatformForTest('win32'); });
afterEach(() => {
  __setRetryPlatformForTest();
  vi.restoreAllMocks();
  while (closers.length) closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-fsr-')); dirs.push(d); return d; };
const lockErr = (code: string) => Object.assign(new Error(code), { code });

/** fs[name] 이 처음 times 번은 code 로 실패하고 그다음부터 원래대로 동작하게 한다. */
function failFirst<K extends 'renameSync' | 'rmSync'>(name: K, code: string, times = 1, when: (p: string) => boolean = () => true) {
  const real = fs[name].bind(fs) as (...a: unknown[]) => unknown;
  let left = times;
  const spy = vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
    if (left > 0 && when(String(a[0]))) { left--; throw lockErr(code); }
    return real(...a);
  }) as never);
  return { spy, left: () => left };
}

describe('잠깐 잠긴 파일을 다시 해 본다', () => {
  it('writeSettings: 덮어쓰기 rename 이 EPERM 한 번이면 다시 해서 쓴다', () => {
    const d = tmp();
    writeSettings(d, { version: 1, pocketrisu: null });
    const f = failFirst('renameSync', 'EPERM');
    writeSettings(d, { version: 1, pocketrisu: { dir: path.resolve(d, 'save') } });
    expect(f.left()).toBe(0);
    expect(readSettings(d).settings.pocketrisu).toEqual({ dir: path.resolve(d, 'save') });
  });

  it('ImportStore: char.json 쓰기(rename)와 캐릭터 지우기(rm)가 잠금을 넘긴다', () => {
    const s = new ImportStore(tmp());
    const c = s.createChar('합성', 1);
    const r = failFirst('renameSync', 'EACCES');
    expect(s.renameChar(c, '새 이름')).toBe(true);
    expect(r.left()).toBe(0);
    expect(s.getChar(c)?.name).toBe('새 이름');
    vi.restoreAllMocks();
    const m = failFirst('rmSync', 'EBUSY', 2);
    expect(s.deleteChar(c)).toBe(true);
    expect(m.left()).toBe(0);
    expect(s.charDirExists(c)).toBe(false);
  });

  it('LibraryStore.putAssetBlob: rename 이 EBUSY 한 번이면 다시 해서 blob 을 남긴다', () => {
    const s = new LibraryStore(tmp());
    closers.push(() => s.close());
    const h = 'ab'.repeat(32);
    const f = failFirst('renameSync', 'EBUSY');
    s.putAssetBlob(h, 'image/png', Buffer.from([1, 2, 3]), 1);
    expect(f.left()).toBe(0);
    expect(fs.readFileSync(s.blobPath(h))).toEqual(Buffer.from([1, 2, 3]));
    expect(s.hasAsset(h)).toBe(true);
  });

  it('AppearanceStore.addFont: rename 이 EPERM 한 번이면 다시 해서 글꼴을 넣는다', () => {
    const d = tmp();
    const state = new StateStore(d);
    closers.push(() => state.close());
    const a = new AppearanceStore(state.db, d);
    const font = Buffer.alloc(64);
    font.write('wOF2', 0, 'latin1');
    const f = failFirst('renameSync', 'EPERM');
    const meta = a.addFont('합성 글꼴', font, 1);
    expect(f.left()).toBe(0);
    expect(typeof meta).toBe('object');
    expect(fs.existsSync(a.fontFile(meta as Exclude<typeof meta, string>))).toBe(true);
  });

  it('ExportManager: 결과 파일 rename 이 EPERM 한 번이면 다시 해서 done', async () => {
    const m = new ExportManager({ dir: path.join(tmp(), 'exports'), now: () => 1 });
    const f = failFirst('renameSync', 'EPERM');
    const job = m.start('json', async (t) => { fs.writeFileSync(t, '{}'); return { warnings: noWarnings() }; })!;
    await m.idle();
    expect(f.left()).toBe(0);
    expect(m.get(job.jobId)?.state).toBe('done');
  });

  it('ExportManager: rename 을 다시 하는 사이에 지워진 작업은 결과 파일을 남기지 않는다', async () => {
    const dir = path.join(tmp(), 'exports');
    const m = new ExportManager({ dir, now: () => 1 });
    const real = fs.renameSync.bind(fs);
    let first = true;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      if (first) { first = false; m.purgeOwned(() => true); throw lockErr('EPERM'); } // 잠긴 사이에 채팅이 지워졌다
      return real(a, b);
    }) as typeof fs.renameSync);
    const job = m.start('json', async (t) => { fs.writeFileSync(t, '{}'); return { warnings: noWarnings() }; }, { source: 'imported', charId: 'c', chatId: 'a' })!;
    await m.idle();
    expect(first).toBe(false);
    expect(m.get(job.jobId)).toBeNull();
    expect(fs.readdirSync(dir).filter((n) => n !== '.tmp')).toEqual([]);
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
  });
});
