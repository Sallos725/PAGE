import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const h = makeHarness();
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'page-web-'));
  fs.mkdirSync(path.join(web, 'assets'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>PAGE</title><div id="app"></div>');
  fs.writeFileSync(path.join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state: new StateStore(h.dataDir), webDir: web });
  opened.push(app);
  return { app };
}

describe('SPA serving', () => {
  it('serves index.html at / with a strict CSP (no upgrade-insecure-requests, no HSTS)', async () => {
    const { app } = await setup();
    const r = await app.inject('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<div id="app">');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('falls back to index.html for client routes, but never for /api', async () => {
    const { app } = await setup();
    const spa = await app.inject('/read/main/c1/a1');
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<div id="app">');
    const api = await app.inject('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(JSON.parse(api.body)).toEqual({ error: 'not found' });
    expect((await app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
  });

  it('hashed assets are immutable; index.html is not cached', async () => {
    const { app } = await setup();
    const asset = await app.inject('/assets/app-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(String(asset.headers['cache-control'])).toContain('immutable');
    expect(String(asset.headers['cache-control'])).toContain('max-age=31536000');
    expect(String((await app.inject('/')).headers['cache-control'])).toContain('no-cache');
  });

  it('does not escape the web root', async () => {
    const { app } = await setup();
    const r = await app.inject('/%2e%2e/%2e%2e/%2e%2e/etc/passwd');
    expect(r.body).not.toContain('root:');
  });

  it('API routes still work with the SPA enabled', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });
});
