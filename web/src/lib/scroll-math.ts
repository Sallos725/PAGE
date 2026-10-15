/** 읽기 줄(reading line) 위에서 끝나지 않는 블록 중 가장 위에 있는 것 = 지금 읽는 블록. */
export function pickReadingBlock<T extends { top: number; bottom: number }>(rects: T[], lineY: number): T | null {
  let best: T | null = null;
  for (const r of rects) {
    if (r.bottom <= lineY) continue;
    if (best === null || r.top < best.top) best = r;
  }
  return best;
}

/** 읽기 줄이 블록 높이의 어디쯤인지 (0..1) → charOffset 추정에 쓴다. */
export function fractionWithin(top: number, bottom: number, lineY: number): number {
  const h = bottom - top;
  if (h <= 0) return 0;
  return Math.min(1, Math.max(0, (lineY - top) / h));
}
