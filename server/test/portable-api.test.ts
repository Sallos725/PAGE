import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { readSettings } from '../src/portable/settings.js';
import type { BrowseResult } from '../src/portable/browse.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

// LIFO: 앱 → state → store 순으로 닫는다 (Windows 에서 열린 DB 는 지울 수 없다)
const cleanups: (() => unknown)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = (r: { body: string }) => JSON.parse(r.body);
const json = { 'content-type': 'application/json' };

async function setup(o: { portable?: boolean; browse?: () => Promise<BrowseResult> } = {}) {
  const h = makeHarness();
  const state = new StateStore(h.dataDir);
  const restart = vi.fn();
  const app = await buildApp({
    adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state,
    ...(o.portable === false ? {} : { portable: true, portableApi: { dataDir: h.dataDir, platform: 'win32' as const, browse: o.browse ?? (async () => ({ cancelled: true as const })), restart } }),
  });
  cleanups.push(() => h.store.close(), () => state.close(), () => app.close());
  const pocket = path.join(h.dataDir, 'PocketRisu합성');
  fs.mkdirSync(path.join(pocket, 'save'), { recursive: true });
  fs.writeFileSync(path.join(pocket, 'save', 'risuai.db'), '');
  return { h, app, restart, pocket };
}

describe('/api/portable', () => {
  it('포터블이 아니면 404', async () => {
    const { app } = await setup({ portable: false });
    expect((await app.inject({ method: 'GET', url: '/api/portable/source' })).statusCode).toBe(404);
  });
  it('처음엔 연결 없음 + platform', async () => {
    const { app } = await setup();
    expect(j(await app.inject({ method: 'GET', url: '/api/portable/source' }))).toEqual({ connected: null, platform: 'win32' });
  });
  it('check 는 판별만 (저장 안 함)', async () => {
    const { app, h, pocket, restart } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/portable/source/check', headers: json, payload: { path: pocket } });
    expect(j(r)).toEqual({ ok: true, kind: 'pocketrisu', saveDir: path.join(pocket, 'save') });
    expect(j(await app.inject({ method: 'POST', url: '/api/portable/source/check', headers: json, payload: { path: 'rel' } }))).toEqual({ ok: false, reason: 'not-absolute' });
    expect(readSettings(h.dataDir).settings.pocketrisu).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });
  it('PUT 은 settings.json 에 save 폴더를 쓰고 202 뒤 다시 켠다', async () => {
    const { app, h, pocket, restart } = await setup();
    const r = await app.inject({ method: 'PUT', url: '/api/portable/source', headers: json, payload: { path: pocket } });
    expect(r.statusCode).toBe(202);
    expect(j(r)).toEqual({ restarting: true });
    expect(readSettings(h.dataDir).settings.pocketrisu).toEqual({ dir: path.join(pocket, 'save') });
    await wait(120);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it('PUT 판별 실패는 400 + 이유, 저장·재시작 없음', async () => {
    const { app, h, restart } = await setup();
    const r = await app.inject({ method: 'PUT', url: '/api/portable/source', headers: json, payload: { path: h.dataDir } });
    expect(r.statusCode).toBe(400);
    expect(j(r)).toEqual({ error: 'not-found' });
    expect(readSettings(h.dataDir).settings.pocketrisu).toBeNull();
    await wait(120);
    expect(restart).not.toHaveBeenCalled();
  });
  // 권한 오류 재현은 POSIX 일반 사용자에서만 (root 는 권한을 무시한다)
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('PUT 권한 오류는 400 unreadable', async () => {
    const { app, h, pocket, restart } = await setup();
    fs.chmodSync(pocket, 0o000);
    cleanups.push(() => fs.chmodSync(pocket, 0o755));
    const r = await app.inject({ method: 'PUT', url: '/api/portable/source', headers: json, payload: { path: pocket } });
    expect([r.statusCode, j(r)]).toEqual([400, { error: 'unreadable' }]);
    expect(readSettings(h.dataDir).settings.pocketrisu).toBeNull();
    await wait(120);
    expect(restart).not.toHaveBeenCalled();
  });
  it('DELETE 는 연결 해제 후 다시 켠다', async () => {
    const { app, h, pocket, restart } = await setup();
    await app.inject({ method: 'PUT', url: '/api/portable/source', headers: json, payload: { path: pocket } });
    const r = await app.inject({ method: 'DELETE', url: '/api/portable/source' });
    expect(r.statusCode).toBe(202);
    expect(readSettings(h.dataDir).settings.pocketrisu).toBeNull();
    await wait(120);
    expect(restart).toHaveBeenCalledTimes(2);
  });
  it('browse: 결과 그대로 / 501 / 409 / 500', async () => {
    const results: BrowseResult[] = [{ path: 'C:\\합성' }, { error: 'browse-unavailable' }, { error: 'busy' }, { error: 'browse-failed' }];
    const { app } = await setup({ browse: async () => results.shift()! });
    const call = () => app.inject({ method: 'POST', url: '/api/portable/browse', headers: json, payload: {} });
    const a = await call(); expect([a.statusCode, j(a)]).toEqual([200, { path: 'C:\\합성' }]);
    const b = await call(); expect([b.statusCode, j(b)]).toEqual([501, { error: 'browse-unavailable' }]);
    const c = await call(); expect([c.statusCode, j(c)]).toEqual([409, { error: 'busy' }]);
    const d = await call(); expect([d.statusCode, j(d)]).toEqual([500, { error: 'browse-failed' }]);
  });
  it('JSON 이 아닌 본문은 거절 (교차 출처 단순 요청)', async () => {
    const { app, pocket } = await setup();
    const r = await app.inject({ method: 'PUT', url: '/api/portable/source', headers: { 'content-type': 'text/plain' }, payload: pocket });
    expect(r.statusCode).toBe(415);
  });
});
