import { describe, expect, it } from 'vitest';
import { RULE_LIMITS, checkRule, normalizeFlags } from '../src/state/hide-rules.js';

describe('normalizeFlags', () => {
  it('keeps gimsu in canonical order, drops duplicates, rejects anything else', () => {
    expect(normalizeFlags('')).toBe('');
    expect(normalizeFlags('sig')).toBe('gis');
    expect(normalizeFlags('gg')).toBe('g');
    expect(normalizeFlags('gy')).toBeNull();
    expect(normalizeFlags('d')).toBeNull();
  });
});

describe('checkRule', () => {
  it('accepts a normal pattern and returns normalized flags', () => {
    expect(checkRule('상태창', '<s>[\\s\\S]*?</s>', 'ig')).toEqual({ ok: true, flags: 'gi' });
  });
  it('rejects bad names', () => {
    expect(checkRule('', 'x', '')).toEqual({ ok: false, error: 'name' });
    expect(checkRule('   ', 'x', '')).toEqual({ ok: false, error: 'name' });
    expect(checkRule('a'.repeat(RULE_LIMITS.name + 1), 'x', '')).toEqual({ ok: false, error: 'name' });
    expect(checkRule('a\u0007', 'x', '')).toEqual({ ok: false, error: 'name' });
  });
  it('rejects empty, oversized or control-character patterns', () => {
    expect(checkRule('n', '', '')).toEqual({ ok: false, error: 'pattern' });
    expect(checkRule('n', 'x'.repeat(RULE_LIMITS.pattern + 1), '')).toEqual({ ok: false, error: 'pattern' });
    expect(checkRule('n', 'a\nb', '')).toEqual({ ok: false, error: 'pattern' });
  });
  it('rejects unknown flags, uncompilable patterns and patterns that match the empty string', () => {
    expect(checkRule('n', 'x', 'y')).toEqual({ ok: false, error: 'flags' });
    expect(checkRule('n', '(', '')).toEqual({ ok: false, error: 'compile' });
    expect(checkRule('n', 'a*', '')).toEqual({ ok: false, error: 'empty-match' });
    expect(checkRule('n', '^', 'm')).toEqual({ ok: false, error: 'empty-match' });
  });
});
