// server/test/appearance-api.test.ts
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { AppearanceStore } from '../src/state/appearance.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const h = makeHarness();
  const state = new StateStore(h.dataDir);
  const appearance = new AppearanceStore(state.db, h.dataDir);
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state, appearance });
  opened.push(app);
  return { h, app, appearance };
}
const j = (r: { body: string }) => JSON.parse(r.body);
type App = Awaited<ReturnType<typeof setup>>['app'];
const create = (app: App, payload: unknown) => app.inject({ method: 'POST', url: '/api/themes', payload: payload as object });

describe('themes API', () => {
  it('creates, lists, reads, updates and deletes a theme', async () => {
    const { app, h } = await setup();
    const c = await create(app, { name: '밤바다', base: 'dark', css: ':root[data-theme]{--bg:#000000;}' });
    expect(c.statusCode).toBe(201);
    const { theme } = j(c) as { theme: { id: string } };
    expect(theme).toEqual({ id: theme.id, name: '밤바다', base: 'dark', updatedAt: h.clock.now() });
    expect(j(await app.inject('/api/themes'))).toEqual({ themes: [theme] });
    expect(j(await app.inject(`/api/themes/${theme.id}`))).toEqual({ ...theme, css: ':root[data-theme]{--bg:#000000;}' });
    const u = await app.inject({ method: 'PUT', url: `/api/themes/${theme.id}`, payload: { base: 'sepia' } });
    expect(u.statusCode).toBe(200);
    expect(j(u).theme).toMatchObject({ id: theme.id, base: 'sepia' });
    expect((await app.inject({ method: 'DELETE', url: `/api/themes/${theme.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/themes/${theme.id}` })).statusCode).toBe(404);
    expect((await app.inject(`/api/themes/${theme.id}`)).statusCode).toBe(404);
  });

  it('validates bodies: unknown keys, bad base, bad name, size, count', async () => {
    const { app } = await setup();
    expect((await create(app, { name: 'x', base: 'light', css: '', extra: 1 })).statusCode).toBe(400);
    expect((await create(app, { name: 'x', base: 'system', css: '' })).statusCode).toBe(400);
    expect((await create(app, { name: 'x', base: 'light' })).statusCode).toBe(400);
    expect(j(await create(app, { name: 'a*/b', base: 'light', css: '' }))).toEqual({ error: 'bad-name' });
    const big = await create(app, { name: 'x', base: 'light', css: '가'.repeat(90_000) });
    expect(big.statusCode).toBe(413);
    expect(j(big)).toEqual({ error: 'too-large' });
    for (let i = 0; i < 50; i++) expect((await create(app, { name: `t${i}`, base: 'light', css: '' })).statusCode).toBe(201);
    const over = await create(app, { name: 'over', base: 'light', css: '' });
    expect(over.statusCode).toBe(409);
    expect(j(over)).toEqual({ error: 'too-many' });
    expect((await app.inject({ method: 'PUT', url: `/api/themes/${'0'.repeat(32)}`, payload: { css: '' } })).statusCode).toBe(404);
    expect((await app.inject('/api/themes/not-an-id')).statusCode).toBe(400);
  });

  it('serves theme.css with type, nosniff and cache by version', async () => {
    const { app } = await setup();
    const { theme } = j(await create(app, { name: 'x', base: 'light', css: 'body{color:red}' })) as { theme: { id: string; updatedAt: number } };
    const plain = await app.inject(`/api/themes/${theme.id}/theme.css`);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
    expect(plain.headers['cache-control']).toBe('no-cache');
    expect(plain.body).toBe('body{color:red}');
    const versioned = await app.inject(`/api/themes/${theme.id}/theme.css?v=${theme.updatedAt}`);
    expect(versioned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject(`/api/themes/${theme.id}/theme.css?v=${theme.updatedAt + 1}`)).headers['cache-control']).toBe('no-cache');
    expect((await app.inject(`/api/themes/${theme.id}/theme.css?v=abc`)).statusCode).toBe(400);
    expect((await app.inject(`/api/themes/${'0'.repeat(32)}/theme.css`)).statusCode).toBe(404);
  });

  it('download adds the header comment and an attachment file name', async () => {
    const { app } = await setup();
    const { theme } = j(await create(app, { name: '밤/바다', base: 'dark', css: 'p{}' })) as { theme: { id: string } };
    const d = await app.inject(`/api/themes/${theme.id}/download`);
    expect(d.statusCode).toBe(200);
    expect(d.body).toBe('/* @page-theme\n   name: 밤/바다\n   base: dark\n*/\np{}');
    expect(d.headers['content-disposition']).toBe(`attachment; filename="theme.css"; filename*=UTF-8''${encodeURIComponent('밤바다.css')}`);
    expect(d.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(d.headers['x-content-type-options']).toBe('nosniff');
    expect(d.headers['cache-control']).toBe('no-store');
  });

  it('download file name percent-encodes RFC 8187 reserved characters', async () => {
    const { app } = await setup();
    const { theme } = j(await create(app, { name: "a'(b)*", base: 'light', css: '' })) as { theme: { id: string } };
    const d = await app.inject(`/api/themes/${theme.id}/download`);
    expect(d.headers['content-disposition']).toContain("filename*=UTF-8''a%27%28b%29.css");
  });

  it('octet-stream parser does not leak to theme routes', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/themes', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(r.statusCode).toBe(415);
  });

  it('no appearance dep → no theme routes', async () => {
    const h = makeHarness();
    const state = new StateStore(h.dataDir);
    const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state });
    opened.push(app);
    expect((await app.inject('/api/themes')).statusCode).toBe(404);
  });
});

const fakeFont = (tag: string, size = 64): Buffer => { const b = Buffer.alloc(size); b.write(tag, 0, 'latin1'); return b; };
const upload = (app: App, family: string, body: Buffer, type = 'application/octet-stream') =>
  app.inject({ method: 'POST', url: `/api/fonts?family=${encodeURIComponent(family)}`, headers: { 'content-type': type }, payload: body });

describe('fonts API', () => {
  it('uploads, lists, serves the file and fonts.css, renames and deletes', async () => {
    const { app } = await setup();
    const up = await upload(app, '나눔 명조', fakeFont('wOF2'));
    expect(up.statusCode).toBe(201);
    const { font } = j(up) as { font: { id: string; family: string } };
    expect(font).toMatchObject({ family: '나눔 명조', format: 'woff2', size: 64 });
    expect(j(await app.inject('/api/fonts')).fonts).toEqual([font]);

    const file = await app.inject(`/api/fonts/${font.id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('font/woff2');
    expect(file.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.subarray(0, 4).toString('latin1')).toBe('wOF2');

    const css = await app.inject('/api/fonts.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('no-cache');
    expect(css.body).toContain(`font-family: "나눔 명조"; src: url("/api/fonts/${font.id}") format("woff2")`);
    const etag = css.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect((await app.inject({ url: '/api/fonts.css', headers: { 'if-none-match': etag } })).statusCode).toBe(304);

    const ren = await app.inject({ method: 'PATCH', url: `/api/fonts/${font.id}`, payload: { family: '명조' } });
    expect(j(ren).font).toMatchObject({ family: '명조' });
    const css2 = await app.inject('/api/fonts.css');
    expect(css2.body).toContain('"명조"');
    expect(css2.headers.etag).not.toBe(etag);

    expect((await app.inject({ method: 'DELETE', url: `/api/fonts/${font.id}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/fonts/${font.id}`)).statusCode).toBe(404);
    expect((await app.inject('/api/fonts.css')).body).toBe('');
  });

  it('404s (not 500, not immutable) when the font row exists but the file is gone', async () => {
    const { app, appearance } = await setup();
    const { font } = j(await upload(app, 'Gone', fakeFont('wOF2'))) as { font: { id: string } };
    fs.rmSync(appearance.fontFile(appearance.getFont(font.id)!));
    const r = await app.inject(`/api/fonts/${font.id}`);
    expect(r.statusCode).toBe(404);
    expect(String(r.headers['cache-control'] ?? '')).not.toContain('immutable');
  });

  it('rejects bad fonts, bad names, taken names, wrong types and oversize bodies', async () => {
    const { app } = await setup();
    expect(j(await upload(app, 'x', fakeFont('wOFF')))).toEqual({ error: 'bad-font' });
    expect(j(await upload(app, 'a"b', fakeFont('wOF2')))).toEqual({ error: 'bad-family' });
    expect((await upload(app, 'Maru', fakeFont('OTTO'))).statusCode).toBe(201);
    const taken = await upload(app, 'maru', fakeFont('OTTO'));
    expect(taken.statusCode).toBe(409);
    expect(j(taken)).toEqual({ error: 'family-taken' });
    expect((await app.inject({ method: 'POST', url: '/api/fonts?family=x', payload: { a: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/fonts' , headers: { 'content-type': 'application/octet-stream' }, payload: fakeFont('wOF2') })).statusCode).toBe(400);
    expect((await upload(app, 'big', Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await app.inject({ method: 'PATCH', url: `/api/fonts/${'0'.repeat(32)}`, payload: { family: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/fonts/${'0'.repeat(32)}`, payload: { family: 'x', extra: 1 } })).statusCode).toBe(400);
  });
});
