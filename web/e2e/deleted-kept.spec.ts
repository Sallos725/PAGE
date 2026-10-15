import { expect, test } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

test('a chat deleted in the source is listed separately on the character page and opens in the reader', async ({ page }) => {
  await page.goto('/#/s/main/c/c1');
  const gone = page.getByRole('region', { name: /원본에서 지워진 채팅 1권/ });
  await expect(gone).toBeVisible();
  await page.getByRole('button', { name: '목록' }).click();
  await gone.getByRole('link', { name: /gone/ }).click();
  await expect(page.locator('article[data-msg="0"]')).toContainText('[g0]');
  await expect(page.getByRole('status').filter({ hasText: '원본에서 지워진 채팅이에요' })).toBeVisible();
});

test('a character deleted in the source sits in its own section at the bottom of the library', async ({ page }) => {
  await page.goto('/');
  const gone = page.getByRole('region', { name: '원본에서 지워진 캐릭터' });
  await expect(gone.locator('.shelf-label', { hasText: 'Carol' })).toBeVisible();
  await expect(page.locator('.stacks .shelf-label', { hasText: 'Carol' })).toHaveCount(0);
  await gone.locator('.shelf-label', { hasText: 'Carol' }).click();
  await expect(page.getByRole('status').filter({ hasText: '원본에서 지워진 캐릭터예요' })).toBeVisible();
});

test('keep from the reader shows the chat in the kept shelf; unkeep removes it', async ({ page }) => {
  await page.goto('/#/read/main/c1/short');
  const keep = page.getByRole('button', { name: '보관' });
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/');
  const shelf = page.getByRole('region', { name: '보관함' });
  await expect(shelf.locator('.spine.kept')).toHaveCount(1);
  await expect(shelf.locator('.spine')).toHaveAttribute('aria-label', /짧은 채팅|short/);
  await expect(shelf.locator('.spine')).toHaveAttribute('aria-label', /^Alice · /);
  await expect(shelf.locator('.spine .spine-char')).toHaveText('Alice');
  await page.goto('/#/read/main/c1/short');
  await page.getByRole('button', { name: '보관' }).click();
  await expect(page.getByRole('button', { name: '보관' })).toHaveAttribute('aria-pressed', 'false');
  await page.goto('/');
  await expect(page.getByRole('region', { name: '보관함' })).toHaveCount(0);
});

test('sync now reports counts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '지금 동기화' }).click();
  await expect(page.getByRole('status').filter({ hasText: '바뀐 게 없어요.' })).toBeVisible();
  await expect(page.getByText(/마지막 동기화/)).toBeVisible();
});
