import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { anchorOf } from '../src/lib/position';

export const LONG = 'source=main&char=c1&chat=long';
/** serve.mjs 의 합성 텍스트 규칙: 메시지 i 의 첫 문단 */
export const BLOCK0 = (i: number) => `[m${i}-p0] ${'첫 문단 '.repeat(8)}${i}`;

export const DEFAULT_SETTINGS = {
  'reader.mode': 'scroll', 'reader.bubble': false, 'reader.font': 'serif', 'reader.fontSize': 18, 'reader.lineHeight': 1.85,
  'reader.paraSpacing': 0.9, 'reader.width': 38, 'reader.justify': false, 'reader.indent': false, 'reader.theme': 'system',
  'reader.hideUser': false,
  'library.shelfView': 'shelf',
};

export async function resetState(request: APIRequestContext) {
  const pos = await request.put(`/api/state/position?${LONG}`, { data: { msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: anchorOf(BLOCK0(0), 0) } });
  expect(pos.ok()).toBe(true);
  expect((await request.put('/api/state/settings', { data: DEFAULT_SETTINGS })).ok()).toBe(true);
  const list = (await (await request.get(`/api/state/bookmarks?${LONG}`)).json()) as { bookmarks: { id: string }[] };
  for (const b of list.bookmarks) await request.delete(`/api/state/bookmarks/${b.id}?${LONG}`);
  const shortList = (await (await request.get('/api/state/bookmarks?source=main&char=c1&chat=short')).json()) as { bookmarks: { id: string }[] };
  for (const b of shortList.bookmarks) await request.delete(`/api/state/bookmarks/${b.id}?source=main&char=c1&chat=short`);
  for (const q of ['source=main&char=c1', 'source=main&char=c1&chat=long', 'source=main&char=c1&chat=status']) {
    expect((await request.put(`/api/state/alias?${q}`, { data: { name: '' } })).ok()).toBe(true);
  }
  const rules = (await (await request.get('/api/state/hide-rules?source=main&char=c1')).json()) as { rules: { id: string }[] };
  for (const r of rules.rules) await request.delete(`/api/state/hide-rules/${r.id}?source=main`);
  const imgRules = (await (await request.get('/api/state/image-rules?source=main&char=c1')).json()) as { rules: { key: string }[] };
  for (const r of imgRules.rules) await request.put(`/api/state/image-rules/${r.key}?source=main&char=c1`, { data: { enabled: true } });
  for (const [ch, c] of [['c1', 'long'], ['c1', 'short'], ['c1', 'status'], ['c1', 'gone'], ['c1', 'face'], ['c3', 'c3a']]) {
    expect((await request.put(`/api/state/kept?source=main&char=${ch}&chat=${c}`, { data: { kept: false } })).ok()).toBe(true);
  }
  const themes = (await (await request.get('/api/themes')).json()) as { themes: { id: string }[] };
  for (const t of themes.themes) expect((await request.delete(`/api/themes/${t.id}`)).ok()).toBe(true);
  const fonts = (await (await request.get('/api/fonts')).json()) as { fonts: { id: string }[] };
  for (const f of fonts.fonts) expect((await request.delete(`/api/fonts/${f.id}`)).ok()).toBe(true);
}

/** 읽기 줄(sticky 헤더 아래 20px)에 걸린 메시지. 그 위를 덮은 패널(폰에선 보기 설정이 화면 전체 폭)은 뚫고 본다. */
export const readingMsg = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.reader-bar')!.getBoundingClientRect().bottom;
    for (const hit of document.elementsFromPoint(window.innerWidth / 2, bar + 20)) {
      const el = hit.closest<HTMLElement>('[data-msg]');
      if (el) return Number(el.dataset.msg);
    }
    return null;
  });

/** 아래로 스크롤하며 챕터를 로드시키다가, 해당 메시지가 DOM 에 생기면 화면 위로 가져온다. */
export async function scrollToMsg(page: Page, n: number) {
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

export const savedMsg = async (page: Page) => {
  const r = await page.request.get(`/api/state/position?${LONG}`);
  return ((await r.json()) as { position: { msgIdx: number } | null }).position?.msgIdx ?? null;
};

export const bookInfo = (page: Page) =>
  page.getByTestId('book').evaluate((el) => {
    const d = (el as HTMLElement).dataset;
    return { view: Number(d.view), views: Number(d.views), perView: Number(d.perView), msg: Number(d.msg) };
  });

/** 책 모드에서 메시지 m 의 블록 조각이 현재 화면(view)에 보이는가 */
export const msgOnBookView = (page: Page, m: number) =>
  page.locator('.book').evaluate((el, msg) => {
    const sr = (el as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll(`.book .block[data-msg="${msg}"]`)].some((b) =>
      [...b.getClientRects()].some((r) => r.left >= sr.left && r.left < sr.right));
  }, m);
