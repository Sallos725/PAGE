import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/api/logging.js';
import { hostAllowed } from '../src/api/host-check.js';
import { buildApp } from '../src/api/app.js';
import { makeHarness } from './helpers/harness.js';
import { StateStore } from '../src/state/store.js';
import { loadConfig } from '../src/config.js';

describe('hostAllowed', () => {
  const portable = ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787'];
  it('포터블 목록', () => {
    expect(hostAllowed('127.0.0.1:8787', portable)).toBe(true);
    expect(hostAllowed('LOCALHOST:8787', portable)).toBe(true);
    expect(hostAllowed('[::1]:8787', portable)).toBe(true);
    expect(hostAllowed('localhost:9999', portable)).toBe(false);
    expect(hostAllowed('evil.example:8787', portable)).toBe(false);
    expect(hostAllowed(undefined, portable)).toBe(false);
    expect(hostAllowed('', portable)).toBe(false);
  });
  it('포트 없는 항목은 어느 포트든 허용', () => {
    expect(hostAllowed('page.example.com', ['page.example.com'])).toBe(true);
    expect(hostAllowed('page.example.com:443', ['page.example.com'])).toBe(true);
    expect(hostAllowed('page.example.com.evil:443', ['page.example.com'])).toBe(false);
  });
});

describe('Host 훅 · health', () => {
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  async function app(allowedHosts: string[] | null, portable = false) {
    const h = makeHarness();
    const state = new StateStore(h.dataDir);
    const a = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state, allowedHosts, portable });
    cleanups.push(() => h.store.close(), () => state.close(), () => a.close()); // LIFO: 앱 → state → store
    return a;
  }
  it('목록 밖 Host 는 421 bad-host, 목록 안은 통과', async () => {
    const a = await app(['127.0.0.1:8787']);
    const bad = await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:8787' } });
    expect(bad.statusCode).toBe(421);
    expect(JSON.parse(bad.body)).toEqual({ error: 'bad-host' });
    const ok = await a.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:8787' } });
    expect(ok.statusCode).toBe(200);
  });
  it('PAGE_ALLOWED_HOSTS=page.example.com 이어도 127.0.0.1:8787 허용 (compose 헬스체크)', async () => {
    const { allowedHosts } = loadConfig({ PAGE_DATA_DIR: '/tmp/x', PAGE_SOURCES: 'main=/s', PAGE_ALLOWED_HOSTS: 'page.example.com' });
    const a = await app(allowedHosts);
    for (const host of ['127.0.0.1:8787', 'localhost:6008', '[::1]:8787', 'page.example.com']) {
      expect((await a.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
    }
    expect((await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:8787' } })).statusCode).toBe(421);
  });
  it('null 이면 검사하지 않음 (Docker 기본)', async () => {
    const a = await app(null);
    expect((await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'anything:1' } })).statusCode).toBe(200);
  });
  it('health 에 app·portable', async () => {
    const a = await app(null, true);
    const b = JSON.parse((await a.inject({ method: 'GET', url: '/api/health' })).body);
    expect(b.app).toBe('page');
    expect(b.portable).toBe(true);
    expect(Array.isArray(b.sources)).toBe(true);
  });
  it('/api/app 은 어댑터 health 를 거치지 않고 app·portable 만', async () => {
    const h = makeHarness();
    const state = new StateStore(h.dataDir);
    let calls = 0;
    const adapter = Object.create(h.adapter);
    adapter.health = async () => { calls++; return h.adapter.health(); };
    const a = await buildApp({ adapters: [adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state, allowedHosts: null, portable: true });
    cleanups.push(() => h.store.close(), () => state.close(), () => a.close());
    const r = await a.inject({ method: 'GET', url: '/api/app' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ app: 'page', portable: true });
    expect(calls).toBe(0);
    expect(JSON.parse((await (await app(null)).inject({ method: 'GET', url: '/api/app' })).body)).toEqual({ app: 'page', portable: false });
  });
  it('webDir(정적·SPA)와 404 핸들러도 막고, 거절 로그에 Host 값이 없다', async () => {
    const h = makeHarness();
    const state = new StateStore(h.dataDir);
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'page-web-'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>PAGE</title><div id="app"></div>');
    const logs: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
    const a = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state, webDir: web, allowedHosts: ['127.0.0.1:8787'], logger: loggerOptions('info', stream) });
    cleanups.push(() => h.store.close(), () => state.close(), () => a.close(), () => fs.rmSync(web, { recursive: true, force: true }));
    const evil = { host: 'evil.example:8787' };
    for (const url of ['/', '/read/main/c1/a1', '/api/nope']) {
      const r = await a.inject({ method: 'GET', url, headers: evil });
      expect(r.statusCode, url).toBe(421);
      expect(JSON.parse(r.body), url).toEqual({ error: 'bad-host' });
    }
    const ok = await a.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:8787' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('<div id="app">');
    const all = logs.join('');
    expect(all).toContain('host not allowed'); // 거절은 기록되되
    expect(all).not.toContain('evil.example'); // Host 값은 남기지 않는다
  });
});
