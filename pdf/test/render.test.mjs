import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server.mjs';
import { CHROMIUM_ARGS } from '../src/render.mjs';

// CHROMIUM_PATH 가 있을 때만 돈다 (로컬에서는 Playwright 가 받아 둔 chromium).
const skip = !process.env.CHROMIUM_PATH;
const FONTS = fileURLToPath(new URL('../fonts', import.meta.url));
// 1x1 투명 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

const HEAD = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>합성</title>
<style>
@font-face { font-family: MaruBuri; src: url(fonts/MaruBuri-Regular.woff2) format('woff2'); font-weight: 400; }
@font-face { font-family: MaruBuri; src: url(fonts/MaruBuri-SemiBold.woff2) format('woff2'); font-weight: 600; }
body { font-family: MaruBuri, serif; word-break: keep-all; }
h1 { break-before: page; }
img { max-width: 100%; }
</style>`;

function bundle(extra = '', { chapters = 2, head = '' } = {}) {
  const body = Array.from({ length: chapters }, (_, i) => `<h1>${i + 1}장</h1><p>가나다 "대사"</p>`).join('');
  const html = `${HEAD}${head}</head><body>${body}<img src="images/a.png" alt="">${extra}</body></html>`;
  return zipSync({ 'index.html': strToU8(html), 'images/a.png': PNG });
}

// 오래 걸리는 묶음: 한글 문단을 아주 많이.
function heavyBundle(paragraphs = 3000) {
  const p = '<p>그녀가 웃었다. "안녕, 오늘은 어때?" 창밖으로 비가 내리고 있었다. 나는 아무 말도 하지 않았다.</p>';
  return zipSync({ 'index.html': strToU8(`${HEAD}</head><body>${p.repeat(paragraphs)}</body></html>`) });
}

const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: CHROMIUM_ARGS });
  server = createServer(browser, { fontsDir: FONTS });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  if (browser) await browser.close();
});

async function post(body, url = base) {
  return fetch(`${url}/render`, { method: 'POST', body });
}
async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

test('renders a multi-chapter Korean bundle to PDF with MaruBuri', { skip }, async () => {
  const res = await post(bundle());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.toString('latin1').includes('MaruBuri'), 'PDF should embed MaruBuri');
  assert.ok(pageCount(pdf) >= 2, `expected >= 2 pages, got ${pageCount(pdf)}`);
});

test('fallback glyphs (emoji, hanja, kana) render', { skip }, async () => {
  const res = await post(bundle('<p>이모지 😀🎉 한자 漢字 學校 가나 ひらがな カタカナ</p>'));
  assert.equal(res.status, 200);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  // 컨테이너(Noto 폰트 설치)에서만 확인한다: EXPECT_NOTO=1
  if (process.env.EXPECT_NOTO) assert.ok(/Noto/.test(pdf.toString('latin1')), 'PDF should embed a Noto fallback font');
});

test('defense-in-depth egress flags are present (proxy to nowhere, no loopback bypass, host resolver)', () => {
  // page.route 의 abort 만으로도 막히는 빌드가 있지만, 미리 연결 같은 누수에 대비한 이중 방어다. 실제 효과는 아래 TCP 테스트가 본다.
  assert.ok(CHROMIUM_ARGS.includes('--proxy-server=http://127.0.0.1:1'));
  assert.ok(CHROMIUM_ARGS.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(CHROMIUM_ARGS.includes('--host-resolver-rules=MAP * ~NOTFOUND'));
});

test('no TCP connection leaves the render (http, https, preconnect, iframe, img, link)', { skip }, async () => {
  // HTTP 요청이 아니라 TCP 연결 자체를 센다 — 미리 연결(preconnect)도 걸러내야 한다.
  let connections = 0;
  const trap = net.createServer((sock) => { connections++; sock.destroy(); });
  const port = await listen(trap);
  try {
    const u = `http://127.0.0.1:${port}/x`;
    const s = `https://127.0.0.1:${port}/x`;
    const res = await post(bundle(
      `<iframe src="${u}"></iframe><iframe src="${s}"></iframe><img src="${u}.png" alt=""><img src="https://example.com/x.png" alt="">` +
      `<link rel="stylesheet" href="${u}.css"><link rel="preconnect" href="http://127.0.0.1:${port}"><link rel="dns-prefetch" href="//example.com">`,
    ));
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    await sleep(300); // 늦게 오는 미리 연결을 기다린다
    assert.equal(connections, 0, 'trap server must see no TCP connection');
  } finally { await new Promise((r) => trap.close(r)); }
});

test('small zip that declares more than the unpacked cap -> 400 bad-bundle', { skip }, async () => {
  const strict = createServer(browser, { maxUnpackedBytes: 1024 * 1024, fontsDir: FONTS });
  const port = await listen(strict);
  try {
    // 0 으로 채운 3MB 는 zip 에서 수 KB 로 줄어든다.
    const zip = zipSync({ 'index.html': strToU8('<p>x</p>'), 'images/z.png': new Uint8Array(3 * 1024 * 1024) });
    assert.ok(zip.length < 100 * 1024, `zip should be small, got ${zip.length}`);
    const res = await post(zip, `http://127.0.0.1:${port}`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'bad-bundle' });
  } finally { await new Promise((r) => { strict.close(r); strict.closeAllConnections?.(); }); }
});

test('a file:// stylesheet outside the bundle dir is not loaded', { skip }, async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'evil.css'), 'body { display: none !important; }');
    const href = pathToFileURL(path.join(outside, 'evil.css')).href;
    const res = await post(bundle('', { head: `<link rel="stylesheet" href="${href}">` }));
    assert.equal(res.status, 200);
    const pdf = Buffer.from(await res.arrayBuffer());
    // evil.css 가 적용됐다면 본문이 숨겨져 MaruBuri 글리프가 임베드되지 않는다.
    assert.ok(pdf.toString('latin1').includes('MaruBuri'), 'outside stylesheet must not apply');
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

test('a bundle containing a script still renders (JS is off)', { skip }, async () => {
  // 스크립트는 실행되지 않는다(javaScriptEnabled: false).
  const res = await post(bundle('<script>document.body.innerHTML=""</script>'));
  assert.equal(res.status, 200);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  // 스크립트가 돌았다면 body 가 비어 MaruBuri 글리프가 임베드되지 않는다.
  assert.ok(pdf.toString('latin1').includes('MaruBuri'), 'script must not have run');
});

test('bad bundle -> 400 bad-bundle', { skip }, async () => {
  for (const files of [{ 'script.js': strToU8('x') }, { 'index.html': strToU8('x'), 'images/..': strToU8('y') }, { 'index.html': strToU8('x'), 'images/.': strToU8('y') }]) {
    const res = await post(zipSync(files));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'bad-bundle' });
  }
});

test('declared content-length over the cap -> 413', { skip }, async () => {
  const small = createServer(browser, { maxBytes: 10, fontsDir: FONTS });
  const port = await listen(small);
  try {
    const res = await post(new Uint8Array(1000), `http://127.0.0.1:${port}`);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too-large' });
  } finally { await new Promise((r) => { small.close(r); small.closeAllConnections?.(); }); }
});

test('timeout -> 504, the context is closed, and the next render works', { skip }, async () => {
  const quick = createServer(browser, { timeoutMs: 150, fontsDir: FONTS });
  const port = await listen(quick);
  try {
    const res = await post(heavyBundle(), `http://127.0.0.1:${port}`);
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: 'timeout' });
    // 504 가 도착한 시점에 이미 컨텍스트가 닫혀 있어야 한다 (기다리지 않고 바로 확인한다).
    assert.equal(browser.contexts().length, 0, 'timed-out context must be closed before the response');
  } finally { await new Promise((r) => { quick.close(r); quick.closeAllConnections?.(); }); }
  const ok = await post(bundle());
  assert.equal(ok.status, 200);
});

test('at most one render running and one waiting; the third gets 503 busy', { skip }, async () => {
  const first = post(heavyBundle(2500));
  await sleep(100);
  const second = post(heavyBundle(2500));
  await sleep(100);
  const third = await post(bundle());
  assert.equal(third.status, 503);
  assert.deepEqual(await third.json(), { error: 'busy' });
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  // 자리가 비면 다시 받는다.
  assert.equal((await post(bundle())).status, 200);
});

test('GET /health', { skip }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('/health is 503 after the real browser is closed', { skip }, async () => {
  const dead = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: CHROMIUM_ARGS });
  await dead.close();
  const srv = createServer(dead, { fontsDir: FONTS });
  const port = await listen(srv);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
  } finally { await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});
