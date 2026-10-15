import { describe, expect, it } from 'vitest';
import { RULE_LIMITS, applyHideRules, checkRule, compileRules, countMatches, normalizeFlags } from '../src/lib/hide-rules';
import type { HideRule } from '../src/lib/types';

const rule = (pattern: string, o: Partial<HideRule> = {}): HideRule => ({
  id: pattern, scope: 'char', charId: 'c1', name: 'n', pattern, flags: '', enabled: true, origin: 'manual', createdAt: 0, updatedAt: 0, ...o,
});

describe('checkRule (same rules as the server)', () => {
  it('normalizes flags and rejects bad input', () => {
    expect(normalizeFlags('sig')).toBe('gis');
    expect(normalizeFlags('y')).toBeNull();
    expect(checkRule('상태창', '<s>[\\s\\S]*?</s>', 'ig')).toEqual({ ok: true, flags: 'gi' });
    expect(checkRule(' ', 'x', '')).toEqual({ ok: false, error: 'name' });
    expect(checkRule('n', 'x'.repeat(RULE_LIMITS.pattern + 1), '')).toEqual({ ok: false, error: 'pattern' });
    expect(checkRule('n', 'x', 'q')).toEqual({ ok: false, error: 'flags' });
    expect(checkRule('n', '(', '')).toEqual({ ok: false, error: 'compile' });
    expect(checkRule('n', 'a*', '')).toEqual({ ok: false, error: 'empty-match' });
  });
});

describe('applyHideRules', () => {
  it('removes every match of every enabled rule, in order', () => {
    const res = compileRules([rule('<s>[\\s\\S]*?</s>'), rule('\\(OOC[^)]*\\)', { flags: 'i' }), rule('본문', { enabled: false })]);
    expect(applyHideRules('앞 <s>HP 1\n</s> 본문 (ooc: 메모) 뒤 <s>x</s>', res)).toBe('앞  본문  뒤 ');
  });
  it('is a no-op without rules, and skips oversized messages', () => {
    expect(applyHideRules('그대로', [])).toBe('그대로');
    const big = `<s>x</s>${'가'.repeat(RULE_LIMITS.perMessage)}`;
    expect(applyHideRules(big, compileRules([rule('<s>x</s>')]))).toBe(big);
  });
  it('skips invalid stored rules instead of throwing', () => {
    expect(compileRules([rule('('), rule('a*'), rule('x')])).toHaveLength(1);
  });
  it('reuses global regexes safely (lastIndex is reset)', () => {
    const res = compileRules([rule('x')]);
    expect(applyHideRules('axbx', res)).toBe('ab');
    expect(applyHideRules('xx', res)).toBe('');
  });
});

describe('countMatches', () => {
  it('counts non-empty matches across texts', () => {
    expect(countMatches(['<s>1</s> <s>2</s>', '없음', '<s>3</s>'], '<s>\\d</s>', '')).toBe(3);
  });
});
