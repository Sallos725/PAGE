import { describe, expect, it } from 'vitest';
import { hrefs, parseHash } from '../src/lib/route';

describe('hash routes', () => {
  it('parses every route, decoding ids', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/s/main')).toEqual({ name: 'chars', source: 'main' });
    expect(parseHash('#/s/main/c/c%201')).toEqual({ name: 'chats', source: 'main', char: 'c 1' });
    expect(parseHash('#/read/main/c1/a%2Fb')).toEqual({ name: 'read', source: 'main', char: 'c1', chat: 'a/b' });
    expect(parseHash('#/nope')).toEqual({ name: 'notfound' });
    expect(parseHash('#/read/main/c1')).toEqual({ name: 'notfound' });
  });

  it('parses the highlights page', () => {
    expect(parseHash('#/highlights')).toEqual({ name: 'highlights' });
    expect(hrefs.highlights).toBe('#/highlights');
  });

  it('hrefs round-trip through parseHash', () => {
    expect(parseHash(hrefs.chars('main'))).toEqual({ name: 'chars', source: 'main' });
    expect(parseHash(hrefs.chats('main', 'c 1'))).toEqual({ name: 'chats', source: 'main', char: 'c 1' });
    expect(parseHash(hrefs.read('main', 'c1', 'a/b?#'))).toEqual({ name: 'read', source: 'main', char: 'c1', chat: 'a/b?#' });
  });

  it('malformed percent-escapes do not throw', () => {
    expect(parseHash('#/s/%E0%A4%A')).toEqual({ name: 'notfound' });
  });

  it('parses the appearance page', () => {
    expect(parseHash('#/appearance')).toEqual({ name: 'appearance' });
    expect(hrefs.appearance).toBe('#/appearance');
    expect(parseHash('#/appearance/x')).toEqual({ name: 'notfound' });
  });

  it('parses the import page', () => {
    expect(parseHash('#/import')).toEqual({ name: 'import' });
    expect(hrefs.import).toBe('#/import');
    expect(parseHash('#/import/x')).toEqual({ name: 'notfound' });
  });

  it('parses the source page', () => {
    expect(parseHash('#/source')).toEqual({ name: 'source' });
    expect(hrefs.source).toBe('#/source');
    expect(parseHash('#/source/x')).toEqual({ name: 'notfound' });
  });
});
