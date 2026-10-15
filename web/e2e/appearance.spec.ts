// 커스텀 테마·글꼴 서재 (스펙 §7 E2E). 테마 CSS 는 합성, 글꼴은 저장소의 MaruBuri 서브셋(OFL).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const themeLink = (page: Page) => page.locator('link#page-theme');
const FONT = path.join(import.meta.dirname, '..', 'src', 'assets', 'fonts', 'MaruBuri-Regular.subset.woff2');

test('add the default preset, use it, edit its css, survive reload', async ({ page }) => {
  await page.goto('/#/appearance');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  const editor = page.getByRole('form', { name: '테마 편집' });
  await expect(editor.getByLabel('CSS')).toHaveValue(/:root\[data-theme\] \{/);
  await editor.getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: '새 테마 사용' }).click();
  await expect(themeLink(page)).toHaveAttribute('href', /\/api\/themes\/[0-9a-f]{32}\/theme\.css\?v=\d+/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await token(page, '--bg')).toBe('#f3f1ec'); // 프리셋 값 = 밝게 바탕이라 이 단언은 링크가 걸렸는지만 본다 (실제 검증은 편집 단계)

  await page.getByRole('button', { name: '새 테마 편집' }).click();
  await editor.getByLabel('CSS').fill(':root[data-theme] { --bg: #102030; }');
  await editor.getByRole('button', { name: '저장' }).click();
  await expect.poll(() => token(page, '--bg')).toBe('#102030');

  await page.reload();
  await expect(themeLink(page)).toHaveCount(1);
  await expect.poll(() => token(page, '--bg')).toBe('#102030');
});

test('import a header .css, export it back, delete the active preset falls back to its base', async ({ page }) => {
  await page.goto('/#/appearance');
  const file = '/* @page-theme\n   name: 밤바다\n   base: dark\n*/\n:root[data-theme] { --accent: #4a90c0; }\n';
  await page.locator('input[type="file"][accept=".css,text/css"]').setInputFiles({ name: 'night.css', mimeType: 'text/css', buffer: Buffer.from(file) });
  await expect(page.getByText('밤바다')).toBeVisible();
  await expect(page.locator('.item', { hasText: '밤바다' }).locator('.meta')).toContainText('어둡게');
  await page.getByRole('button', { name: '밤바다 사용' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => token(page, '--accent')).toBe('#4a90c0');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '밤바다 내보내기' }).click()]);
  expect(download.suggestedFilename()).toBe('밤바다.css');
  const text = fs.readFileSync(await download.path(), 'utf8');
  expect(text).toBe(file);

  await page.getByRole('button', { name: '밤바다 삭제' }).click();
  await page.getByRole('button', { name: '밤바다 정말 삭제' }).click();
  await expect(page.getByText('밤바다')).toHaveCount(0);
  await expect(themeLink(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // 바탕 테마로
  // 설정 PUT 은 잠깐 모아서 보내므로 저장될 때까지 기다린다
  await expect.poll(async () => ((await (await page.request.get('/api/state/settings')).json()) as { settings: Record<string, unknown> }).settings['reader.theme']).toBe('dark');
});

test('safe mode skips the preset css and shows the banner', async ({ page, request }) => {
  const res = await request.post('/api/themes', { data: { name: '깨진 테마', base: 'light', css: 'body { display: none; }' } });
  const { theme } = (await res.json()) as { theme: { id: string } };
  await request.put('/api/state/settings', { data: { 'reader.theme': `custom:${theme.id}` } });
  await page.goto('/?theme=off#/appearance');
  // 새 컨텍스트라 테마 캐시가 비어 있다. 목록이 뜨면(= 설정·테마 목록 적용이 끝남) body 도 보인다는 증거.
  await expect(page.locator('.item-name', { hasText: '깨진 테마' })).toBeVisible();
  await expect(themeLink(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('status').filter({ hasText: '안전 모드' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '테마·글꼴' })).toBeVisible();
  await page.getByRole('link', { name: '다시 켜기' }).click();
  await expect(themeLink(page)).toHaveCount(1);
  await expect(page.locator('body')).toBeHidden(); // 깨진 테마가 다시 걸린다 — 탈출구가 진짜로 필요했던 상황
});

test('upload a font, it shows in the view settings and applies to the reader', async ({ page }) => {
  await page.goto('/#/appearance');
  await page.locator('input[type="file"][accept^=".woff2"]').setInputFiles(FONT);
  await expect(page.locator('.item-name', { hasText: 'MaruBuri-Regular.subset' })).toBeVisible();
  const css = await (await page.request.get('/api/fonts.css')).text();
  expect(css).toContain('font-family: "MaruBuri-Regular.subset"');

  await page.goto('/#/read/main/c1/short');
  await page.getByRole('button', { name: '보기 설정' }).click();
  const select = page.getByRole('dialog', { name: '보기 설정' }).getByRole('combobox', { name: '글꼴', exact: true });
  await select.selectOption({ label: 'MaruBuri-Regular.subset' });
  await expect.poll(() => token(page, '--reader-font')).toMatch(/^"MaruBuri-Regular\.subset", /);
  // document.fonts.check 는 없는 패밀리에도 true 라 쓰지 않는다. 올린 글꼴의 FontFace 가 실제로 받아졌는지 본다.
  await expect.poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'MaruBuri-Regular.subset' && f.status === 'loaded'))).toBe(true);
  await expect(page.getByRole('dialog', { name: '보기 설정' }).getByRole('link', { name: '테마·글꼴 관리' })).toHaveAttribute('href', '#/appearance');
});
