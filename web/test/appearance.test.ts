import { describe, expect, it } from 'vitest';
import { familyOf, fontValue } from '../src/lib/appearance.svelte';

describe('font setting values', () => {
  it('quotes uploaded families and reads them back', () => {
    expect(fontValue('나눔 명조')).toBe('"나눔 명조"');
    expect(familyOf('"나눔 명조"')).toBe('나눔 명조');
    expect(familyOf('serif')).toBeNull();
    expect(familyOf('"a", serif')).toBeNull();
  });
});
