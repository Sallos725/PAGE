import { expect, test, type Page } from '@playwright/test';
import { resetState } from './helpers';
import { anchorOf } from '../src/lib/position';

const READER = '/#/read/main/c1/long';

/** 읽기 줄(sticky 헤더 아래 20px)에 걸린 메시지 인덱스 */
const readingMsg = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.reader-bar')!.getBoundingClientRect().bottom;
    const el = document.elementFromPoint(window.innerWidth / 2, bar + 20)?.closest('[data-msg]') as HTMLElement | null;
    return el ? Number(el.dataset.msg) : null;
  });

// 서버의 읽기 위치는 테스트 사이에 남는다 → 매 테스트 전에 'long' 채팅을 처음 위치로 되돌린다 (정확한 앵커로, "바뀌었을 수 있어요" 배너 없이).
const BLOCK0 = `[m0-p0] ${'첫 문단 '.repeat(8)}0`; // serve.mjs 의 합성 텍스트 규칙과 같다
test.beforeEach(async ({ request }) => {
  await resetState(request); // 위치·설정·책갈피를 되돌린다 (서버 상태는 테스트 사이에 남는다)
});

/** 아래로 스크롤하며 챕터를 로드시키다가, 해당 메시지가 DOM 에 생기면 화면 위로 가져온다. */
async function scrollToMsg(page: Page, n: number) {
  for (let i = 0; i < 80; i++) {
    const found = await page.evaluate((idx) => {
      const el = document.querySelector(`article[data-msg="${idx}"]`);
      if (el) el.scrollIntoView();
      return !!el;
    }, n);
    if (found) return;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
  }
  throw new Error(`message ${n} never appeared`);
}

async function open(page: Page) {
  await page.goto(READER);
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
}

test('browse the library down to a chat and open it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.shelf-label', { hasText: 'Alice' }).click();
  await page.getByRole('button', { name: '목록' }).click();
  await page.getByRole('link', { name: /긴 채팅/ }).first().click(); // '최근에 펼친 책' 에도 같은 링크가 있다
  await expect(page.locator('article[data-msg="0"] .para').first()).toContainText('[m0-p0]');
  await expect(page.locator('.para.dialogue').first()).toContainText('[m0-p1]'); // 따옴표 문단은 dialogue
  await expect(page.locator('.progress')).toContainText('130');
});

test('the SPA itself loads under the strict CSP without violations (benign chat)', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective));
  });
  // 위반 0 을 단언하려면 무해한 채팅이어야 한다: 신뢰할 수 없는 마크업을 DOMParser 로 파싱하면(스타일/핸들러 속성 포함 시)
  // 브라우저가 "차단했다"는 위반 이벤트를 낸다 — 실행은 되지 않는다(아래 XSS 테스트가 확인). stage-2a-notes 참고.
  await page.goto('/#/read/main/c1/short');
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(problems).toEqual([]);
  const csp = (await page.request.get('/')).headers()['content-security-policy'];
  expect(csp).toContain("default-src 'self'");
});

test('reading position is restored after a reload (same message at the reading line)', async ({ page }) => {
  await open(page);
  await scrollToMsg(page, 60); // 60 번은 첫 챕터(0..39) 밖이라 이웃 챕터가 로드되며 스크롤이 이어진다
  await expect.poll(() => readingMsg(page), { timeout: 15_000 }).toBe(60);
  await page.waitForResponse((r) => r.url().includes('/api/state/position') && r.request().method() === 'PUT', { timeout: 10_000 });
  await page.reload();
  await expect(page.locator('article[data-msg="60"]')).toBeVisible();
  await expect.poll(() => readingMsg(page), { timeout: 15_000 }).toBe(60);
});

test('only a few chapters are in the DOM while reading through the whole chat', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(120);
    const n = await page.locator('section.chapter').count();
    expect(n).toBeLessThanOrEqual(3);
    if (await page.locator('article[data-msg="129"]').count()) break;
  }
  await expect(page.locator('article[data-msg="129"]')).toBeAttached();
  expect(await page.locator('section.chapter').count()).toBeLessThanOrEqual(3);
  // 앞쪽 챕터는 해제됐다
  expect(await page.locator('article[data-msg="0"]').count()).toBe(0);
});

test('Asset Maid illustration renders as an image from the library, not as HTML', async ({ page }) => {
  await open(page);
  const img = page.locator('article[data-msg="5"] img').first();
  await expect(img).toBeVisible();
  await img.scrollIntoViewIfNeeded(); // loading="lazy": WebKit 은 화면 가까이 와야 불러온다 (폰 높이에선 화면 밖)
  await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toMatch(/^\/api\/asset\/main\/c1\//);
  await expect(page.locator('article[data-msg="5"] .para')).toContainText('[m5-after]');
  expect(await page.locator('article[data-msg="5"] [class*="am-"]').count()).toBe(0);
});

test('untrusted HTML in a message is shown as text and never executed', async ({ page }) => {
  await open(page);
  await expect(page.locator('article[data-msg="7"]')).toContainText('[m7-xss]');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('article[data-msg="7"] script, article[data-msg="7"] img').count()).toBe(0);
  await page.getByLabel('원문').check(); // 원문 표시: 마크업이 텍스트로 그대로 보인다
  await expect(page.locator('article[data-msg="7"] pre[data-raw]')).toContainText('<script>window.__xss=1</script>');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('a short chat opens without errors and shows its end', async ({ page }) => {
  await page.goto('/#/read/main/c1/short');
  await expect(page.locator('article[data-msg="0"]')).toContainText('짧은 채팅의 첫 줄');
  await expect(page.getByText('끝이에요')).toBeVisible();
});
