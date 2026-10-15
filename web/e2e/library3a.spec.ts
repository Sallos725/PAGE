import { expect, test } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); }); // 위치 = 긴 채팅 메시지 0

test('home is the library: desk with the last read chat, stacks per character with spines', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '서고', level: 1 })).toBeVisible();
  const desk = page.locator('.desk');
  await expect(desk.locator('.desk-main')).toContainText('긴 채팅');
  await expect(desk.locator('.desk-main')).toContainText('Alice');
  await expect(page.locator('.stacks .shelf-label')).toHaveCount(2);
  await expect(page.locator('.shelf-label', { hasText: 'Alice' }).locator('img.char-image')).toBeVisible();
  await expect(page.locator('.shelf-label', { hasText: 'Bob' }).locator('.char-image.initial')).toHaveText('B');
  const spine = page.locator('.spine[aria-label^="긴 채팅"]').first();
  await expect(spine).toHaveClass(/reading/);
  await expect(spine).toHaveAttribute('data-c', /^[0-6]$/);
  const h = await spine.evaluate((el) => el.getBoundingClientRect().height);
  const short = await page.locator('.spine[aria-label^="chat-short"]').first().evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThan(short);
  await desk.locator('.desk-main').click();
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
});

test('character shelf: shelf/list toggle is remembered across reloads', async ({ page }) => {
  await page.goto('/#/s/main/c/c1');
  await expect(page.locator('.shelf.wrap .spine').first()).toBeVisible();
  await page.getByRole('button', { name: '목록' }).click();
  await expect(page.getByRole('button', { name: '목록' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.list a', { hasText: '긴 채팅' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '목록' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '서가' }).click();
  await expect(page.locator('.shelf.wrap .spine').first()).toBeVisible();
});

test('reader chrome: title and chapter in the header, chapter head, speaker lines, progress bar', async ({ page }) => {
  await page.goto('/#/read/main/c1/long');
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  await expect(page.locator('.reader-title-main')).toHaveText('긴 채팅');
  await expect(page.locator('.reader-title .index')).toHaveText('1장 / 4');
  await expect(page.locator('.chapter-head').first()).toContainText('CHAPTER 01');
  await expect(page.locator('article[data-msg="1"] .speaker .who')).toHaveText('Alice');
  await expect(page.locator('article[data-msg="0"] .speaker .who')).toHaveText('나');
  await expect(page.locator('.progress .progress-bar .fill')).toBeAttached();
  await expect(page.getByRole('button', { name: '책으로 보기' })).toBeVisible();
});
