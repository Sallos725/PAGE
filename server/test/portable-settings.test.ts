import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '../src/portable/settings.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-ps-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('settings.json', () => {
  it('없으면 원본 없음', () => {
    expect(readSettings(tmp())).toEqual({ settings: { version: 1, pocketrisu: null }, broken: false });
  });
  it('쓴 것을 그대로 읽는다 (쉼표·= 가 든 경로도)', () => {
    const d = tmp();
    const dir = path.join(d, 'a,b=c', 'save');
    writeSettings(d, { version: 1, pocketrisu: { dir } });
    expect(readSettings(d).settings.pocketrisu).toEqual({ dir });
    expect(fs.readdirSync(d).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
  it('깨진 JSON·모르는 version·상대 경로는 broken + 원본 없음', () => {
    for (const body of ['{', '{"version":2,"pocketrisu":null}', '{"version":1,"pocketrisu":{"dir":"rel/save"}}']) {
      const d = tmp();
      fs.writeFileSync(path.join(d, 'settings.json'), body);
      expect(readSettings(d)).toEqual({ settings: { version: 1, pocketrisu: null }, broken: true });
    }
  });
  it('ENOENT 만 정상 "없음", 읽기 실패(EISDIR 등)는 broken', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'settings.json'));
    expect(readSettings(d)).toEqual({ settings: { version: 1, pocketrisu: null }, broken: true });
  });
  it('앞의 UTF-8 BOM 은 벗기고 읽는다 (메모장)', () => {
    const d = tmp();
    const dir = path.join(d, 'save');
    fs.writeFileSync(path.join(d, 'settings.json'), '\uFEFF' + JSON.stringify({ version: 1, pocketrisu: { dir } }));
    expect(readSettings(d)).toEqual({ settings: { version: 1, pocketrisu: { dir } }, broken: false });
  });
  it('UNC 경로는 읽을 때도 broken', () => {
    for (const dir of ['\\\\host\\share\\save', '//host/share/save']) {
      const d = tmp();
      fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ version: 1, pocketrisu: { dir } }));
      expect(readSettings(d)).toEqual({ settings: { version: 1, pocketrisu: null }, broken: true });
    }
  });
});
