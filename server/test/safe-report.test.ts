import { describe, expect, it } from 'vitest';
import { assertSafe, foldCounts } from '../src/tools/safe-report.js';

describe('safe-report', () => {
  it('passes numbers, booleans, null and short ascii tokens', () => {
    for (const v of [0, 1.5, true, null, 'ok', 'risuai.db not found']) expect(() => assertSafe('k', v)).not.toThrow();
  });
  it('refuses non-ascii, long strings, objects and never echoes the value', () => {
    for (const v of ['한글', 'x'.repeat(49), {}, [], undefined, NaN]) expect(() => assertSafe('k', v)).toThrow(/unsafe output refused/);
    try { assertSafe('k', '한글내용'); } catch (e) { expect((e as Error).message).not.toContain('한글내용'); }
  });
  it('data-derived labels need an allowlist; everything else folds into other', () => {
    const m = new Map([['png', 5], ['some_name', 2], ['another', 1]]);
    expect([...foldCounts(m, new Set(['png']))].sort()).toEqual([['other', 3], ['png', 5]]);
  });
});
