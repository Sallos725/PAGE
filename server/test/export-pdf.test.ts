import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportError } from '../src/export/jobs.js';
import type { PreparedBook } from '../src/export/epub/prepare.js';
import { buildPdfBundle } from '../src/export/pdf/html.js';
import { producePdf } from '../src/export/pdf/produce.js';
import { DEFAULT_EPUB_OPTIONS, type EpubOptions } from '../src/export/epub/produce.js';
import { chatVersion } from '../src/export/source.js';
import { StateStore } from '../src/state/store.js';
import { AM, PNG_1X1, chat, msg } from '../src/tools/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

// 사이드카(pdf/src/bundle.mjs)가 받는 항목 이름.
const SIDECAR_OK = /^(index\.html|images\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,128})$/;
const ALL: EpubOptions = { ...DEFAULT_EPUB_OPTIONS, imageMode: 'original' };
const TITLE = '<b>책 & "제목"</b>';

async function setup() {
  const h = makeHarness({
    spec: {
      characters: [{
        chaId: 'c1', name: 'Alice', image: 'assets/alice.png',
        chats: [{ id: 'e1', name: '합성 책', message: [
          msg('user', '[u0] 안녕 <script>alert(1)</script>'),
          msg('char', `[c1] 웃었다\n{{raw::${AM(1)}}}`),
        ] }, chat('e2', ['x'])],
      }],
      manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png']] }],
      assets: { 'assets/p1.png': PNG_1X1, 'assets/alice.png': PNG_1X1 },
    },
  });
  await h.sync();
  const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
  const ctx = { store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: TITLE, author: 'Alice & <Bob>', now: h.clock.now };
  return { ctx };
}

type Fake = { url: string; bodies: Buffer[]; headers: http.IncomingHttpHeaders[]; close: () => Promise<void> };
const open: Fake[] = [];
const tmpDirs: string[] = [];
async function fakeSidecar(handler: (res: http.ServerResponse) => void): Promise<Fake> {
  const bodies: Buffer[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/render') { bodies.push(Buffer.concat(parts)); headers.push(req.headers); }
      handler(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, headers,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  open.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const pdfOk = (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.7\nsynthetic')); };
const tmpOut = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-pdf-'));
  tmpDirs.push(d);
  return path.join(d, 'out.pdf');
};
const unzip = (b: Buffer | Uint8Array) => unzipSync(new Uint8Array(b));

describe('buildPdfBundle', () => {
  const book = (): PreparedBook => ({
    chapters: [
      { title: '1장', messages: [{ role: 'char', blocks: [{ kind: 'paragraph', text: '<i>안녕</i> & "끝"' }, { kind: 'image', assetName: 'a' }] }] },
      { title: '2장 (이어서)', messages: [{ role: 'user', blocks: [{ kind: 'dialogue', text: '네' }, { kind: 'divider' }] }] },
    ],
    hrefOf: (n) => (n === 'a' ? 'images/aaaaaaaaaaaaaaaa.png' : null),
    images: [{ id: 'img-a', href: 'images/aaaaaaaaaaaaaaaa.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    cover: { id: 'cover-image', href: 'images/cover.jpg', mime: 'image/jpeg', bytes: new Uint8Array([4, 5]) },
    warnings: { missingImages: 0, skippedImages: 0, slowRules: [] },
  });

  it('writes index.html and images/* only, with names the sidecar accepts', async () => {
    const files = unzip(await buildPdfBundle(book(), { title: 'T', author: 'A' }));
    expect(Object.keys(files).sort()).toEqual(['images/aaaaaaaaaaaaaaaa.png', 'images/cover.jpg', 'index.html']);
    for (const n of Object.keys(files)) expect(n).toMatch(SIDECAR_OK);
    expect([...files['images/cover.jpg']!]).toEqual([4, 5]);
  });

  it('builds valid-looking HTML5: lang, charset, font-face, cover, chapter h1, no script or external URLs', async () => {
    const html = strFromU8(unzip(await buildPdfBundle(book(), { title: 'T', author: 'A' }))['index.html']!);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>T</title>');
    expect(html).toMatch(/@font-face\s*\{[^}]*font-family:\s*"MaruBuri"[^}]*url\("fonts\/MaruBuri-Regular\.woff2"\)[^}]*font-weight:\s*400/);
    expect(html).toMatch(/@font-face\s*\{[^}]*url\("fonts\/MaruBuri-SemiBold\.woff2"\)[^}]*font-weight:\s*600/);
    expect(html).toContain('word-break: keep-all');
    expect(html).toContain('break-before: page');
    expect(html).toMatch(/<section class="cover"><img src="images\/cover\.jpg" alt=""><h1>T<\/h1><p class="author">A<\/p><\/section>/);
    expect(html.match(/<section class="chapter">/g)).toHaveLength(2);
    expect(html).toContain('<h1>1장</h1>');
    expect(html).toContain('<h1>2장 (이어서)</h1>');
    expect(html).toContain('<div class="msg user"><p class="dialogue">네</p><hr/></div>');
    expect(html).toContain('<img src="images/aaaaaaaaaaaaaaaa.png" alt=""/>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(https?:)?\/\//); // 외부 URL 없음
    expect(html).not.toMatch(/\son[a-z]+=|style=/i);
  });

  it('every src in the HTML is a zip entry', async () => {
    const files = unzip(await buildPdfBundle(book(), { title: 'T', author: 'A' }));
    const html = strFromU8(files['index.html']!);
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBe(2);
    for (const s of srcs) expect(files[s]).toBeDefined();
  });

  it('escapes title, author and message text; omits cover when there is none', async () => {
    const b = book();
    b.cover = null;
    const html = strFromU8(unzip(await buildPdfBundle(b, { title: TITLE, author: 'A & <B>' }))['index.html']!);
    expect(html).toContain('&lt;b&gt;책 &amp; &quot;제목&quot;&lt;/b&gt;');
    expect(html).not.toContain('<b>책');
    expect(html).toContain('A &amp; &lt;B&gt;');
    expect(html).toContain('&lt;i&gt;안녕&lt;/i&gt; &amp; &quot;끝&quot;');
    expect(html).not.toContain('class="cover"><img');
    expect(html).toContain('<section class="cover"><h1>');
  });

  it('refuses an image path the sidecar would reject, with a pdf-failed ExportError', async () => {
    const b = book();
    b.images[0]!.href = '../evil.png';
    const e = await buildPdfBundle(b, { title: 'T', author: 'A' }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ExportError);
    expect((e as ExportError).code).toBe('pdf-failed');
  });

  it('keeps the cover image at max-height 135mm', async () => {
    // A5 한 쪽에 세로로 긴 표지 그림 + 제목(h1) + 캐릭터 이름이 함께 들어가는 높이다 (렌더로 확인:
    // 140mm 는 넘쳐 표지가 두 쪽이 된다). 올릴 때는 실제 Chromium 으로 다시 확인할 것.
    const html = strFromU8(unzip(await buildPdfBundle(book(), { title: 'T', author: 'A' }))['index.html']!);
    expect(html).toContain('section.cover img { max-width: 100%; max-height: 135mm;');
  });
});

describe('producePdf', () => {
  it('posts a zip bundle to /render and stores the returned PDF', async () => {
    const { ctx } = await setup();
    const side = await fakeSidecar(pdfOk);
    const out = tmpOut();
    const r = await producePdf({ ...ctx, pdfUrl: side.url + '/' }, ALL, out);
    expect(fs.readFileSync(out).subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.warnings).toEqual({ missingImages: 0, skippedImages: 0, slowRules: [] });

    expect(side.bodies).toHaveLength(1);
    expect(side.headers[0]!['content-type']).toBe('application/zip');
    const files = unzip(side.bodies[0]!);
    const names = Object.keys(files);
    for (const n of names) expect(n).toMatch(SIDECAR_OK);
    expect(names).toContain('index.html');
    expect(names).toContain('images/cover.png');
    expect(names.filter((n) => /^images\/[0-9a-f]{16}\.png$/.test(n))).toHaveLength(1);
    const html = strFromU8(files['index.html']!);
    expect(html).toContain('fonts/MaruBuri-Regular.woff2');
    expect(html).toContain('fonts/MaruBuri-SemiBold.woff2');
    expect(html.match(/<section class="chapter">/g)).toHaveLength(1);
    expect(html).toContain('<h1>1장</h1>');
    expect(html).toContain('&lt;b&gt;책 &amp; &quot;제목&quot;&lt;/b&gt;');
    expect(html).toContain('[u0] 안녕');
    expect(html).not.toMatch(/<script|alert\(/i);
    // 그림 href 는 zip 항목과 정확히 일치한다
    for (const m of html.matchAll(/src="([^"]+)"/g)) expect(files[m[1]!]).toBeDefined();
  });

  it('honors the options (no cover, no user messages)', async () => {
    const { ctx } = await setup();
    const side = await fakeSidecar(pdfOk);
    await producePdf({ ...ctx, pdfUrl: side.url }, { ...ALL, cover: false, includeUser: false }, tmpOut());
    const files = unzip(side.bodies[0]!);
    expect(files['images/cover.png']).toBeUndefined();
    const html = strFromU8(files['index.html']!);
    expect(html).not.toContain('class="msg user"');
    expect(html).not.toContain('<section class="cover"><img');
  });

  const fail = async (handler: (res: http.ServerResponse) => void, extra: { pdfTimeoutMs?: number } = {}) => {
    const { ctx } = await setup();
    const side = await fakeSidecar(handler);
    const out = tmpOut();
    const e = await producePdf({ ...ctx, pdfUrl: side.url, ...extra }, ALL, out).then(() => null, (x: unknown) => x);
    return { e, out };
  };

  it('maps sidecar 500 / 400 / 413 / 504 to pdf-failed and leaves no file', async () => {
    for (const code of [500, 400, 413, 504]) {
      const { e, out } = await fail((res) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end('{"error":"SECRET-BODY"}'); });
      expect(e).toBeInstanceOf(ExportError);
      expect((e as ExportError).code).toBe('pdf-failed');
      expect(String(e)).not.toContain('SECRET');
      expect(fs.existsSync(out)).toBe(false);
    }
  });

  it('maps sidecar 503 busy to pdf-busy', async () => {
    const { e } = await fail((res) => { res.writeHead(503); res.end('{"error":"busy"}'); });
    expect(e).toBeInstanceOf(ExportError);
    expect((e as ExportError).code).toBe('pdf-busy');
  });

  it('still reports pdf-busy when the sidecar answers 503 before reading a large upload', async () => {
    const { ctx } = await setup();
    const side = await fakeSidecar((res) => { res.writeHead(503, { connection: 'close' }); res.end('{"error":"busy"}'); });
    // 묶음이 커도(그림 4MB, 압축 안 됨) 본문을 읽기 전에 온 503 이 pdf-busy 로 남는다.
    const big = { ...ctx, convert: async () => ({ bytes: new Uint8Array(4 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24), ext: 'png', mime: 'image/png' }) };
    const e = await producePdf({ ...big, pdfUrl: side.url }, ALL, tmpOut()).then(() => null, (x: unknown) => x);
    expect((e as ExportError).code).toBe('pdf-busy');
  });

  it('treats a 200 that is not a PDF as pdf-failed', async () => {
    for (const body of ['<html>no</html>', '', '%PD']) {
      const { e, out } = await fail((res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(body); });
      expect((e as ExportError).code).toBe('pdf-failed');
      expect(fs.existsSync(out)).toBe(false);
    }
  });

  it('times out on a slow sidecar as pdf-failed', async () => {
    const { e } = await fail(() => { /* 응답하지 않는다 */ }, { pdfTimeoutMs: 80 });
    expect((e as ExportError).code).toBe('pdf-failed');
  });

  it('maps an unreachable sidecar to pdf-failed', async () => {
    const { ctx } = await setup();
    const side = await fakeSidecar(pdfOk);
    const url = side.url;
    await side.close();
    const e = await producePdf({ ...ctx, pdfUrl: url }, ALL, tmpOut()).then(() => null, (x: unknown) => x);
    expect((e as ExportError).code).toBe('pdf-failed');
  });

  it('uses the injected fetchImpl and never puts the error cause into the message', async () => {
    const { ctx } = await setup();
    const fetchImpl = (async () => { throw new Error('chat-content-here'); }) as unknown as typeof fetch;
    const e = await producePdf({ ...ctx, pdfUrl: 'http://x', fetchImpl }, ALL, tmpOut()).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ExportError);
    expect((e as ExportError).code).toBe('pdf-failed');
    expect((e as ExportError).message).toBe('pdf-failed');
    expect((e as ExportError).cause).toBeUndefined();
  });
});
