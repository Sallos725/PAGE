import { expect, test, type Page } from '@playwright/test';
import { BLOCK0, LONG, readingMsg, resetState } from './helpers';
import { anchorOf } from '../src/lib/position';

test.beforeEach(async ({ request }) => { await resetState(request); });

const STATUS = '/#/read/main/c1/status';
async function openRules(page: Page) {
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '숨김 규칙' }).click();
  await expect(page.getByRole('dialog', { name: '숨김 규칙' })).toBeVisible();
}

test('hide rule from the card: offered, editable, hides the text, raw view still shows it, survives reload', async ({ page }) => {
  await page.goto(STATUS);
  await expect(page.locator('.scroll')).toContainText('HP 10');
  await openRules(page);
  const dlg = page.getByRole('dialog', { name: '숨김 규칙' });
  await expect(dlg.getByText('합성 상태창')).toBeVisible();
  await expect(dlg.getByText('입력용')).toHaveCount(0); // editdisplay 만 후보
  await dlg.getByRole('button', { name: '합성 상태창 가져오기' }).click();
  await expect(dlg.getByLabel('패턴')).toHaveValue('<st>[\\s\\S]*?</st>');
  await dlg.getByRole('button', { name: '저장' }).click();
  await expect(dlg.locator('.rule-list .rule')).toHaveCount(1);
  await expect(page.locator('.scroll')).not.toContainText('HP 10');
  await expect(page.locator('.scroll')).toContainText('본문 앞');
  await expect(page.locator('article[data-msg="5"] .hidden-msg')).toBeVisible(); // 통째로 숨겨진 메시지도 자리는 남는다
  await dlg.getByRole('button', { name: '닫기' }).click();
  await page.getByLabel('원문').check();
  await expect(page.locator('pre.raw').first()).toBeVisible();
  await expect(page.locator('.scroll')).toContainText('HP 10');
  await page.getByLabel('원문').uncheck();
  await page.reload();
  await expect(page.locator('.scroll')).toContainText('본문 앞');
  await expect(page.locator('.scroll')).not.toContainText('HP 10');
});

test('invalid patterns are rejected inline and nothing is saved', async ({ page, request }) => {
  await page.goto(STATUS);
  await openRules(page);
  const dlg = page.getByRole('dialog', { name: '숨김 규칙' });
  await dlg.getByRole('button', { name: '규칙 추가' }).click();
  await dlg.getByLabel('이름').fill('깨진 규칙');
  await dlg.getByLabel('패턴').fill('(');
  await dlg.getByRole('button', { name: '저장' }).click();
  await expect(dlg.getByRole('alert')).toContainText('문법');
  await dlg.getByLabel('패턴').fill('a*');
  await dlg.getByRole('button', { name: '저장' }).click();
  await expect(dlg.getByRole('alert')).toContainText('빈 문자열');
  const r = (await (await request.get('/api/state/hide-rules?source=main&char=c1')).json()) as { rules: unknown[] };
  expect(r.rules).toHaveLength(0);
});

test('hide my messages: scroll and book show no user messages; a saved position in one moves to the next', async ({ page, request }) => {
  // resetState 는 위치를 메시지 0(user) 에 둔다
  await request.put('/api/state/settings', { data: { 'reader.hideUser': true } });
  await page.goto('/#/read/main/c1/long');
  await expect(page.locator('article[data-msg="1"]')).toBeVisible();
  await expect(page.locator('article.msg.user')).toHaveCount(0);
  await expect.poll(() => readingMsg(page)).toBe(1);
  await expect(page.locator('.reader-notice')).toHaveCount(0); // 숨긴 메시지로 옮긴 것은 "바뀜"이 아니다
  await page.getByRole('button', { name: '책으로 보기' }).click();
  await expect(page.locator('.book article.msg.char').first()).toBeVisible();
  await expect(page.locator('.book article.msg.user')).toHaveCount(0);
  await page.getByRole('button', { name: '스크롤로 보기' }).click();
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByLabel('내 메시지 숨기기').uncheck();
  await expect(page.locator('article.msg.user').first()).toBeVisible();
});

test('a bookmark inside a hidden message asks to show my messages, then jumps there', async ({ page, request }) => {
  const start = { msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: anchorOf(BLOCK0(0), 0) };
  expect((await request.post(`/api/state/bookmarks?${LONG}`, { data: { kind: 'bookmark', start } })).ok()).toBe(true);
  await request.put('/api/state/settings', { data: { 'reader.hideUser': true } });
  await page.goto('/#/read/main/c1/long');
  await expect(page.locator('article[data-msg="1"]')).toBeVisible();
  await expect(page.locator('article.msg.user')).toHaveCount(0);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await page.locator('.bm[data-kind="bookmark"] .jump').click();
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  await expect.poll(async () => ((await (await request.get('/api/state/settings')).json()) as { settings: Record<string, unknown> }).settings['reader.hideUser']).toBe(false);
});

test('rename a character and a chat; lists and heading show the new names; empty restores', async ({ page }) => {
  await page.goto('/#/s/main/c/c1');
  await page.getByRole('button', { name: '목록' }).click();
  await page.getByRole('button', { name: '표시 이름 바꾸기' }).click();
  await page.getByLabel('새 이름').fill('앨리스');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('heading', { name: '앨리스' })).toBeVisible();
  await page.getByRole('button', { name: '긴 채팅 이름 바꾸기' }).click();
  await page.getByLabel('새 이름').fill('첫 권');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('link', { name: /첫 권/ }).first()).toBeVisible();
  await page.goto('/#/s/main');
  await expect(page.locator('.shelf-label', { hasText: '앨리스' })).toBeVisible();
  await page.goto('/#/s/main/c/c1');
  await page.getByRole('button', { name: '목록' }).click();
  await page.getByRole('button', { name: '표시 이름 바꾸기' }).click();
  await page.getByLabel('새 이름').fill('');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('heading', { name: 'Alice' })).toBeVisible();
});
