import { expect, test, type Page } from '@playwright/test';
import { BLOCK0, LONG, bookInfo, msgOnBookView, readingMsg, resetState, savedMsg, scrollToMsg } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

async function open(page: Page) {
  await page.goto('/#/read/main/c1/long');
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
}
const fontSize = (page: Page, sel: string) => page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test('STAGE 2 DONE: mode and font changes resume at the same reading position', async ({ page }) => {
  await open(page);
  await scrollToMsg(page, 60);
  await expect.poll(() => savedMsg(page), { timeout: 15_000 }).toBe(60);

  // 스크롤 모드에서 글자 크기 키움 → 같은 메시지
  await page.getByRole('button', { name: '보기 설정' }).click();
  const before = await fontSize(page, '.scroll');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '글자 크기 키우기' }).click();
  await expect.poll(() => fontSize(page, '.scroll')).toBeGreaterThan(before);
  await expect.poll(() => readingMsg(page), { timeout: 10_000 }).toBe(60);

  // 책 모드로 → 같은 메시지, 다시 글자 크기 줄임 → 같은 메시지
  await page.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '책으로 보기' }).click();
  await expect.poll(async () => (await bookInfo(page)).msg).toBe(60);
  await page.getByRole('button', { name: '보기 설정' }).click();
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: '글자 크기 줄이기' }).click();
  await expect.poll(() => fontSize(page, '.book .strip')).toBeLessThan(before);
  await expect.poll(() => msgOnBookView(page, 60), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await bookInfo(page)).msg).toBe(60);

  // 스크롤로 돌아와도 같은 메시지
  await page.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '스크롤로 보기' }).click();
  await expect.poll(() => readingMsg(page), { timeout: 10_000 }).toBe(60);
});

test('book mode: font change re-paginates and keeps the page position after page turns', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '책으로 보기' }).click();
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(450); }
  const at = (await bookInfo(page)).msg;
  expect(at).toBeGreaterThan(0);
  const views = (await bookInfo(page)).views;
  await page.getByRole('button', { name: '보기 설정' }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '글자 크기 키우기' }).click();
  await expect.poll(async () => (await bookInfo(page)).views, { timeout: 10_000 }).toBeGreaterThan(views);
  await expect.poll(async () => (await bookInfo(page)).msg).toBe(at);
  await expect.poll(() => msgOnBookView(page, at)).toBe(true);
});

test('typography and theme settings apply, persist on the server, and survive a reload', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByLabel('테마').selectOption('sepia');
  await page.getByLabel('글꼴').selectOption('sans');
  await page.getByLabel('줄 간격').selectOption('2.2');
  await page.getByLabel('양쪽 정렬').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia');
  await expect.poll(() => page.locator('.scroll').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Pretendard');
  await expect.poll(async () => {
    const r = await page.request.get('/api/state/settings');
    return ((await r.json()) as { settings: Record<string, unknown> }).settings['reader.theme'];
  }).toBe('sepia');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia');
  await expect(page.locator('.scroll .para').first()).toHaveCSS('text-align', 'justify');
  const lh = await page.locator('.scroll').evaluate((el) => getComputedStyle(el).lineHeight);
  expect(parseFloat(lh) / (await fontSize(page, '.scroll'))).toBeCloseTo(2.2, 1);
});

test('bubble toggle: user messages on the right, reading position unchanged', async ({ page }) => {
  await open(page);
  await scrollToMsg(page, 20);
  await expect.poll(() => readingMsg(page)).toBe(20);
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByLabel('말풍선').check();
  await expect(page.getByTestId('scroll')).toHaveClass(/bubbles/);
  const userLeft = await page.locator('article.msg.user').first().evaluate((el) => parseFloat(getComputedStyle(el).marginLeft));
  expect(userLeft).toBeGreaterThan(20);
  await expect.poll(() => readingMsg(page), { timeout: 10_000 }).toBe(20);
});

test('bookmark: add at the current position, jump back to it, persists, delete', async ({ page }) => {
  await open(page);
  await scrollToMsg(page, 60);
  await expect.poll(() => readingMsg(page), { timeout: 15_000 }).toBe(60);
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await page.getByRole('button', { name: '현재 위치 책갈피' }).click();
  await expect(page.locator('.bm[data-kind="bookmark"]')).toContainText('메시지 61');

  await page.getByRole('button', { name: '닫기' }).click();
  await scrollToMsg(page, 45);
  await expect.poll(() => readingMsg(page)).toBe(45);
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await page.locator('.bm[data-kind="bookmark"] .jump').click();
  await expect.poll(() => readingMsg(page), { timeout: 10_000 }).toBe(60);
  await expect.poll(() => savedMsg(page), { timeout: 10_000 }).toBe(60); // 이동한 곳이 읽기 위치로 저장된다

  await page.reload();
  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await expect(page.locator('.bm')).toHaveCount(1);
  await page.getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('.bm')).toHaveCount(0);
  const r = await page.request.get(`/api/state/bookmarks?${LONG}`);
  expect(((await r.json()) as { bookmarks: unknown[] }).bookmarks).toHaveLength(0);
});

test('highlight: select text → highlight; shown in both modes and after reload; deletable', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const p = document.querySelector('article[data-msg="2"] .block[data-block="0"] p')!;
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); // Svelte 가 맨 앞에 빈 텍스트 앵커를 둘 수 있다
    let t = w.nextNode();
    while (t && !(t.nodeValue ?? '').length) t = w.nextNode();
    if (!t) throw new Error('no text');
    const r = document.createRange();
    r.setStart(t, 2);
    r.setEnd(t, 9);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.getByRole('button', { name: '하이라이트' }).click();
  const mark = page.locator('article[data-msg="2"] mark.hl');
  await expect(mark).toHaveText(BLOCK0(2).slice(2, 9));
  // 흑백(e-ink) 화면에선 연한 형광 바탕이 안 보인다 → 진한 밑줄을 함께 긋는다
  expect(await mark.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
  await expect(page.locator('article[data-msg="2"] .block[data-block="0"] p')).toHaveText(BLOCK0(2)); // 글자를 잃지 않는다

  await page.reload();
  await expect(page.locator('article[data-msg="2"] mark.hl')).toHaveText(BLOCK0(2).slice(2, 9));
  await page.getByRole('button', { name: '책으로 보기' }).click();
  await expect(page.locator('.book article[data-msg="2"] mark.hl')).toHaveText(BLOCK0(2).slice(2, 9));

  await page.getByRole('button', { name: '책갈피', exact: true }).click();
  await expect(page.locator('.bm[data-kind="highlight"]')).toContainText('메시지 3');
  await expect(page.locator('.bm[data-kind="highlight"] .bm-text')).toHaveText(BLOCK0(2).slice(2, 9)); // 칠한 문장이 저장된다 (화면 블록 글자 기준)
  await page.getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('.book mark.hl')).toHaveCount(0);
});

test('settings panel, bubbles and marks keep the strict CSP clean (benign chat)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective));
  });
  await page.goto('/#/read/main/c1/short');
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByLabel('말풍선').check();
  await page.getByLabel('테마').selectOption('dark');
  await page.getByRole('button', { name: '글자 크기 키우기' }).click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});
