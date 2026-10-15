import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { BundleError, unpackBundle } from './bundle.mjs';
import { CHROMIUM_ARGS, renderPdf } from './render.mjs';

const PORT = Number(process.env.PORT ?? 8790);
const MAX = Number(process.env.PDF_MAX_BODY_MB ?? 400) * 1024 * 1024;
const TIMEOUT = Number(process.env.PDF_TIMEOUT_S ?? 300) * 1000;
const FONTS = process.env.PDF_FONTS_DIR ?? fileURLToPath(new URL('../fonts', import.meta.url));
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
// 동시에 받는 요청: 렌더 1 + 대기 1. 셋째부터는 본문을 읽기 전에 503 busy.
const MAX_PENDING = 2;

export function createServer(browser, opts = {}) {
  const max = opts.maxBytes ?? MAX;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT;
  const fontsDir = opts.fontsDir ?? FONTS;
  const unpackOpts = opts.maxUnpackedBytes ? { maxUnpacked: opts.maxUnpackedBytes } : {};
  let chain = Promise.resolve();
  let pending = 0;
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, connection: 'close' });
    res.end(body);
  };
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return browser.isConnected() ? send(res, 200, '{"ok":true}') : send(res, 503, '{"error":"browser-down"}');
    }
    if (req.method !== 'POST' || req.url !== '/render') return send(res, 404, '{"error":"not-found"}');
    // 본문을 읽기 전에 거절한다: 대기열이 찼거나, 선언된 크기가 상한을 넘으면.
    if (pending >= MAX_PENDING) return send(res, 503, '{"error":"busy"}');
    if (Number(req.headers['content-length'] ?? 0) > max) return send(res, 413, '{"error":"too-large"}');
    pending++; // 업로드 중에도 자리를 차지한다
    try {
      let body = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > max) return send(res, 413, '{"error":"too-large"}');
        body.push(c);
      }
      let buf = Buffer.concat(body);
      body = null; // 조각 배열을 놓아 준다 (이어 붙인 복사본만 남긴다)
      // 풀 때 한 번만 꺼내 가고 바로 놓는다 — 렌더하는 동안 요청 본문(최대 수백 MB)을 붙들고 있지 않는다.
      const take = () => { const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.length); buf = null; return b; };
      const job = chain.then(async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-'));
        try {
          await unpackBundle(take(), dir, unpackOpts);
          const pdf = await renderPdf(browser, dir, fontsDir, { timeoutMs });
          send(res, 200, Buffer.from(pdf), 'application/pdf');
        } catch (e) {
          // 로그에는 고정 코드와 오류 이름만 — 메시지·내용은 남기지 않는다.
          const name = e?.name ?? 'Error';
          if (e instanceof BundleError) {
            console.error(JSON.stringify({ code: 'bad-bundle', name }));
            send(res, 400, JSON.stringify({ error: e.code }));
          } else if (e?.message === 'timeout') {
            console.error(JSON.stringify({ code: 'timeout', name }));
            send(res, 504, '{"error":"timeout"}');
          } else {
            console.error(JSON.stringify({ code: 'render-failed', name }));
            send(res, 500, '{"error":"render-failed"}');
          }
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      });
      chain = job.catch(() => undefined);
      await job;
    } catch {
      // 업로드 도중 끊김 등 — 응답할 상대가 없다.
      if (!res.headersSent) send(res, 400, '{"error":"bad-request"}');
    } finally {
      pending--;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: CHROMIUM_ARGS });
  let shuttingDown = false;
  // 브라우저가 죽으면 서비스도 죽는다 — compose 의 restart 가 되살린다. /health 도 503 을 낸다.
  browser.on('disconnected', () => { if (!shuttingDown) process.exit(1); });
  // 0.0.0.0 은 컨테이너 네트워크 안 전용이다. compose 에서 ports: 를 두지 않는다 (호스트에 게시하지 않는다).
  createServer(browser).listen(PORT, '0.0.0.0');
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shuttingDown = true; void browser.close().then(() => process.exit(0)); });
}
