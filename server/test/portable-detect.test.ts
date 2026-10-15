import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSource } from '../src/portable/detect.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-det-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const touch = (f: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); };

describe('detectSource', () => {
  it('PocketRisu 폴더(save\\risuai.db) → save 폴더', () => {
    const d = tmp(); touch(path.join(d, 'save', 'risuai.db'));
    expect(detectSource(d)).toEqual({ ok: true, kind: 'pocketrisu', saveDir: path.join(d, 'save') });
  });
  it('save 폴더 자체도 된다', () => {
    const d = tmp(); touch(path.join(d, 'risuai.db'));
    expect(detectSource(d)).toEqual({ ok: true, kind: 'pocketrisu', saveDir: d });
  });
  it('탐색기 "경로로 복사" 의 따옴표와 앞뒤 공백을 벗긴다', () => {
    const d = tmp(); touch(path.join(d, 'save', 'risuai.db'));
    expect(detectSource(`  "${d}"  `)).toMatchObject({ ok: true });
  });
  it('없으면 not-found, risuai.db 가 폴더면 not-found', () => {
    const d = tmp();
    expect(detectSource(d)).toEqual({ ok: false, reason: 'not-found' });
    fs.mkdirSync(path.join(d, 'risuai.db'));
    expect(detectSource(d)).toEqual({ ok: false, reason: 'not-found' });
    expect(detectSource(path.join(d, 'nope'))).toEqual({ ok: false, reason: 'not-found' });
  });
  it('상대 경로·빈 값은 not-absolute, UNC 는 unc', () => {
    expect(detectSource('save')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(detectSource('')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(detectSource('\\\\server\\share\\PocketRisu')).toEqual({ ok: false, reason: 'unc' });
    expect(detectSource('//server/share/PocketRisu')).toEqual({ ok: false, reason: 'unc' });
  });
  it('구분자가 섞인 UNC 도 unc', () => {
    expect(detectSource('\\/srv/share')).toEqual({ ok: false, reason: 'unc' });
    expect(detectSource('/\\srv\\share')).toEqual({ ok: false, reason: 'unc' });
  });
  it('ENOENT·EINVAL 등은 not-found, EACCES·EPERM 만 unreadable', () => {
    const d = tmp();
    for (const code of ['EACCES', 'EPERM']) {
      const spy = vi.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('x'), { code }); });
      expect(detectSource(d)).toEqual({ ok: false, reason: 'unreadable' });
      spy.mockRestore();
    }
    for (const code of ['ENOTDIR', 'ENOENT', 'EINVAL', 'ENAMETOOLONG']) {
      const spy = vi.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('x'), { code }); });
      expect(detectSource(d)).toEqual({ ok: false, reason: 'not-found' });
      spy.mockRestore();
    }
  });
});
