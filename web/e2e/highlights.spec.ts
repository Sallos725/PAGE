// web/e2e/highlights.spec.ts — 형광펜 모아 보기 (합성 채팅만)
import { expect, test } from '@playwright/test';
import { anchorOf } from '../src/lib/position';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

// serve.mjs 의 short 채팅 첫 메시지 글자 (합성)
const SHORT0 = '짧은 채팅의 첫 줄';
const pos = (o: number) => ({ msgIdx: 0, blockIdx: 0, charOffset: o, anchorHash: anchorOf(SHORT0, o) });

test('an old highlight without text is filled when its chat is opened', async ({ page, request }) => {
  const r = await request.post('/api/state/bookmarks?source=main&char=c1&chat=short', { data: { kind: 'highlight', start: pos(0), end: pos(5) } });
  expect(r.ok()).toBe(true);
  await page.goto('/#/highlights');
  await expect(page.locator('.hl-item')).toContainText('채팅을 한 번 열면');
  await page.goto('/#/read/main/c1/short');
  await expect.poll(async () => ((await (await request.get('/api/state/bookmarks?source=main&char=c1&chat=short')).json()) as { bookmarks: { text: string }[] }).bookmarks[0]?.text).toBe('짧은 채팅');
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await expect(page.locator('.bm[data-kind="highlight"] .bm-text')).toHaveText('짧은 채팅');
});

test('library tab groups other chats and opens one at the highlighted spot', async ({ page, request }) => {
  await request.post('/api/state/bookmarks?source=main&char=c1&chat=short', { data: { kind: 'highlight', start: pos(0), end: pos(5), text: '짧은 채팅' } });
  await page.goto('/#/read/main/c1/long');
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await page.getByRole('tab', { name: '서고 전체 형광펜' }).click();
  const item = page.locator('.hl-item', { hasText: '짧은 채팅' });
  await expect(item).toBeVisible();
  await item.locator('.hl-open').click();
  await expect(page).toHaveURL(/#\/read\/main\/c1\/short$/);
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
});

test('home links to the highlights page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '형광펜' }).click();
  await expect(page.getByRole('heading', { name: '형광펜' })).toBeVisible();
  await expect(page.getByText('아직 칠한 문장이 없어요.')).toBeVisible();
});
