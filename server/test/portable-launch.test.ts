import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { childEnv, parsePageEnv, probePort, runLauncher, type LaunchDeps } from '../src/portable/launch.js';

describe('parsePageEnv', () => {
  it('허용 키만, 주석·빈 줄·따옴표·BOM 처리, 무시한 키 이름', () => {
    const r = parsePageEnv('\uFEFF# 설정\nPAGE_PORT=9001\n\nLOG_LEVEL="warn"\nPAGE_BIND=0.0.0.0\nPAGE_SOURCES=a=b\nbroken line\n');
    expect(r.env).toEqual({ PAGE_PORT: '9001', LOG_LEVEL: 'warn' });
    expect(r.ignored).toEqual(['PAGE_BIND', 'PAGE_SOURCES']);
  });
  it('PAGE_PRESERVE_ORPHANS 는 받지 않는다 (서버가 =1 이면 시작을 거부하는 예약 키)', () => {
    const r = parsePageEnv('PAGE_PRESERVE_ORPHANS=1\nPAGE_PORT=9001\n');
    expect(r.env).toEqual({ PAGE_PORT: '9001' });
    expect(r.ignored).toEqual(['PAGE_PRESERVE_ORPHANS']);
  });
  it('따옴표 없는 값의 인라인 주석을 벗긴다', () => {
    const r = parsePageEnv('PAGE_PORT=9001 # 주석\nLOG_LEVEL="warn" # 따옴표\nPAGE_WARN_FREE_GB=5#붙은#은 값\n');
    expect(r.env).toEqual({ PAGE_PORT: '9001', LOG_LEVEL: 'warn', PAGE_WARN_FREE_GB: '5#붙은#은 값' });
  });
});

describe('childEnv', () => {
  it('포터블 고정값이 사용자 값을 이긴다', () => {
    const e = childEnv({ PATH: 'p', PAGE_BIND: '0.0.0.0' }, 'C:\\PAGE', { PAGE_PORT: '9001' }, (...p) => p.join('\\'));
    expect(e).toMatchObject({
      PATH: 'p', PAGE_PORTABLE: '1', PAGE_BIND: '127.0.0.1', PAGE_PORT: '9001', NODE_ENV: 'production',
      PAGE_DATA_DIR: 'C:\\PAGE\\data', PAGE_WEB_DIR: 'C:\\PAGE\\app\\web\\dist',
    });
    expect(e.PAGE_PDF_URL).toBeUndefined();
  });
});

function fakeDeps(over: Partial<LaunchDeps> = {}) {
  const exits: number[] = [];
  const deps: LaunchDeps & { spawned: number; opened: string[]; logs: string[] } = {
    spawned: 0, opened: [], logs: [],
    readPageEnv: () => null,
    mkdirData: () => {},
    probe: async () => 'free',
    // 자식은 한 틱 뒤에 끝난다 (waitHealthy 가 먼저 결론 나는 경우를 흉내)
    spawnServer: () => { deps.spawned++; const code = exits.shift() ?? 0; return { exited: new Promise<number>((r) => setTimeout(() => r(code), 0)) }; },
    waitHealthy: async () => true,
    openBrowser: (u) => { deps.opened.push(u); },
    log: (m) => { deps.logs.push(m); },
    now: () => 0,
    ...over,
  };
  return { deps, exits };
}

describe('runLauncher', () => {
  it('켜고 브라우저를 한 번 연다, 75 면 다시 띄우되 브라우저는 다시 안 엶', async () => {
    const { deps, exits } = fakeDeps();
    exits.push(75, 75, 0);
    expect(await runLauncher('/r', deps, {})).toBe(0);
    expect(deps.spawned).toBe(3);
    expect(deps.opened).toEqual(['http://127.0.0.1:8787/']);
  });
  it('PAGE_NO_BROWSER=1 이면 안 엶', async () => {
    const { deps } = fakeDeps();
    await runLauncher('/r', deps, { PAGE_NO_BROWSER: '1' });
    expect(deps.opened).toEqual([]);
  });
  it('이미 켜진 PAGE 면 브라우저만 열고 0', async () => {
    const { deps } = fakeDeps({ probe: async () => 'page' });
    expect(await runLauncher('/r', deps, {})).toBe(0);
    expect(deps.spawned).toBe(0);
    expect(deps.opened).toEqual(['http://127.0.0.1:8787/']);
  });
  it('다른 프로그램이 포트를 쓰면 1 + 안내', async () => {
    const { deps } = fakeDeps({ probe: async () => 'other', readPageEnv: () => 'PAGE_PORT=9001' });
    expect(await runLauncher('/r', deps, {})).toBe(1);
    expect(deps.logs.join('\n')).toContain('9001');
  });
  it('0·75 아닌 코드는 그대로 돌려준다', async () => {
    const { deps, exits } = fakeDeps();
    exits.push(3);
    expect(await runLauncher('/r', deps, {})).toBe(3);
  });
  it('60초 안에 5번 넘게 다시 켜지면 멈춘다', async () => {
    const { deps, exits } = fakeDeps();
    exits.push(75, 75, 75, 75, 75, 75, 75);
    expect(await runLauncher('/r', deps, {})).toBe(1);
    expect(deps.spawned).toBe(6);
  });
  it('다시 켜기 5번은 허용한다', async () => {
    const { deps, exits } = fakeDeps();
    exits.push(75, 75, 75, 75, 75, 0);
    expect(await runLauncher('/r', deps, {})).toBe(0);
    expect(deps.spawned).toBe(6);
  });
  it('PAGE_PORT 가 올바르지 않으면 1 + 안내', async () => {
    for (const bad of ['abc', '0', '70000', '', '90.5']) {
      const { deps } = fakeDeps({ readPageEnv: () => `PAGE_PORT=${bad}` });
      expect(await runLauncher('/r', deps, {})).toBe(1);
      expect(deps.spawned).toBe(0);
      expect(deps.logs.join('\n')).toContain('PAGE_PORT 값이 올바르지 않아요');
    }
  });
  it('page.env 의 인라인 주석이 달린 PAGE_PORT 를 쓴다', async () => {
    const { deps } = fakeDeps({ readPageEnv: () => 'PAGE_PORT=9001 # 주석' });
    await runLauncher('/r', deps, {});
    expect(deps.opened).toEqual(['http://127.0.0.1:9001/']);
  });
  it('healthy 전에 자식이 1 로 끝나면 바로 1, 브라우저 안 열고 폴링 취소', async () => {
    let signal: AbortSignal | undefined;
    const { deps, exits } = fakeDeps({
      waitHealthy: (_p, _t, sig) => { signal = sig; return new Promise<boolean>((res) => sig.addEventListener('abort', () => res(false))); },
    });
    exits.push(1);
    expect(await runLauncher('/r', deps, {})).toBe(1);
    expect(deps.opened).toEqual([]);
    expect(signal?.aborted).toBe(true);
  });
  it('waitHealthy 가 true 여도 그 사이 자식이 끝났으면 브라우저를 안 연다', async () => {
    let release!: (v: boolean) => void;
    const { deps, exits } = fakeDeps({ waitHealthy: () => new Promise<boolean>((r) => { release = r; }) });
    exits.push(1);
    expect(await runLauncher('/r', deps, {})).toBe(1);
    release(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.opened).toEqual([]);
  });
  it('page.env 의 무시한 키를 경고한다 (값은 안 씀)', async () => {
    const { deps } = fakeDeps({ readPageEnv: () => 'PAGE_BIND=0.0.0.0' });
    await runLauncher('/r', deps, {});
    expect(deps.logs.join('\n')).toContain('PAGE_BIND');
    expect(deps.logs.join('\n')).not.toContain('0.0.0.0');
  });
});

describe('probePort (실제 소켓)', () => {
  const listen = (srv: net.Server) => new Promise<number>((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as net.AddressInfo).port)));
  const closeSrv = (srv: net.Server) => new Promise<void>((res) => { (srv as http.Server).closeAllConnections?.(); srv.close(() => res()); });
  const json = (body: unknown) => http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body)); });

  it('빈 포트 → free', async () => {
    const s = net.createServer();
    const port = await listen(s);
    await closeSrv(s);
    expect(await probePort(port)).toBe('free');
  });
  it('다른 JSON 을 주는 서버 → other', async () => {
    const s = json({ app: 'x' });
    const port = await listen(s);
    expect(await probePort(port)).toBe('other');
    await closeSrv(s);
  });
  it('{app:"page"} → page', async () => {
    const s = json({ app: 'page' });
    const port = await listen(s);
    expect(await probePort(port)).toBe('page');
    await closeSrv(s);
  });
  it('붙기만 하고 응답 없는 서버 → other (HTTP 타임아웃)', async () => {
    const socks: net.Socket[] = [];
    const s = net.createServer((c) => { socks.push(c); });
    const port = await listen(s);
    expect(await probePort(port, 5000, 200)).toBe('other');
    socks.forEach((c) => c.destroy());
    await closeSrv(s);
  });
});
