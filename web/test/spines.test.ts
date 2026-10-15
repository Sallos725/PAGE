import { describe, expect, it } from 'vitest';
import { SPINE_COLORS, spineColor, spineHeight, spineRange, spineState, spineWidth } from '../src/lib/spines';

describe('spine rules (spec 6.3)', () => {
  const range = { min: 30, max: 2000 };
  it('height is relative per character: shortest 70%, longest 100% of 124px, log scale between', () => {
    expect(spineHeight(30, range)).toBe(87);
    expect(spineHeight(80, range)).toBe(95);
    expect(spineHeight(200, range)).toBe(103);
    expect(spineHeight(500, range)).toBe(112);
    expect(spineHeight(2000, range)).toBe(124);
  });
  it('scaled for the mobile home, never below 54px', () => {
    expect(spineHeight(30, range, 0.75)).toBe(65);
    expect(spineHeight(2000, range, 0.75)).toBe(93);
    expect(spineHeight(0, range, 0.75)).toBe(54);
  });
  it('empty chats sit at the floor; one chat or equal lengths are all 100%', () => {
    expect(spineHeight(0, range)).toBe(54);
    expect(spineHeight(null, range)).toBe(54);
    expect(spineHeight(5, null)).toBe(124);
    expect(spineHeight(40, { min: 40, max: 40 })).toBe(124);
  });
  it('range covers only chats with messages', () => {
    expect(spineRange([{ msgCount: 0 }, { msgCount: null }, { msgCount: 12 }, { msgCount: 300 }])).toEqual({ min: 12, max: 300 });
    expect(spineRange([{ msgCount: 0 }, { msgCount: null }])).toBeNull();
    expect(spineRange([])).toBeNull();
  });
  it('width follows title length, 22–34', () => {
    expect(spineWidth('')).toBe(22);
    expect(spineWidth('가'.repeat(4))).toBe(22);
    expect(spineWidth('가'.repeat(9))).toBe(28);
    expect(spineWidth('가'.repeat(30))).toBe(34);
  });
  it('color is stable per chat id and inside the palette', () => {
    expect(spineColor('a1')).toBe(spineColor('a1'));
    for (const id of ['a', 'b', 'long', 'x/y', '']) expect(spineColor(id)).toBeGreaterThanOrEqual(0);
    for (const id of ['a', 'b', 'long', 'x/y', '']) expect(spineColor(id)).toBeLessThan(SPINE_COLORS);
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(spineColor)).size).toBeGreaterThan(2);
  });
  it('state: reading below 98%, empty when no messages or unreadable', () => {
    expect(spineState({ msgCount: 10, progress: 0.5, lastError: null })).toBe('reading');
    expect(spineState({ msgCount: 10, progress: 0.99, lastError: null })).toBe('normal');
    expect(spineState({ msgCount: 10, progress: null, lastError: null })).toBe('normal');
    expect(spineState({ msgCount: 0, progress: null, lastError: null })).toBe('empty');
    expect(spineState({ msgCount: null, progress: null, lastError: 'x' })).toBe('empty');
  });
});
