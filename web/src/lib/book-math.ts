// 책 넘김 모드의 순수 계산. DOM 을 모르므로 Vitest 로 검증한다. (화면 조립은 BookView.svelte)

export const MARGIN_X = 24; // 좌우 여백 — app.css 의 `scroll-padding-left` 와 같아야 한다 (테스트가 강제)
export const MARGIN_Y = 40; // 상하 최소 여백 (헤더·진행 표시가 더 크면 그만큼 비운다)
export const GAP = 2 * MARGIN_X; // 쪽 사이(= 열 사이) 간격. view 간 간격과 같아서 이웃 쪽 내용이 여백으로 새지 않는다
export const SPREAD_MIN = 900; // 컨테이너 폭이 이 이상이면 2쪽 펼침

export type BookLayout = {
  perView: 1 | 2;
  colWidth: number; // 열(=쪽) 한 장의 폭
  viewWidth: number; // 한 view(펼침)의 폭
  stride: number; // view 하나를 넘길 때 scrollLeft 가 변하는 양
  pageHeight: number;
  top: number; // strip 의 위쪽 위치 (= 위 여백)
};

/** 쪽 위·아래에 비울 높이. 헤더(안전영역 포함)와 진행 표시가 본문을 가리지 않게 한다. */
export type Insets = { top: number; bottom: number };

/** spread=false 면 넓은 화면에서도 한 쪽씩 (설정 `reader.spread`). */
export function bookLayout(containerW: number, containerH: number, insets: Insets = { top: MARGIN_Y, bottom: MARGIN_Y }, spread = true): BookLayout {
  const top = Math.max(MARGIN_Y, Math.ceil(insets.top));
  const bottom = Math.max(MARGIN_Y, Math.ceil(insets.bottom));
  const viewWidth = Math.max(200, Math.floor(containerW - 2 * MARGIN_X));
  const perView: 1 | 2 = spread && containerW >= SPREAD_MIN ? 2 : 1;
  return {
    perView,
    colWidth: Math.floor((viewWidth - (perView - 1) * GAP) / perView),
    viewWidth,
    stride: viewWidth + GAP,
    pageHeight: Math.max(200, Math.floor(containerH - top - bottom)),
    top,
  };
}

/** 측정한 strip.scrollWidth 로 열 수를 구하고 펼침당 열 수로 view 수를 낸다. */
export function viewCount(scrollWidth: number, l: BookLayout): number {
  const cols = Math.max(1, Math.round((scrollWidth + GAP) / (l.colWidth + GAP)));
  return Math.max(1, Math.ceil(cols / l.perView));
}

/** strip 왼쪽 기준 x(조각의 왼쪽)가 속한 view. 1px 는 소수점 레이아웃 오차 허용. */
export const viewOfX = (x: number, l: BookLayout): number => Math.max(0, Math.floor((x + 1) / l.stride));

export type FragRect = { left: number; top: number; height: number };
export type BlockRects = { msg: number; block: number; rects: FragRect[] };

/**
 * 현재 view 에 조각이 하나라도 걸린 *문서 순서상 첫* 블록과, 그 블록이 이 view 에서 얼마나 진행된 곳인지(0..1, 조각 높이 기준).
 * viewLeft/viewRight 는 조각 rect 와 같은 좌표계(뷰포트).
 */
export function pickBlockOnView(items: BlockRects[], viewLeft: number, viewRight: number): { msg: number; block: number; fraction: number } | null {
  for (const it of items) {
    if (!it.rects.some((r) => r.left >= viewLeft - 1 && r.left < viewRight)) continue;
    const total = it.rects.reduce((a, r) => a + r.height, 0);
    const before = it.rects.filter((r) => r.left < viewLeft - 1).reduce((a, r) => a + r.height, 0);
    return { msg: it.msg, block: it.block, fraction: total > 0 ? before / total : 0 };
  }
  return null;
}

/**
 * view 가 블록의 진행도 fraction 지점에서 시작할 때, 그 view 의 첫 글자 위치. 올림이어야 한다:
 * 내림하면 경계 바로 앞(이전 쪽)의 글자가 되어, fragmentIndexFor 로 되돌릴 때 이전 쪽으로 간다.
 */
export const charOffsetAt = (len: number, fraction: number): number => Math.min(len, Math.ceil(len * fraction));

/** 블록 안의 진행도(0..1)가 몇 번째 조각에 해당하는지 (조각 높이 누적). */
export function fragmentIndexFor(rects: { height: number }[], fraction: number): number {
  const total = rects.reduce((a, r) => a + r.height, 0);
  if (rects.length === 0 || total <= 0) return 0;
  const target = fraction * total;
  let acc = 0;
  for (let i = 0; i < rects.length; i++) {
    acc += rects[i]!.height;
    if (target < acc) return i;
  }
  return rects.length - 1;
}

export type PageAction = 'prev' | 'next';

/** 좌 30% = 이전, 우 30% = 다음, 가운데 = UI 토글 (스펙 4.4). x 는 컨테이너 왼쪽 기준. */
export function tapZone(x: number, width: number, edge = 0.3): PageAction | 'toggle' {
  const f = width > 0 ? x / width : 0.5;
  if (f < edge) return 'prev';
  if (f > 1 - edge) return 'next';
  return 'toggle';
}

export function keyAction(key: string, shift: boolean): PageAction | null {
  if (key === 'ArrowRight' || key === 'PageDown') return 'next';
  if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
  if (key === ' ') return shift ? 'prev' : 'next';
  return null;
}

/** 가로로 50px 이상, 세로의 1.5배 이상 끌었을 때만 쪽 넘김 의도로 본다. */
export function swipeAction(dx: number, dy: number, threshold = 50): PageAction | null {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'prev';
}
