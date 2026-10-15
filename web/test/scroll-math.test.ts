import { describe, expect, it } from 'vitest';
import { fractionWithin, pickReadingBlock } from '../src/lib/scroll-math';

describe('pickReadingBlock', () => {
  const r = (id: string, top: number, bottom: number) => ({ id, top, bottom });
  it('picks the first block (smallest top) that still reaches below the reading line', () => {
    const rects = [r('c', 300, 400), r('a', -80, 10), r('b', 10, 120)];
    expect(pickReadingBlock(rects, 24)?.id).toBe('b'); // a 는 줄 위에서 끝남
  });
  it('a block that straddles the line wins over later ones', () => {
    expect(pickReadingBlock([r('a', -20, 200), r('b', 210, 300)], 24)?.id).toBe('a');
  });
  it('returns null when nothing qualifies', () => {
    expect(pickReadingBlock([], 24)).toBeNull();
    expect(pickReadingBlock([r('a', -50, 0)], 24)).toBeNull();
  });
});

describe('fractionWithin', () => {
  it('is how far the reading line is inside the block, clamped to [0,1]', () => {
    expect(fractionWithin(0, 100, 25)).toBeCloseTo(0.25);
    expect(fractionWithin(50, 150, 24)).toBe(0);
    expect(fractionWithin(-100, 0, 24)).toBe(1);
    expect(fractionWithin(10, 10, 24)).toBe(0); // 높이 0
  });
});
