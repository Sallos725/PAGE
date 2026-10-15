import { describe, expect, it } from 'vitest';
import { applyImageRules } from '../src/lib/image-rules';
import type { ImageRule } from '../src/lib/types';

const rule = (o: Partial<ImageRule> = {}): ImageRule => ({ key: 'k', name: 'n', pattern: '<f=(\\w+)>', flags: 'g', images: ['$1'], enabled: true, slow: false, ...o });

describe('applyImageRules (same template rules as the server)', () => {
  it('replaces each match with image markers on their own lines; the rest of the text stays', () => {
    expect(applyImageRules('앞 <f=smile> 뒤', [rule()])).toBe('앞 \n{{raw::smile}}\n 뒤');
    expect(applyImageRules('<n=al>', [rule({ pattern: '<n=(?<who>\\w+)>', images: ['$<who>_face', 'x'] })])).toBe('\n{{raw::al_face}}\n{{raw::x}}\n');
    expect(applyImageRules('<x>', [rule({ pattern: '<x>', images: ['p$&q', 'a$$b'] })])).toBe('\n{{raw::p<x>q}}\n{{raw::a$b}}\n');
  });
  it('skips disabled, slow, broken and empty-matching rules; keeps a match whose names are all invalid', () => {
    expect(applyImageRules('<f=a>', [rule({ enabled: false })])).toBe('<f=a>');
    expect(applyImageRules('<f=a>', [rule({ slow: true })])).toBe('<f=a>');
    expect(applyImageRules('<f=a>', [rule({ pattern: '(' }), rule({ pattern: 'x*' })])).toBe('<f=a>');
    expect(applyImageRules('<f=a>', [rule({ images: ['{$1}'] })])).toBe('<f=a>');
  });
  it('skips oversized messages and is a no-op without rules', () => {
    const big = `<f=a>${'x'.repeat(200_000)}`;
    expect(applyImageRules(big, [rule()])).toBe(big);
    expect(applyImageRules('<f=a>', [])).toBe('<f=a>');
  });
});
