import { expect, test } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

test('card image rule shows the card asset in place of the tag; toggle off restores the tag; raw keeps it', async ({ page }) => {
  await page.goto('/#/read/main/c1/face');
  const msg = page.locator('article[data-msg="1"]');
  await expect(msg.locator('.img img')).toHaveCount(1); // 조건 블록 안의 그림은 빠진다
  await expect(msg).not.toContainText('<표정=웃음>');
  await expect(msg).toContainText('그리고 말했다');

  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '숨김 규칙' }).click();
  const dlg = page.getByRole('dialog', { name: '숨김 규칙' });
  await dlg.getByLabel('합성 표정 그림 표시').uncheck();
  await expect(msg).toContainText('<표정=웃음>');
  await expect(msg.locator('.img img')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('article[data-msg="1"]')).toContainText('<표정=웃음>');

  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '숨김 규칙' }).click();
  await page.getByRole('dialog', { name: '숨김 규칙' }).getByLabel('합성 표정 그림 표시').check();
  await expect(page.locator('article[data-msg="1"] .img img')).toHaveCount(1);
  await page.getByRole('dialog', { name: '숨김 규칙' }).getByRole('button', { name: '닫기' }).click();
  await page.getByLabel('원문').check();
  await expect(page.locator('article[data-msg="1"] pre.raw')).toContainText('<표정=웃음>');
});
