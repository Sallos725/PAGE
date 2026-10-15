// portable/smoke.mjs — 조립한 포터블 폴더로 실제 실행 확인 (스펙 §8). 사용: node portable/smoke.mjs <포터블 폴더>
// 합성 데이터만 쓴다. 끝나면 data\ 와 page.env 를 지워 zip 에 남지 않게 한다.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '');
const nodeBin = path.join(dir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
if (!fs.existsSync(nodeBin) || !fs.existsSync(path.join(dir, 'app', 'launch.mjs'))) { console.error('not a portable folder'); process.exit(2); }
for (const n of ['data', 'page.env']) if (fs.existsSync(path.join(dir, n))) { console.error(`${n} already exists — refusing (use a fresh assembly)`); process.exit(2); }
const PORT = 18787;
const base = `http://127.0.0.1:${PORT}`;
// 이미 누가 쓰는 포트면 다른 PAGE 에 붙어 가짜 통과가 날 수 있다 — 연결이 거절될 때만 진행
const portFree = await new Promise((resolve) => {
  const sock = net.createConnection({ host: '127.0.0.1', port: PORT });
  const done = (free) => { clearTimeout(timer); sock.destroy(); resolve(free); };
  const timer = setTimeout(() => done(false), 3000);
  sock.once('connect', () => done(false));
  sock.once('error', (e) => done(e.code === 'ECONNREFUSED'));
});
if (!portFree) { console.error('port busy'); console.log('PORTABLE SMOKE FAILED'); process.exit(1); }
fs.writeFileSync(path.join(dir, 'page.env'), `PAGE_PORT=${PORT}\n`);

const child = spawn(nodeBin, [path.join(dir, 'app', 'launch.mjs')], { cwd: dir, env: { ...process.env, PAGE_NO_BROWSER: '1' }, stdio: 'inherit', detached: process.platform !== 'win32' });
const exited = new Promise((r) => { child.once('exit', r); child.once('error', r); });
const stop = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else { try { process.kill(-child.pid, 'SIGINT'); } catch { /* 이미 끝남 */ } }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// fetch(undici) 는 host 헤더를 바꾸지 못하므로 node:http 로 보낸다
const statusWithHost = (host) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});

let ok = false;
try {
  let health = null;
  for (let i = 0; i < 120 && !health; i++) { try { health = await json(await fetch(`${base}/api/health`)); } catch { await sleep(500); } }
  if (health?.app !== 'page' || health.portable !== true) throw new Error('health');
  const formats = await json(await fetch(`${base}/api/export/formats`));
  if (formats.formats.includes('pdf')) throw new Error('pdf should be off');
  const src = await json(await fetch(`${base}/api/portable/source`));
  if (src.connected !== null) throw new Error('source should be empty');
  if ((await statusWithHost('evil.example')) !== 421) throw new Error('host check');
  if ((await statusWithHost(`localhost:${PORT}`)) !== 200) throw new Error('host allow');
  const { charId } = await json(await post('/api/import/chars', { name: '스모크 합성' }));
  const chat = { type: 'risuChat', ver: 2, data: { id: 'smoke-1', name: '합성 채팅', lastDate: 1, message: [{ role: 'user', data: '합성 안녕' }, { role: 'char', data: '합성 반가워' }] } };
  const up = await json(await post(`/api/import/chars/${charId}/chats`, chat));
  if (up.results?.[0]?.status !== 'new') throw new Error('import');
  const q = new URLSearchParams({ source: 'imported', char: charId, chat: up.results[0].chatId });
  const { jobId } = await json(await post(`/api/export?${q}`, { format: 'epub' }));
  let st = null;
  for (let i = 0; i < 120; i++) { st = await json(await fetch(`${base}/api/export/${jobId}`)); if (st.state === 'done' || st.state === 'failed') break; await sleep(500); }
  if (st?.state !== 'done') throw new Error('export');
  const dl = await fetch(`${base}/api/export/${jobId}/download`);
  if (!dl.ok || (await dl.arrayBuffer()).byteLength < 1000) throw new Error('download');
  ok = true;
} catch (e) {
  console.error(`SMOKE FAIL: ${e instanceof Error ? e.message : 'error'}`);
} finally {
  stop();
  // 감독 프로세스는 서버가 닫힐 때까지 기다렸다 끝난다 — 그 뒤에 data 를 지운다
  if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, sleep(15_000)]);
  if (process.platform === 'win32') await sleep(1500); // taskkill /F 뒤 파일 핸들이 늦게 풀린다
  // 정리 실패가 결과를 바꾸지 않게 경고만 한다
  for (const n of ['data', 'page.env']) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { console.warn(`SMOKE WARN: could not remove ${n}`); }
  }
}
console.log(ok ? 'PORTABLE SMOKE OK' : 'PORTABLE SMOKE FAILED');
process.exit(ok ? 0 : 1);
