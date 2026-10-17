import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GAP, MARGIN_X, MARGIN_Y, bookLayout, charOffsetAt, fragmentIndexFor, keyAction, pickBlockOnView, swipeAction, tapZone, viewCount, viewOfX,
} from '../src/lib/book-math';

describe('bookLayout', () => {
  it('desktop width gives a two-page spread', () => {
    const l = bookLayout(1280, 720);
    expect(l).toMatchObject({ perView: 2, viewWidth: 1280 - 2 * MARGIN_X, pageHeight: 720 - 2 * MARGIN_Y });
    expect(l.colWidth).toBe((l.viewWidth - GAP) / 2);
    expect(l.stride).toBe(l.viewWidth + GAP);
  });
  it('phone width gives one page', () => {
    const l = bookLayout(390, 844);
    expect(l).toMatchObject({ perView: 1, viewWidth: 342, colWidth: 342, stride: 342 + GAP, pageHeight: 764 });
  });
  it('spread off keeps one page even on a wide screen (e-ink 등 넓은 화면에서 한 쪽씩)', () => {
    const l = bookLayout(1280, 720, undefined, false);
    expect(l).toMatchObject({ perView: 1, viewWidth: 1280 - 2 * MARGIN_X, colWidth: 1280 - 2 * MARGIN_X });
    expect(l.stride).toBe(l.viewWidth + GAP);
  });
  it('top/bottom insets (header, progress bar) shrink the page and move it down', () => {
    const l = bookLayout(1280, 720, { top: 70, bottom: 44 });
    expect(l).toMatchObject({ top: 70, pageHeight: 720 - 70 - 44 });
    expect(bookLayout(1280, 720)).toMatchObject({ top: MARGIN_Y, pageHeight: 720 - 2 * MARGIN_Y });
    expect(bookLayout(1280, 720, { top: 10, bottom: 10 })).toMatchObject({ top: MARGIN_Y, pageHeight: 720 - 2 * MARGIN_Y }); // 최소 여백은 지킨다
  });
  it('switches to a spread exactly at 900px and never goes degenerate', () => {
    expect(bookLayout(899, 800).perView).toBe(1);
    expect(bookLayout(900, 800).perView).toBe(2);
    const tiny = bookLayout(10, 10);
    expect(tiny.viewWidth).toBeGreaterThanOrEqual(200);
    expect(tiny.pageHeight).toBeGreaterThanOrEqual(200);
  });
  it('the snap stride equals the scroll-padding the stylesheet uses for the left margin', () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'app.css'), 'utf8');
    expect(css).toContain(`scroll-padding-left: ${MARGIN_X}px`);
    expect(GAP).toBe(2 * MARGIN_X); // 이웃 쪽 내용이 여백으로 새지 않는 조건
  });
});

describe('viewCount / viewOfX', () => {
  const l = bookLayout(1280, 720); // colWidth 592, 펼침당 2열
  const width = (cols: number) => cols * l.colWidth + (cols - 1) * GAP;
  it('counts spreads from the measured scroll width', () => {
    expect(viewCount(width(1), l)).toBe(1);
    expect(viewCount(width(2), l)).toBe(1);
    expect(viewCount(width(3), l)).toBe(2);
    expect(viewCount(width(5), l)).toBe(3);
    expect(viewCount(0, l)).toBe(1);
  });
  it('single-page layout counts columns', () => {
    const p = bookLayout(390, 844);
    expect(viewCount(4 * p.colWidth + 3 * GAP, p)).toBe(4);
  });
  it('maps a fragment x offset to its view, with 1px tolerance for fractional layout', () => {
    expect(viewOfX(0, l)).toBe(0);
    expect(viewOfX(l.colWidth + GAP, l)).toBe(0); // 펼침의 둘째 열은 같은 view
    expect(viewOfX(l.stride, l)).toBe(1);
    expect(viewOfX(l.stride - 0.4, l)).toBe(1);
    expect(viewOfX(2 * l.stride + 5, l)).toBe(2);
    expect(viewOfX(-3, l)).toBe(0);
  });
});

describe('pickBlockOnView / fragmentIndexFor', () => {
  const r = (left: number, height = 100) => ({ left, top: 0, height });
  const items = [
    { msg: 1, block: 0, rects: [r(-1300, 600), r(-660, 600)] }, // 앞 쪽들에서 끝남
    { msg: 1, block: 1, rects: [r(-20, 100), r(30, 300)] }, // 이 view 로 이어짐: 첫 조각은 view 밖, 둘째 조각이 view 안
    { msg: 2, block: 0, rects: [r(40, 200)] },
  ];
  it('picks the first block (document order) that has a fragment inside the view', () => {
    const hit = pickBlockOnView(items, 0, 1200);
    expect(hit).toMatchObject({ msg: 1, block: 1 });
  });
  it('a continued block reports how far into it the view starts (by fragment height)', () => {
    const hit = pickBlockOnView(items, 0, 1200)!;
    expect(hit.fraction).toBeCloseTo(100 / 400); // 앞 조각 100 / 전체 400
  });
  it('a block that starts on the view has fraction 0; nothing on view → null', () => {
    expect(pickBlockOnView([{ msg: 5, block: 2, rects: [r(10, 50)] }], 0, 100)).toEqual({ msg: 5, block: 2, fraction: 0 });
    expect(pickBlockOnView(items, 5000, 6000)).toBeNull();
    expect(pickBlockOnView([], 0, 100)).toBeNull();
  });
  it('tolerates a 1px sub-pixel overhang at the left edge of the view', () => {
    expect(pickBlockOnView([{ msg: 9, block: 0, rects: [r(-0.5, 10)] }], 0, 100)).toMatchObject({ msg: 9, fraction: 0 });
  });
  it('fragmentIndexFor walks the cumulative fragment heights', () => {
    const rects = [{ height: 100 }, { height: 300 }];
    expect(fragmentIndexFor(rects, 0)).toBe(0);
    expect(fragmentIndexFor(rects, 0.24)).toBe(0);
    expect(fragmentIndexFor(rects, 0.26)).toBe(1);
    expect(fragmentIndexFor(rects, 1)).toBe(1);
    expect(fragmentIndexFor([], 0.5)).toBe(0);
    expect(fragmentIndexFor([{ height: 0 }], 0.5)).toBe(0);
  });
  it('a reported position maps back to the same fragment (view), even when the boundary is not a whole character', () => {
    // 쪽 경계에 걸친 블록: 이 view 는 두 번째 조각에서 시작한다 → 보고한 글자 위치가 다시 두 번째 조각을 가리켜야 한다
    for (const [h0, h1, len] of [[100, 300, 37], [217.5, 82.25, 101], [24, 600, 9], [1, 1, 3]] as const) {
      const rects = [{ height: h0 }, { height: h1 }];
      const fraction = h0 / (h0 + h1);
      const c = charOffsetAt(len, fraction);
      expect(fragmentIndexFor(rects, c / len)).toBe(1);
    }
    expect(charOffsetAt(40, 0)).toBe(0);
    expect(charOffsetAt(0, 0.5)).toBe(0);
    expect(charOffsetAt(10, 0.95)).toBeLessThanOrEqual(10);
  });
});

describe('input interpretation', () => {
  it('tapZone: left 30% prev, right 30% next, middle toggles the UI', () => {
    expect(tapZone(10, 1000)).toBe('prev');
    expect(tapZone(299, 1000)).toBe('prev');
    expect(tapZone(300, 1000)).toBe('toggle');
    expect(tapZone(700, 1000)).toBe('toggle');
    expect(tapZone(701, 1000)).toBe('next');
    expect(tapZone(990, 1000)).toBe('next');
  });
  it('keyAction: arrows, PageUp/Down, Space / Shift+Space', () => {
    expect(keyAction('ArrowRight', false)).toBe('next');
    expect(keyAction('PageDown', false)).toBe('next');
    expect(keyAction(' ', false)).toBe('next');
    expect(keyAction('ArrowLeft', false)).toBe('prev');
    expect(keyAction('PageUp', false)).toBe('prev');
    expect(keyAction(' ', true)).toBe('prev');
    expect(keyAction('a', false)).toBeNull();
    expect(keyAction('ArrowDown', false)).toBeNull();
  });
  it('swipeAction needs a mostly-horizontal drag of at least 50px', () => {
    expect(swipeAction(-80, 5)).toBe('next');
    expect(swipeAction(80, -10)).toBe('prev');
    expect(swipeAction(-40, 0)).toBeNull();
    expect(swipeAction(-80, 70)).toBeNull(); // 대각선은 스크롤/선택 의도
    expect(swipeAction(0, 0)).toBeNull();
  });
});
