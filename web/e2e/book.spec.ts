import { expect, test, type Page } from '@playwright/test';
import { resetState } from './helpers';
import { anchorOf } from '../src/lib/position';

const READER = '/#/read/main/c1/long';
const BLOCK0 = `[m0-p0] ${'첫 문단 '.repeat(8)}0`; // serve.mjs 의 합성 텍스트 규칙과 같다

// 서버의 읽기 위치·설정은 테스트 사이에 남는다 → 매 테스트 전에 되돌린다.
test.beforeEach(async ({ request }) => {
  await resetState(request); // 위치·설정·책갈피를 되돌린다 (서버 상태는 테스트 사이에 남는다)
});

const book = (page: Page) => page.getByTestId('book');
const info = (page: Page) =>
  book(page).evaluate((el) => {
    const d = (el as HTMLElement).dataset;
    return { view: Number(d.view), views: Number(d.views), perView: Number(d.perView), msg: Number(d.msg) };
  });

async function openBook(page: Page) {
  await page.goto(READER);
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  await page.getByRole('button', { name: '책으로 보기' }).click();
  await expect(book(page)).toBeVisible();
  await expect.poll(async () => (await info(page)).views).toBeGreaterThan(1);
}

/** 쪽 넘김 스크롤이 멈추고 위치가 확정될 때까지 기다린다. 연달아 넘기는 동안은 스크롤이 멈추지 않아
 *  data-msg 가 이전 쪽 그대로다 (Chromium 의 부드러운 스크롤은 한 번에 450ms 보다 길다). */
async function settled(page: Page) {
  let prev = NaN;
  await expect.poll(async () => {
    const x = await book(page).evaluate((el) => el.scrollLeft);
    const same = x === prev;
    prev = x;
    return same;
  }, { intervals: [300] }).toBe(true);
  await page.waitForTimeout(300); // settle 은 스크롤이 멈추고 120ms 뒤
}

/** 읽기 위치 PUT 이 서버에 반영될 때까지 기다린다 (1.5초 디바운스). */
const savedMsg = async (page: Page) => {
  const r = await page.request.get('/api/state/position?source=main&char=c1&chat=long');
  return ((await r.json()) as { position: { msgIdx: number } | null }).position?.msgIdx ?? null;
};

// 펼침(두 쪽)은 넓은 화면의 동작이다 — 폰 프로필(webkit = iPhone)에서도 화면 폭을 고정해 같은 것을 확인한다.
test.describe('wide screen', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('book mode paginates into spreads on a wide screen and starts at the saved position', async ({ page }) => {
    await openBook(page);
    const i = await info(page);
    expect(i).toMatchObject({ view: 0, perView: 2, msg: 0 });
    // 한 view 에 두 열이 실제로 보인다: strip 의 column-width 는 view 폭의 절반 남짓
    const cols = await page.locator('.book .strip').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { cw: parseFloat(cs.columnWidth), w: (el as HTMLElement).clientWidth };
    });
    expect(cols.cw).toBeGreaterThan(0);
    expect(cols.cw).toBeLessThan(cols.w / 1.9);
  });

  test('resizing re-paginates but keeps the reading position (spread → single page)', async ({ page }) => {
    await openBook(page);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(450); }
    await settled(page);
    const before = await info(page);
    expect(before.perView).toBe(2);
    expect(before.view).toBeGreaterThan(0);

    await page.setViewportSize({ width: 700, height: 800 });
    await expect.poll(async () => (await info(page)).perView).toBe(1);
    await expect.poll(async () => (await info(page)).views).toBeGreaterThan(before.views); // 쪽이 더 잘게 나뉜다
    // 같은 메시지가 화면에 있다 (위치는 페이지 번호가 아니다)
    const msg = before.msg;
    const visible = await page.locator('.book').evaluate((el, m) => {
      const sr = (el as HTMLElement).getBoundingClientRect();
      return [...document.querySelectorAll(`.book .block[data-msg="${m}"]`)].some((b) =>
        [...b.getClientRects()].some((r) => r.left >= sr.left && r.left < sr.right));
    }, msg);
    expect(visible).toBe(true);
  });

  // e-ink 기기(세로에서도 900px 이상으로 잡히는 경우)를 위해: 펼침을 끄면 넓은 화면에서도 한 쪽씩, 읽던 메시지는 그대로
  test('turning the two-page spread off shows one page per view and keeps the reading position', async ({ page }) => {
    await openBook(page);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(450); }
    await settled(page);
    const before = await info(page);
    expect(before.perView).toBe(2);
    await page.getByRole('button', { name: '보기 설정' }).click();
    await page.getByLabel('두 쪽 펼침(책, 넓은 화면)').uncheck();
    await expect.poll(async () => (await info(page)).perView).toBe(1);
    await expect.poll(async () => (await info(page)).views).toBeGreaterThan(before.views);
    const cols = await page.locator('.book .strip').evaluate((el) => ({ cw: parseFloat(getComputedStyle(el).columnWidth), w: (el as HTMLElement).clientWidth }));
    expect(cols.cw).toBe(cols.w); // 한 열이 view 폭 전체
    const msg = before.msg;
    const visible = await page.locator('.book').evaluate((el, m) => {
      const sr = (el as HTMLElement).getBoundingClientRect();
      return [...document.querySelectorAll(`.book .block[data-msg="${m}"]`)].some((b) =>
        [...b.getClientRects()].some((r) => r.left >= sr.left && r.left < sr.right));
    }, msg);
    expect(visible).toBe(true);
    await expect.poll(async () => ((await (await page.request.get('/api/state/settings')).json()) as { settings: Record<string, unknown> }).settings['reader.spread']).toBe(false);
  });
});

// e-ink 는 부드러운 스크롤 중간 프레임이 잔상으로 남는다 → 끄면 한 번에 넘어간다
test('turning the page-turn animation off jumps straight to the next page', async ({ page, request }) => {
  await request.put('/api/state/settings', { data: { 'reader.turnAnim': false } });
  await openBook(page);
  const stride = await page.locator('.book .snap').evaluateAll((els) => (els[1] as HTMLElement).offsetLeft - (els[0] as HTMLElement).offsetLeft);
  await page.keyboard.press('ArrowRight');
  // 애니메이션이면 이 시점엔 아직 가는 중이다 (Chromium 부드러운 스크롤은 450ms 보다 길다)
  expect(await book(page).evaluate((el) => el.scrollLeft)).toBe(stride);
  await expect.poll(async () => (await info(page)).view).toBe(1);
});

test('keyboard: arrows, PageDown/PageUp and Space turn pages', async ({ page }) => {
  await openBook(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await info(page)).view).toBe(1);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await info(page)).view).toBe(2);
  await page.keyboard.press('PageUp');
  await expect.poll(async () => (await info(page)).view).toBe(1);
  await page.keyboard.press('Shift+Space');
  await expect.poll(async () => (await info(page)).view).toBe(0);
  await page.keyboard.press('ArrowLeft'); // 채팅의 처음에서 더 못 간다
  await expect.poll(async () => (await info(page)).view).toBe(0);
});

test('a re-layout during a page turn does not snap back to the previous page', async ({ page }) => {
  await openBook(page);
  await page.waitForTimeout(500); // 열 때 예약된 재배치가 지나간 뒤
  await page.keyboard.press('ArrowRight');
  // 넘기는 도중 이미지 로드(지연 로딩) 같은 재배치가 끼어든다 — 쪽 넘김이 확정되기 전이다
  await book(page).evaluate((el) => el.querySelector('.block')!.dispatchEvent(new Event('load')));
  await page.waitForTimeout(800);
  expect((await info(page)).view).toBe(1);
});

test('edge clicks turn pages and the middle toggles the UI overlay', async ({ page }) => {
  await openBook(page);
  const box = (await book(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.92, box.y + box.height / 2);
  await expect.poll(async () => (await info(page)).view).toBe(1);
  await page.mouse.click(box.x + box.width * 0.08, box.y + box.height / 2);
  await expect.poll(async () => (await info(page)).view).toBe(0);
  const bar = page.locator('.reader-bar');
  await expect(bar).not.toHaveClass(/ui-hidden/);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(bar).toHaveClass(/ui-hidden/);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(bar).not.toHaveClass(/ui-hidden/);
});

test('pages continue across chapter boundaries in both directions', async ({ page }) => {
  await openBook(page);
  let guard = 0;
  while ((await info(page)).msg < 40 && guard++ < 120) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(450);
  }
  expect((await info(page)).msg).toBeGreaterThanOrEqual(40); // 두 번째 챕터(40~79)로 넘어왔다
  await expect.poll(async () => page.locator('.book article[data-msg="0"]').count()).toBe(0); // 이전 챕터는 DOM 에서 내려갔다
  guard = 0;
  while ((await info(page)).msg >= 40 && guard++ < 120) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(450);
  }
  expect((await info(page)).msg).toBeLessThan(40);
});

test('switching modes keeps the reading position, both ways, and the mode persists across reloads', async ({ page }) => {
  await page.goto(READER);
  await expect(page.locator('article[data-msg="0"]')).toBeVisible();
  for (let i = 0; i < 80; i++) { // 60 번이 DOM 에 생길 때까지 스크롤 모드로 내려간다
    const found = await page.evaluate(() => { const el = document.querySelector('article[data-msg="60"]'); if (el) el.scrollIntoView(); return !!el; });
    if (found) break;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
  }
  await expect.poll(() => savedMsg(page), { timeout: 15_000 }).toBe(60);

  await page.getByRole('button', { name: '책으로 보기' }).click();
  await expect(book(page)).toBeVisible();
  await expect.poll(async () => (await info(page)).msg).toBe(60); // 책 모드가 같은 위치에서 시작
  await expect(page.locator('.book article[data-msg="60"]')).toBeAttached();

  await page.reload(); // 모드와 위치가 유지된다
  await expect(book(page)).toBeVisible();
  await expect.poll(async () => (await info(page)).msg).toBe(60);

  await page.getByRole('button', { name: '스크롤로 보기' }).click();
  await expect(page.getByTestId('scroll')).toBeVisible();
  await expect.poll(async () =>
    page.evaluate(() => {
      const bar = document.querySelector('.reader-bar')!.getBoundingClientRect().bottom;
      const el = document.elementFromPoint(window.innerWidth / 2, bar + 20)?.closest('[data-msg]') as HTMLElement | null;
      return el ? Number(el.dataset.msg) : null;
    }),
  ).toBe(60);
});

test('the book view loads under the strict CSP without violations (benign chat)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective));
  });
  await page.request.put('/api/state/settings', { data: { 'reader.mode': 'book' } });
  await page.goto('/#/read/main/c1/short');
  await expect(book(page)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('one page per view; edge taps turn pages and a centre tap toggles the UI', async ({ page }) => {
    await openBook(page);
    expect((await info(page)).perView).toBe(1);
    const box = (await book(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height / 2);
    await expect.poll(async () => (await info(page)).view).toBe(1);
    await page.touchscreen.tap(box.x + box.width * 0.1, box.y + box.height / 2);
    await expect.poll(async () => (await info(page)).view).toBe(0);
    const bar = page.locator('.reader-bar');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(bar).toHaveClass(/ui-hidden/);
  });
});

/** 현재 view 에 보이는 블록 조각들의 위·아래 끝과 헤더·진행 표시의 경계 */
const pageEdges = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.reader-bar')!.getBoundingClientRect().bottom;
    const prog = document.querySelector('.progress')!.getBoundingClientRect().top;
    const sr = document.querySelector('.book')!.getBoundingClientRect();
    let minTop = Infinity;
    let maxBottom = -Infinity;
    for (const b of document.querySelectorAll('.book .block')) {
      for (const rc of b.getClientRects()) {
        if (rc.height > 0 && rc.left >= sr.left && rc.left < sr.right) {
          minTop = Math.min(minTop, rc.top);
          maxBottom = Math.max(maxBottom, rc.bottom);
        }
      }
    }
    return { bar, prog, minTop, maxBottom };
  });

for (const vp of [{ name: 'desktop spread', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test(`page text clears the header and the progress bar (${vp.name})`, async ({ page }) => {
      await openBook(page);
      await expect.poll(async () => (await pageEdges(page)).minTop).toBeGreaterThanOrEqual((await pageEdges(page)).bar);
      const e = await pageEdges(page);
      expect(e.minTop).toBeGreaterThanOrEqual(e.bar);
      expect(e.maxBottom).toBeLessThanOrEqual(e.prog);
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await info(page)).view).toBe(1);
      const e2 = await pageEdges(page);
      expect(e2.minTop).toBeGreaterThanOrEqual(e2.bar);
      expect(e2.maxBottom).toBeLessThanOrEqual(e2.prog);
    });
  });
}
