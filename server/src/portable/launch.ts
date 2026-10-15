// 포터블 감독 프로세스 (스펙 §3.2). PAGE.exe → bin\node.exe app\launch.mjs → main().
// 서버를 자식으로 띄우고, 종료 코드 75 면 다시 띄운다. 브라우저는 처음 한 번만 연다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RESTART_CODE } from './settings.js';

export const ALLOWED_KEYS = [
  'PAGE_PORT', 'LOG_LEVEL', 'PAGE_SYNC_INTERVAL_MIN', 'PAGE_VERSION_DEBOUNCE_MIN',
  'PAGE_EXPORT_IMAGE_BUDGET_MB', 'PAGE_WARN_FREE_GB', 'PAGE_WARN_FREE_PCT', 'PAGE_STOP_ASSETS_FREE_GB',
] as const;

export function parsePageEnv(text: string): { env: Record<string, string>; ignored: string[] } {
  const env: Record<string, string> = {};
  const ignored: string[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    const rawValue = t.slice(eq + 1).trim();
    const quoted = /^"([^"]*)"\s*(?:#.*)?$/.exec(rawValue);
    // 따옴표 없는 값은 ` #...` 인라인 주석을 벗긴다
    const value = quoted ? quoted[1]! : rawValue.replace(/\s+#.*$/, '');
    if ((ALLOWED_KEYS as readonly string[]).includes(key)) env[key] = value;
    else ignored.push(key);
  }
  return { env, ignored };
}

export function childEnv(base: NodeJS.ProcessEnv, root: string, user: Record<string, string>, join: (...p: string[]) => string = path.join): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...base, ...user };
  delete e.PAGE_PDF_URL;
  delete e.PAGE_SOURCES;
  return {
    ...e,
    PAGE_PORTABLE: '1',
    PAGE_BIND: '127.0.0.1',
    PAGE_DATA_DIR: join(root, 'data'),
    PAGE_WEB_DIR: join(root, 'app', 'web', 'dist'),
    NODE_ENV: 'production',
  };
}

export type Probe = 'free' | 'page' | 'other';
export type LaunchDeps = {
  readPageEnv(): string | null;
  mkdirData(): void;
  probe(port: number): Promise<Probe>;
  spawnServer(env: NodeJS.ProcessEnv): { exited: Promise<number>; kill?(): void };
  /** signal 이 abort 되면 폴링을 멈추고 false */
  waitHealthy(port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
  openBrowser(url: string): void;
  log(msg: string): void;
  now(): number;
};

export async function runLauncher(root: string, deps: LaunchDeps, base: NodeJS.ProcessEnv): Promise<number> {
  deps.mkdirData();
  const pe = parsePageEnv(deps.readPageEnv() ?? '');
  if (pe.ignored.length) deps.log(`page.env 에서 쓰지 않는 설정을 건너뛰었어요: ${pe.ignored.join(', ')}`);
  const env = childEnv(base, root, pe.env);
  if (env.PAGE_PORT !== undefined && !/^\d+$/.test(env.PAGE_PORT.trim())) return badPort(deps);
  const port = env.PAGE_PORT === undefined ? 8787 : Number(env.PAGE_PORT.trim());
  if (port < 1 || port > 65535) return badPort(deps);
  const url = `http://127.0.0.1:${port}/`;
  const noBrowser = base.PAGE_NO_BROWSER === '1';

  const p = await deps.probe(port);
  if (p === 'page') {
    deps.log(`PAGE 가 이미 켜져 있어요 · ${url}`);
    if (!noBrowser) deps.openBrowser(url);
    return 0;
  }
  if (p === 'other') {
    deps.log(`포트 ${port} 을 다른 프로그램이 쓰고 있어요. PAGE 폴더의 page.env 에 PAGE_PORT=다른번호 를 적어 주세요.`);
    return 1;
  }

  deps.log(`PAGE 실행 중 · ${url} · 이 창을 닫으면 꺼져요 · 데이터: ${path.join(root, 'data')}`);
  let opened = false;
  const starts: number[] = [];
  for (;;) {
    const t = deps.now();
    starts.push(t);
    while (starts.length && starts[0]! < t - 60_000) starts.shift();
    if (starts.length > 6) { // 첫 시작 + 다시 켜기 5번까지 허용
      deps.log('PAGE 가 너무 자주 다시 켜져서 멈췄어요. 창을 닫고 다시 실행해 주세요.');
      return 1;
    }
    const child = deps.spawnServer(env);
    const ac = new AbortController();
    let exited = false;
    if (!opened && !noBrowser) {
      void deps.waitHealthy(port, 60_000, ac.signal).then((ok) => {
        // 그 사이 자식이 끝났다면 다른 인스턴스가 응답한 것일 수 있어 열지 않는다
        if (ok && !exited && !opened) { opened = true; deps.openBrowser(url); }
      });
    }
    const code = await child.exited;
    exited = true;
    ac.abort();
    if (code !== RESTART_CODE) return code;
    deps.log('설정을 바꿔서 PAGE 를 다시 켜는 중…');
  }
}

function badPort(deps: LaunchDeps): number {
  deps.log('page.env 의 PAGE_PORT 값이 올바르지 않아요 (1~65535).');
  return 1;
}

// ── 실제 의존성
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 포트 판별: 연결이 거절되면 free, 붙으면 /api/health 로 PAGE 인지 본다. 연결이 오래 결론 안 나면 free (실제 점유면 서버가 EADDRINUSE 로 곧 죽는다). */
export function probePort(port: number, connectMs = 5000, httpMs = 3000): Promise<Probe> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (r: Probe) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(r); };
    const timer = setTimeout(() => finish('free'), connectMs);
    sock.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      void (async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(httpMs) });
          const b = (await r.json().catch(() => null)) as { app?: unknown } | null;
          finish(b?.app === 'page' ? 'page' : 'other');
        } catch {
          finish('other');
        }
      })();
    });
  });
}

export function realDeps(root: string): LaunchDeps {
  const serverEntry = path.join(root, 'app', 'server', 'dist', 'index.js');
  return {
    readPageEnv: () => { try { return fs.readFileSync(path.join(root, 'page.env'), 'utf8'); } catch { return null; } },
    mkdirData: () => { fs.mkdirSync(path.join(root, 'data'), { recursive: true }); },
    probe: (port) => probePort(port),
    spawnServer: (env) => {
      const child = spawn(process.execPath, ['--no-warnings', serverEntry], { env, stdio: 'inherit', cwd: root });
      return {
        exited: new Promise((resolve) => { child.on('exit', (code) => resolve(code ?? 1)); child.on('error', () => resolve(1)); }),
        kill: () => { child.kill(); },
      };
    },
    waitHealthy: async (port, timeoutMs, signal) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end && !signal.aborted) {
        if ((await probePort(port)) === 'page' && !signal.aborted) return true;
        await sleep(300);
      }
      return false;
    },
    openBrowser: (url) => {
      if (process.platform !== 'win32') return;
      const p = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
      p.on('error', () => {}); // 못 열어도 서버는 계속
      p.unref();
    },
    log: (m) => { console.log(m); },
    now: Date.now,
  };
}

/** app\launch.mjs 가 부른다. 콘솔 창 닫기·Ctrl+C 는 자식도 같이 받으므로 여기서는 자식이 끝나길 기다린다. SIGTERM 은 자식에게 넘긴다. */
export async function main(root: string): Promise<number> {
  const deps = realDeps(root);
  let current: ReturnType<LaunchDeps['spawnServer']> | null = null;
  const spawnServer = deps.spawnServer;
  deps.spawnServer = (env) => { current = spawnServer(env); return current; };
  for (const sig of ['SIGINT', 'SIGHUP'] as const) process.on(sig, () => {});
  process.on('SIGTERM', () => { current?.kill?.(); });
  return runLauncher(root, deps, process.env);
}
