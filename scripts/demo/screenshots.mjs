// README 스크린샷 생성: 데모 서버(합성 이야기)를 띄우고 Chromium 으로 찍어 docs/assets/screenshots/ 에 저장한다.
// 사전: (cd server && npm run build) && (cd web && npm run build). 사용: node scripts/demo/screenshots.mjs [--only 장면,장면]  (장면: import-desktop, source-desktop, library-imported-desktop — 주면 그 장면만 찍는다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(path.join(root, 'web', 'package.json'));
const { chromium, devices } = require('@playwright/test');

const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(root, 'docs', 'assets', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;
const want = (name) => !only || only.has(name);
const NEW_SCENES = ['import-desktop', 'source-desktop', 'library-imported-desktop'];
for (const n of only ?? []) if (!NEW_SCENES.includes(n)) throw new Error(`--only: 알 수 없는 장면 ${n} (${NEW_SCENES.join(', ')})`);

const servers = [];
async function startServer(port, extraEnv = {}) {
  const server = spawn(process.execPath, [path.join(here, 'serve-demo.mjs')], { env: { ...process.env, DEMO_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
    server.on('exit', (c) => reject(new Error(`demo server exited ${c}`)));
  });
}
if (!only) await startServer(PORT);

const putSettings = (s) => fetch(`${BASE}/api/state/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
const DEFAULTS = { 'reader.mode': 'scroll', 'reader.theme': 'light', 'reader.bubble': false, 'reader.hideUser': false, 'reader.fontSize': 18 };

const browser = await chromium.launch({ args: ['--lang=ko-KR'] });
try {
  if (!only) {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await desktop.newPage();

    await putSettings(DEFAULTS);
    await page.goto(`${BASE}/`);
    await page.locator('.shelf-label').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'library-desktop.png') });

    await page.goto(`${BASE}/#/s/demo/c/seoyun`);
    await page.getByRole('link', { name: /등대 도서관/ }).first().waitFor();
    await page.screenshot({ path: path.join(OUT, 'shelf-desktop.png') });

    await page.goto(`${BASE}/#/read/demo/seoyun/lighthouse`);
    await page.locator('article[data-msg="1"]').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'reader-desktop.png') });

    await page.getByRole('button', { name: '책으로 보기' }).click();
    await page.getByTestId('book').waitFor();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, 'book-desktop.png') });
    // 보관함: 채팅 둘을 보관해 홈의 보관함 칸을 보인다.
    for (const [ch, c] of [['seoyun', 'letter'], ['haneul', 'station']]) {
      await fetch(`${BASE}/api/state/kept?source=demo&char=${ch}&chat=${c}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kept: true }) });
    }
    await putSettings(DEFAULTS);
    await page.goto(`${BASE}/`);
    await page.getByRole('region', { name: '보관함' }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'kept-desktop.png') });

    // 내보내기 패널 (형식·그림 크기 선택).
    await page.goto(`${BASE}/#/read/demo/seoyun/lighthouse`);
    await page.locator('article[data-msg="1"]').waitFor();
    await page.getByRole('button', { name: '보기 설정' }).click();
    await page.getByRole('button', { name: '내보내기' }).click();
    await page.getByRole('dialog', { name: '내보내기' }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'export-desktop.png') });

    // 커스텀 테마: 예시 테마를 임포트해 쓰고, 테마·글꼴 화면과 그 테마로 칠한 리더를 찍는다.
    const css = fs.readFileSync(path.join(here, 'themes', 'night-sea.css'), 'utf8');
    await page.goto(`${BASE}/#/appearance`);
    await page.locator('input[type="file"][accept=".css,text/css"]').setInputFiles({ name: 'night-sea.css', mimeType: 'text/css', buffer: Buffer.from(css) });
    await page.getByRole('button', { name: '밤바다 사용' }).click();
    await page.locator('link#page-theme').waitFor({ state: 'attached' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'appearance-desktop.png') });
    await page.goto(`${BASE}/#/read/demo/seoyun/lighthouse`);
    await page.locator('article[data-msg="1"]').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'theme-reader-desktop.png') });
    const themes = (await (await fetch(`${BASE}/api/themes`)).json()).themes;
    for (const t of themes) await fetch(`${BASE}/api/themes/${t.id}`, { method: 'DELETE' });
    await putSettings(DEFAULTS);
    await desktop.close();

    await putSettings({ ...DEFAULTS, 'reader.theme': 'dark' });
    const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
    const p = await phone.newPage();
    await p.goto(`${BASE}/`);
    await p.locator('.shelf-label').first().waitFor();
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(OUT, 'library-phone-dark.png') });
    await p.goto(`${BASE}/#/read/demo/seoyun/lighthouse`);
    await p.locator('article[data-msg="1"]').waitFor();
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, 'reader-phone-dark.png') });
    await p.getByRole('button', { name: '보기 설정' }).click();
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(OUT, 'settings-phone-dark.png') });
    await phone.close();
    await putSettings(DEFAULTS);
  }

  // 1.1.0 장면: 가져온 채팅(서하)과 Windows 포터블 원본 연결.
  const shot = async (ctx, name) => ctx.screenshot({ path: path.join(OUT, `${name}.png`) });
  if (want('library-imported-desktop') || want('import-desktop')) {
    // 서고에는 'PocketRisu'(시연 책장) 와 '가져온 채팅' 이 같이 보이도록 원본 이름을 pocketrisu 로 둔 서버.
    const IP = PORT + 2;
    const IBASE = `http://127.0.0.1:${IP}`;
    await startServer(IP, { DEMO_IMPORTED: '1', DEMO_SOURCE_ID: 'pocketrisu' });
    await fetch(`${IBASE}/api/state/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(DEFAULTS) });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'ko-KR' });
    const pg = await ctx.newPage();
    if (want('library-imported-desktop')) {
      await pg.setViewportSize({ width: 1280, height: 1180 }); // 두 책장이 한 화면에 들어오도록 세로를 늘린다
      await pg.goto(`${IBASE}/`);
      await pg.getByRole('heading', { name: '가져온 채팅' }).waitFor();
      await pg.locator('.shelf-label').first().waitFor();
      await pg.waitForTimeout(500);
      await shot(pg, 'library-imported-desktop');
      await pg.setViewportSize({ width: 1280, height: 800 });
    }
    if (want('import-desktop')) {
      // 합성 채팅 JSON 하나를 올려 결과 문구까지 보인다 (서하는 첫 캐릭터라 미리 골라져 있다).
      const extra = { type: 'risuChat', ver: 2, data: { id: 'rain', name: '비 오는 날', lastDate: Date.now(), message: [
        { role: 'user', data: '정류장 지붕을 두드리는 빗소리가 커졌다.' },
        { role: 'char', data: '"이 비, 금방 그칠 것 같지는 않네요." 서하가 하늘을 올려다보았다.' },
      ] } };
      await pg.goto(`${IBASE}/#/import`);
      await pg.locator('#import-char-select').waitFor();
      await pg.locator('#import-file-input').setInputFiles({ name: '비-오는-날.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(extra)) });
      await pg.getByRole('button', { name: '올리기' }).click();
      await pg.getByRole('list', { name: '올리기 결과' }).getByRole('listitem').first().waitFor();
      await pg.waitForTimeout(500);
      await shot(pg, 'import-desktop');
    }
    await ctx.close();
  }
  if (want('source-desktop')) {
    // 포터블(Windows) 흉내 서버 — 원본이 연결되지 않은 상태. 경로 칸에는 합성 경로만 입력하고 [확인] 은 누르지 않는다.
    await startServer(PORT + 1, { DEMO_PORTABLE: '1' });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'ko-KR' });
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${PORT + 1}/#/source`);
    await pg.getByRole('button', { name: '찾아보기' }).waitFor();
    await pg.locator('input[name="source-path"]').fill('C:\\Users\\Reader\\PocketRisu');
    await pg.waitForTimeout(400);
    await shot(pg, 'source-desktop');
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
console.log(`screenshots written to ${path.relative(root, OUT)}`);
