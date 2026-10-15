import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSettings } from '../src/portable/settings.js';
import { loadConfig } from '../src/config.js';
import { loggerOptions } from '../src/api/logging.js';

const env = (o: Record<string, string>) => ({ PAGE_DATA_DIR: '/data', PAGE_SOURCES: 'main=/sources/main', ...o });

describe('loadConfig', () => {
  it('parses sources and applies defaults (D13/D17 provisional values)', () => {
    const c = loadConfig(env({ PAGE_SOURCES: 'main=/sources/main,alt=/sources/alt' }));
    expect(c.sources).toEqual([{ id: 'main', dir: '/sources/main' }, { id: 'alt', dir: '/sources/alt' }]);
    expect(c).toMatchObject({
      dataDir: '/data', bind: '127.0.0.1', port: 8787,
      syncIntervalMs: 15 * 60_000, debounceMs: 10 * 60_000,
      warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9,
      exportImageBudgetBytes: 300 * 1024 * 1024,
    });
  });
  it('PAGE_SOURCES is optional while importing is on; PAGE_IMPORT=0 turns the imported source off', () => {
    const none = { PAGE_DATA_DIR: '/data' };
    expect(loadConfig(none)).toMatchObject({ sources: [], importEnabled: true });
    expect(loadConfig({ ...none, PAGE_SOURCES: '' })).toMatchObject({ sources: [], importEnabled: true });
    expect(() => loadConfig({ ...none, PAGE_IMPORT: '0' })).toThrow('PAGE_SOURCES is required when PAGE_IMPORT=0');
    expect(loadConfig(env({}))).toMatchObject({ importEnabled: true });
    expect(loadConfig(env({ PAGE_IMPORT: '0' }))).toMatchObject({ sources: [{ id: 'main', dir: '/sources/main' }], importEnabled: false });
    expect(loadConfig(env({ PAGE_IMPORT: '1' })).importEnabled).toBe(true);
  });
  it('overrides via env', () => {
    const c = loadConfig(env({ PAGE_BIND: '0.0.0.0', PAGE_PORT: '9000', PAGE_SYNC_INTERVAL_MIN: '5', PAGE_VERSION_DEBOUNCE_MIN: '1', PAGE_WARN_FREE_PCT: '30', PAGE_WARN_FREE_GB: '5', PAGE_STOP_ASSETS_FREE_GB: '1', PAGE_EXPORT_IMAGE_BUDGET_MB: '50' }));
    expect(c).toMatchObject({ bind: '0.0.0.0', port: 9000, syncIntervalMs: 300_000, debounceMs: 60_000, warnFreePct: 30, warnFreeBytes: 5e9, stopAssetsFreeBytes: 1e9, exportImageBudgetBytes: 50 * 1024 * 1024 });
  });
  it('PAGE_PDF_URL is optional (empty -> null) and must be an http(s) URL', () => {
    expect(loadConfig(env({})).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: '' })).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: '  ' })).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: 'http://page-pdf:8790' })).pdfUrl).toBe('http://page-pdf:8790');
    expect(loadConfig(env({ PAGE_PDF_URL: 'https://pdf.example/' })).pdfUrl).toBe('https://pdf.example/');
    for (const bad of ['page-pdf:8790', 'file:///etc/passwd', 'ftp://x', 'javascript:alert(1)', 'not a url', '//page-pdf']) {
      expect(() => loadConfig(env({ PAGE_PDF_URL: bad }))).toThrow(/PAGE_PDF_URL/);
    }
  });
  it('PAGE_PDF_URL rejects userinfo, query and hash, and never echoes the bad value', () => {
    for (const bad of ['http://hunter2:secret@page-pdf:8790', 'http://user@page-pdf:8790', 'http://page-pdf:8790/?q=tok123', 'http://page-pdf:8790/#zzhash', 'http://page-pdf:8790?x', 'http://page-pdf:8790#']) {
      let msg = '';
      try { loadConfig(env({ PAGE_PDF_URL: bad })); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/PAGE_PDF_URL/);
      for (const leak of ['secret', 'hunter2', 'tok123', 'zzhash', 'page-pdf', '8790']) expect(msg).not.toContain(leak);
    }
    let msg = '';
    try { loadConfig(env({ PAGE_PDF_URL: 'file:///etc/passwd' })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/PAGE_PDF_URL/);
    expect(msg).not.toContain('passwd');
  });
  it('PAGE_WEB_DIR is optional and resolved to an absolute path', () => {
    expect(loadConfig(env({})).webDir).toBeUndefined();
    // Windows 는 D:\...\web\dist 꼴이라 구분자를 path 로 맞춘다
    const webDir = loadConfig(env({ PAGE_WEB_DIR: 'web/dist' })).webDir!;
    expect(path.isAbsolute(webDir)).toBe(true);
    expect(webDir.endsWith(path.join('web', 'dist'))).toBe(true);
  });
  it.each([
    [{ PAGE_SOURCES: '', PAGE_IMPORT: '0' }, /PAGE_SOURCES is required when PAGE_IMPORT=0/],
    [{ PAGE_SOURCES: 'imported=/x' }, /reserved source name/],
    [{ PAGE_SOURCES: 'main=/a,imported=/x' }, /reserved source name/],
    [{ PAGE_SOURCES: 'main' }, /name=path/],
    [{ PAGE_SOURCES: 'a=/x,a=/y' }, /duplicate/],
    [{ PAGE_SOURCES: 'bad name=/x' }, /source name/],
    [{ PAGE_SOURCES: 'a=relative/path' }, /absolute/],
    [{ PAGE_DATA_DIR: '' }, /PAGE_DATA_DIR/],
    [{ PAGE_PORT: 'abc' }, /PAGE_PORT/],
    [{ PAGE_PRESERVE_ORPHANS: '1' }, /not implemented/],
  ])('rejects bad config %j', (o, msg) => {
    expect(() => loadConfig(env(o))).toThrow(msg);
  });
});

describe('logger options', () => {
  it('serializes requests without url, query or body', () => {
    const o = loggerOptions('info');
    const req = o.serializers.req({ method: 'GET', url: '/api/chat/x/messages?source=main&char=SECRET', routeOptions: { url: '/api/chat/:id/messages' } } as never);
    expect(req).toEqual({ method: 'GET', route: '/api/chat/:id/messages' });
    expect(JSON.stringify(req)).not.toMatch(/SECRET|source=/);
    expect(o.serializers.res({ statusCode: 200 } as never)).toEqual({ statusCode: 200 });
    expect(o.serializers.err({ type: 'Error', message: 'has SECRET content', stack: 'trace SECRET' } as never)).toEqual({ type: 'Error' });
  });
});

describe('포터블 모드', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-cfg-')); dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const base = (d: string, extra: Record<string, string> = {}) => ({ PAGE_DATA_DIR: d, PAGE_PORTABLE: '1', ...extra });
  it('원본은 settings.json 에서, PAGE_SOURCES·PAGE_IMPORT·PAGE_BIND·PAGE_ALLOWED_HOSTS 는 무시', () => {
    const d = tmp();
    const save = path.join(d, 'x,y', 'save');
    writeSettings(d, { version: 1, pocketrisu: { dir: save } });
    const c = loadConfig(base(d, { PAGE_SOURCES: 'main=/elsewhere', PAGE_IMPORT: '0', PAGE_BIND: '0.0.0.0', PAGE_PORT: '9001', PAGE_ALLOWED_HOSTS: 'evil.example.com' }));
    expect(c.portable).toBe(true);
    expect(c.sources).toEqual([{ id: 'pocketrisu', dir: save }]);
    expect(c.importEnabled).toBe(true);
    expect(c.bind).toBe('127.0.0.1');
    expect(c.allowedHosts).toEqual(['127.0.0.1:9001', 'localhost:9001', '[::1]:9001']);
    expect(c.settingsBroken).toBeUndefined();
  });
  it('settings.json 이 없으면 임포트 전용(settingsBroken 없음), 깨졌으면 settingsBroken', () => {
    const d = tmp();
    const none = loadConfig(base(d));
    expect(none.sources).toEqual([]);
    expect(none.settingsBroken).toBeUndefined();
    expect('settingsBroken' in none).toBe(false);
    fs.writeFileSync(path.join(d, 'settings.json'), '{');
    const c = loadConfig(base(d));
    expect(c.sources).toEqual([]);
    expect(c.settingsBroken).toBe(true);
  });
});

describe('PAGE_ALLOWED_HOSTS', () => {
  const e = { PAGE_DATA_DIR: '/tmp/x', PAGE_SOURCES: 'main=/s' };
  it('없으면 검사 안 함(null)', () => { expect(loadConfig(e).allowedHosts).toBeNull(); });
  it('쉼표 목록을 소문자로, 루프백 이름(포트 무관)을 늘 더한다', () => {
    expect(loadConfig({ ...e, PAGE_ALLOWED_HOSTS: ' Page.Example.com , localhost:6008,[::1]:6008' }).allowedHosts)
      .toEqual(['page.example.com', 'localhost:6008', '[::1]:6008', '127.0.0.1', 'localhost', '[::1]']);
  });
  it('루프백 이름은 이미 있으면 한 번만', () => {
    expect(loadConfig({ ...e, PAGE_ALLOWED_HOSTS: 'page.example.com,LOCALHOST,127.0.0.1' }).allowedHosts)
      .toEqual(['page.example.com', 'localhost', '127.0.0.1', '[::1]']);
  });
  it('공백뿐인 값·빈 항목뿐인 값: 완전히 빈 값만 null, 나머지는 거절', () => {
    expect(loadConfig({ ...e, PAGE_ALLOWED_HOSTS: '' }).allowedHosts).toBeNull();
    expect(loadConfig({ ...e, PAGE_ALLOWED_HOSTS: '   ' }).allowedHosts).toBeNull();
    expect(() => loadConfig({ ...e, PAGE_ALLOWED_HOSTS: ' , ' })).toThrow('PAGE_ALLOWED_HOSTS entries must be host or host:port');
    expect(() => loadConfig({ ...e, PAGE_ALLOWED_HOSTS: ',' })).toThrow('PAGE_ALLOWED_HOSTS entries must be host or host:port');
  });
  it('형식이 틀리면 거절 (값은 에코하지 않음)', () => {
    expect(() => loadConfig({ ...e, PAGE_ALLOWED_HOSTS: 'http://x' })).toThrow('PAGE_ALLOWED_HOSTS entries must be host or host:port');
  });
});
