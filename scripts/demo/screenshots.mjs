// README 스크린샷 생성: 데모 서버(합성 이야기)를 띄우고 Chromium 으로 찍어 docs/assets/screenshots/ 에 저장한다.
// 사전: (cd server && npm run build) && (cd web && npm run build). 사용: node scripts/demo/screenshots.mjs
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

const server = spawn(process.execPath, [path.join(here, 'serve-demo.mjs')], { env: { ...process.env, DEMO_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
  server.on('exit', (c) => reject(new Error(`demo server exited ${c}`)));
});

const putSettings = (s) => fetch(`${BASE}/api/state/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
const DEFAULTS = { 'reader.mode': 'scroll', 'reader.theme': 'light', 'reader.bubble': false, 'reader.hideUser': false, 'reader.fontSize': 18 };

const browser = await chromium.launch();
try {
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
} finally {
  await browser.close();
  server.kill();
}
console.log(`screenshots written to ${path.relative(root, OUT)}`);
