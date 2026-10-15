import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

// 브라우저 없이 확인하는 서버 동작.
async function withServer(browser, fn) {
  const srv = createServer(browser);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally {
    await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
  }
}

test('/health is 200 while the browser is connected', async () => {
  await withServer({ isConnected: () => true }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('/health is 503 when the browser is gone', async () => {
  await withServer({ isConnected: () => false }, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'browser-down' });
  });
});

test('declared content-length over the cap -> 413 before reading the body', async () => {
  const srv = createServer({ isConnected: () => true }, { maxBytes: 10 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/render`, { method: 'POST', body: new Uint8Array(100) });
    assert.equal(res.status, 413);
  } finally { await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('unknown route -> 404', async () => {
  await withServer({ isConnected: () => true }, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('streamed body (chunked, no content-length) over the cap -> 413', async () => {
  const srv = createServer({ isConnected: () => true }, { maxBytes: 150 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/render', method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => undefined); // 서버가 먼저 끊어도 응답은 받는다
      setTimeout(() => reject(new Error('no response')), 5000).unref();
      let i = 0;
      const t = setInterval(() => { if (++i > 5 || req.destroyed) { clearInterval(t); req.end(); } else req.write(Buffer.alloc(100)); }, 20);
    });
    assert.equal(status, 413);
  } finally { await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
});

test('bad bundle -> 400 and logs only a fixed code and error name', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    await withServer({ isConnected: () => true }, async (base) => {
      const res = await fetch(`${base}/render`, { method: 'POST', body: new Uint8Array([1, 2, 3, 4, 5]) });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'bad-bundle' });
    });
  } finally { console.error = orig; }
  assert.equal(logged.length, 1);
  const line = JSON.parse(logged[0]);
  assert.deepEqual(Object.keys(line).sort(), ['code', 'name']);
  assert.equal(line.code, 'bad-bundle');
});
