import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, knownThemes, safeMode, setKnownThemes } from '../src/lib/theme-link';

const ID = 'b'.repeat(32);
const link = () => document.getElementById('page-theme') as HTMLLinkElement | null;

beforeEach(() => {
  history.replaceState(null, '', '/');
  delete document.documentElement.dataset.theme;
  link()?.remove();
  setKnownThemes([]);
});
afterEach(() => history.replaceState(null, '', '/'));

describe('theme-link', () => {
  it('builtin themes set data-theme and never leave a preset link', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(link()).toBeNull();
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('a known custom theme sets its base and links the versioned css at the end of head', () => {
    setKnownThemes([{ id: ID, name: 'x', base: 'sepia', updatedAt: 42 }]);
    applyTheme(`custom:${ID}`);
    expect(document.documentElement.dataset.theme).toBe('sepia');
    expect(link()?.getAttribute('href')).toBe(`/api/themes/${ID}/theme.css?v=42`);
    expect(document.head.lastElementChild).toBe(link());
    applyTheme('light');
    expect(link()).toBeNull();
  });

  it('an unknown custom theme falls back to the device theme without a link', () => {
    applyTheme(`custom:${ID}`);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(link()).toBeNull();
  });

  it('safe mode (?theme=off) keeps the base but skips the css', () => {
    setKnownThemes([{ id: ID, name: 'x', base: 'dark', updatedAt: 1 }]);
    history.replaceState(null, '', '/?theme=off#/');
    expect(safeMode()).toBe(true);
    applyTheme(`custom:${ID}`);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(link()).toBeNull();
  });

  it('remembers theme meta in localStorage for the first paint', () => {
    setKnownThemes([{ id: ID, name: 'x', base: 'dark', updatedAt: 7 }]);
    expect(JSON.parse(localStorage.getItem('page.theme.known')!)).toEqual({ [ID]: { base: 'dark', v: 7 } });
    expect(knownThemes()).toEqual({ [ID]: { base: 'dark', v: 7 } });
  });

  it('re-applying the same theme keeps the same link element and href', () => {
    setKnownThemes([{ id: ID, name: 'x', base: 'dark', updatedAt: 3 }]);
    applyTheme(`custom:${ID}`);
    const first = link();
    applyTheme(`custom:${ID}`);
    expect(link()).toBe(first);
    expect(first?.getAttribute('href')).toBe(`/api/themes/${ID}/theme.css?v=3`);
  });

  it('ignores malformed entries in the localStorage cache', async () => {
    localStorage.setItem('page.theme.known', JSON.stringify({
      [ID]: { base: 'dark', v: 5 },
      'not-an-id': { base: 'dark', v: 1 },
      [`c`.repeat(32)]: { base: 'neon', v: 1 },
      [`d`.repeat(32)]: { base: 'dark', v: 'x' },
      [`e`.repeat(32)]: null,
    }));
    vi.resetModules();
    const fresh = await import('../src/lib/theme-link');
    expect(fresh.knownThemes()).toEqual({ [ID]: { base: 'dark', v: 5 } });
    localStorage.setItem('page.theme.known', '[1,2]');
    vi.resetModules();
    expect((await import('../src/lib/theme-link')).knownThemes()).toEqual({});
  });
});
