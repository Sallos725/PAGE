import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { ExportManager } from '../src/export/jobs.js';
import { StateStore } from '../src/state/store.js';
import { AM, PNG_1X1, msg } from '../src/tools/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

type Fake = { url: string; hits: () => number; bodies: Buffer[]; close: () => Promise<void> };
async function fakeSidecar(handler: (res: http.ServerResponse) => void): Promise<Fake> {
  let hits = 0;
  const bodies: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => { if (req.method === 'POST' && req.url === '/render') { hits++; bodies.push(Buffer.concat(parts)); } handler(res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, bodies,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  opened.push(f);
  return f;
}
const pdfOk = (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.7\nsynthetic')); };

async function setup(opts: { maxPending?: number; pdfUrl?: string | null; pdfTimeoutMs?: number } = {}) {
  const h = makeHarness();
  await h.sync();
  const state = new StateStore(h.dataDir);
  const { pdfUrl, pdfTimeoutMs, ...mgr } = opts;
  const exportManager = new ExportManager({ dir: path.join(h.dataDir, 'exports'), now: h.clock.now, ...mgr });
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state, exportManager, pdfUrl, pdfTimeoutMs });
  opened.push(app);
  return { h, app, exportManager };
}
const Q = 'source=main&char=c1&chat=a1';
const post = (app: Awaited<ReturnType<typeof setup>>['app'], q: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/export?${q}`, payload: payload as object });

describe('export API (JSON)', () => {
  it('starts a job, reports done, and downloads an attachment named without chat text', async () => {
    const { app, exportManager } = await setup();
    const r = await post(app, Q, { format: 'json' });
    expect(r.statusCode).toBe(202);
    const { jobId } = JSON.parse(r.body) as { jobId: string };
    expect(jobId).toMatch(/^[0-9a-f]{32}$/);
    await exportManager.idle();
    const st = JSON.parse((await app.inject(`/api/export/${jobId}`)).body);
    expect(st).toMatchObject({ jobId, state: 'done', format: 'json' });
    expect(st.size).toBeGreaterThan(0);
    const dl = await app.inject(`/api/export/${jobId}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="page-\d{8}-[0-9a-f]{8}\.json"$/);
    expect(dl.headers['content-type']).toMatch(/^application\/json/);
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(dl.body)).toMatchObject({ type: 'risuChat', ver: 2, folders: [] });
    expect(dl.headers['content-length']).toBe(String(st.size));
  });

  it('accepts a version of the same chat', async () => {
    const { h, app, exportManager } = await setup();
    const v = h.store.listVersions('main', 'c1', 'a1')[0]!.versionId;
    const r = await post(app, Q, { format: 'json', version: v });
    expect(r.statusCode).toBe(202);
    await exportManager.idle();
    expect(JSON.parse((await app.inject(`/api/export/${JSON.parse(r.body).jobId}`)).body).state).toBe('done');
  });

  it('validates the request', async () => {
    const { h, app } = await setup();
    expect((await post(app, 'source=main&char=c1&chat=nope', { format: 'json' })).statusCode).toBe(404);
    expect((await post(app, 'source=nope&char=c1&chat=a1', { format: 'json' })).statusCode).toBe(404);
    expect((await post(app, Q, { format: 'pdf' })).statusCode).toBe(400); // 사이드카 미설정
    expect((await post(app, Q, { format: 'docx' })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'json', options: { cover: true } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'json', version: 999_999 })).statusCode).toBe(404);
    const other = h.store.listVersions('main', 'c2', 'b1')[0]!.versionId; // 다른 채팅의 버전
    expect((await post(app, Q, { format: 'json', version: other })).statusCode).toBe(404);
    expect((await app.inject('/api/export/zz')).statusCode).toBe(400);
    expect((await app.inject(`/api/export/${'0'.repeat(32)}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/export/${'0'.repeat(32)}/download`)).statusCode).toBe(404);
  });

  it('does not serve a download before the job is done', async () => {
    const { app, exportManager } = await setup();
    const job = exportManager.start('json', () => new Promise(() => {})); // 끝나지 않는 작업 (idle() 을 기다리지 않는다)
    expect(job).not.toBeNull();
    expect((await app.inject(`/api/export/${job!.jobId}/download`)).statusCode).toBe(404);
  });

  it('answers 429 when the queue is full', async () => {
    const { app } = await setup({ maxPending: 0 });
    expect((await post(app, Q, { format: 'json' })).statusCode).toBe(429);
  });
});

describe('export API (EPUB)', () => {
  it('makes an EPUB with defaults and with options', async () => {
    const { app, exportManager } = await setup();
    const a = await post(app, Q, { format: 'epub' });
    expect(a.statusCode).toBe(202);
    const b = await post(app, Q, { format: 'epub', options: { includeUser: false, cover: false, cardImages: true, chatImages: false, hideRuleIds: [], imageRuleKeys: [] } });
    expect(b.statusCode).toBe(202);
    await exportManager.idle();
    for (const r of [a, b]) {
      const { jobId } = JSON.parse(r.body);
      expect(JSON.parse((await app.inject(`/api/export/${jobId}`)).body)).toMatchObject({ state: 'done', format: 'epub', warnings: { slowRules: [] } });
      const dl = await app.inject(`/api/export/${jobId}/download`);
      expect(dl.headers['content-type']).toBe('application/epub+zip');
      expect(dl.headers['content-disposition']).toMatch(/\.epub"$/);
      expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    }
  });

  it('validates EPUB options', async () => {
    const { app } = await setup();
    expect((await post(app, Q, { format: 'epub', options: { cover: 'yes' } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'epub', options: { hideRuleIds: ['not-a-uuid'] } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'epub', options: { imageRuleKeys: ['zz'] } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'epub', options: { extra: 1 } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'epub', options: { imageMode: 'x' } })).statusCode).toBe(400);
    for (const imageMode of ['small', 'compat', 'original']) expect((await post(app, Q, { format: 'epub', options: { imageMode } })).statusCode).toBe(202);
    expect((await post(app, Q, { format: 'json', options: {} })).statusCode).toBe(400);
  });
});

describe('export API (formats, PDF)', () => {
  const formats = async (app: Awaited<ReturnType<typeof setup>>['app']) => JSON.parse((await app.inject('/api/export/formats')).body);

  it('lists formats: pdf only when a sidecar is configured', async () => {
    expect(await formats((await setup()).app)).toEqual({ formats: ['json', 'epub'] });
    expect(await formats((await setup({ pdfUrl: null })).app)).toEqual({ formats: ['json', 'epub'] });
    expect(await formats((await setup({ pdfUrl: 'http://page-pdf:8790' })).app)).toEqual({ formats: ['json', 'epub', 'pdf'] });
  });

  it('answers pdf-unavailable before any lookup when no sidecar is configured', async () => {
    const { app } = await setup();
    for (const q of [Q, 'source=nope&char=c1&chat=a1', 'source=main&char=c1&chat=nope']) {
      const r = await post(app, q, { format: 'pdf' });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: 'pdf-unavailable' });
    }
  });

  it('rejects imageMode small for pdf before any lookup, and unknown options', async () => {
    const { app } = await setup({ pdfUrl: 'http://127.0.0.1:1' });
    for (const q of [Q, 'source=nope&char=c1&chat=a1']) {
      const r = await post(app, q, { format: 'pdf', options: { imageMode: 'small' } });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: 'bad-image-mode' });
    }
    expect((await post(app, Q, { format: 'pdf', options: { extra: 1 } })).statusCode).toBe(400);
    expect((await post(app, Q, { format: 'pdf', options: { cover: 'yes' } })).statusCode).toBe(400);
    expect((await post(app, 'source=nope&char=c1&chat=a1', { format: 'pdf', options: { imageMode: 'compat' } })).statusCode).toBe(404);
    expect((await post(app, Q, { format: 'pdf', version: 999_999 })).statusCode).toBe(404);
  });

  it('makes a PDF through the sidecar: done, application/pdf, .pdf name', async () => {
    const side = await fakeSidecar(pdfOk);
    const { app, exportManager } = await setup({ pdfUrl: side.url });
    const r = await post(app, Q, { format: 'pdf' });
    expect(r.statusCode).toBe(202);
    const { jobId } = JSON.parse(r.body);
    await exportManager.idle();
    expect(side.hits()).toBe(1);
    expect(JSON.parse((await app.inject(`/api/export/${jobId}`)).body)).toMatchObject({ state: 'done', format: 'pdf', warnings: { slowRules: [] } });
    const dl = await app.inject(`/api/export/${jobId}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="page-\d{8}-[0-9a-f]{8}\.pdf"$/);
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(dl.headers['content-length']).toBe(String(dl.rawPayload.length));
  });

  it('accepts compat/original and the shared EPUB options for pdf', async () => {
    const side = await fakeSidecar(pdfOk);
    const { app, exportManager } = await setup({ pdfUrl: side.url });
    for (const options of [{ imageMode: 'compat' }, { imageMode: 'original' }, { includeUser: false, cover: false, hideRuleIds: [], imageRuleKeys: [] }]) {
      expect((await post(app, Q, { format: 'pdf', options })).statusCode).toBe(202);
    }
    await exportManager.idle();
    expect(side.hits()).toBe(3);
  });

  it('defaults pdf images to compat (JPEG), not small; original keeps the source format', async () => {
    const h = makeHarness({
      spec: {
        characters: [{ chaId: 'c1', name: 'Alice', chats: [{ id: 'e1', name: '책', message: [msg('char', `[c1] 웃었다\n{{raw::${AM(1)}}}`)] }] }],
        manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png']] }],
        assets: { 'assets/p1.png': PNG_1X1 },
      },
    });
    await h.sync();
    const exportManager = new ExportManager({ dir: path.join(h.dataDir, 'exports'), now: h.clock.now });
    const side = await fakeSidecar(pdfOk);
    const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state: new StateStore(h.dataDir), exportManager, pdfUrl: side.url });
    opened.push(app);
    const q = 'source=main&char=c1&chat=e1';
    await post(app, q, { format: 'pdf' });
    await post(app, q, { format: 'pdf', options: { imageMode: 'compat' } });
    await post(app, q, { format: 'pdf', options: { imageMode: 'original' } });
    await exportManager.idle();
    const imgs = side.bodies.map((b) => Object.keys(unzipSync(new Uint8Array(b))).filter((n) => n.startsWith('images/')));
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.length).toBeGreaterThan(0);
    expect(imgs[0]).toEqual(imgs[1]);
    expect(imgs[0]!.every((n) => /\.jpe?g$/.test(n))).toBe(true);
    expect(imgs[2]!.some((n) => n.endsWith('.png'))).toBe(true);
  });

  it('maps sidecar failures to the job error code: 500 -> pdf-failed, 503 -> pdf-busy, junk -> pdf-failed, hang -> pdf-failed', async () => {
    const cases: [string, Fake][] = [];
    cases.push(['pdf-failed', await fakeSidecar((res) => { res.writeHead(500); res.end('secret body'); })]);
    cases.push(['pdf-busy', await fakeSidecar((res) => { res.writeHead(503); res.end(); })]);
    cases.push(['pdf-failed', await fakeSidecar((res) => { res.writeHead(200); res.end('not a pdf'); })]);
    for (const [code, side] of cases) {
      const { app, exportManager } = await setup({ pdfUrl: side.url });
      const { jobId } = JSON.parse((await post(app, Q, { format: 'pdf' })).body);
      await exportManager.idle();
      const st = JSON.parse((await app.inject(`/api/export/${jobId}`)).body);
      expect(st).toMatchObject({ state: 'failed', format: 'pdf', error: code });
      expect(JSON.stringify(st)).not.toContain('secret');
      expect((await app.inject(`/api/export/${jobId}/download`)).statusCode).toBe(404);
    }
    const hang = await fakeSidecar(() => { /* 응답 없음 */ });
    const { app, exportManager } = await setup({ pdfUrl: hang.url, pdfTimeoutMs: 100 });
    const { jobId } = JSON.parse((await post(app, Q, { format: 'pdf' })).body);
    await exportManager.idle();
    expect(JSON.parse((await app.inject(`/api/export/${jobId}`)).body)).toMatchObject({ state: 'failed', error: 'pdf-failed' });
  });

  it('leaves JSON and EPUB untouched when a sidecar is configured', async () => {
    const side = await fakeSidecar(pdfOk);
    const { app, exportManager } = await setup({ pdfUrl: side.url });
    const j = JSON.parse((await post(app, Q, { format: 'json' })).body).jobId;
    const e = JSON.parse((await post(app, Q, { format: 'epub' })).body).jobId;
    await exportManager.idle();
    expect((await app.inject(`/api/export/${j}/download`)).headers['content-type']).toMatch(/^application\/json/);
    expect((await app.inject(`/api/export/${e}/download`)).headers['content-type']).toBe('application/epub+zip');
    expect((await post(app, Q, { format: 'epub', options: { imageMode: 'small' } })).statusCode).toBe(202);
    expect((await post(app, Q, { format: 'json', options: {} })).statusCode).toBe(400);
    expect(side.hits()).toBe(0);
  });
});
