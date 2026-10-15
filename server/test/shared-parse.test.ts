import { describe, expect, it } from 'vitest';
import { parseHtml } from '../src/export/epub/html.js';
import { parseBlocks } from '../src/shared/parse.js';
import { PARSE_CASES } from './fixtures/parse-cases.js';

describe('server parser (linkedom) matches the web parser table', () => {
  for (const c of PARSE_CASES) it(c.name, () => { expect(parseBlocks(c.input, parseHtml)).toEqual(c.expected); });
});

describe('server-only HTML edge cases', () => {
  it('literal </body> or </html> in a message does not cut the rest (browsers ignore them in body)', () => {
    expect(parseBlocks('앞 </body> 뒤', parseHtml)).toEqual([{ kind: 'paragraph', text: '앞  뒤' }]);
    expect(parseBlocks('앞 </html> <p>끝</p>', parseHtml)).toEqual([{ kind: 'paragraph', text: '앞' }, { kind: 'paragraph', text: '끝' }]);
  });
  it('end tags with attributes do not cut the rest either', () => {
    expect(parseBlocks('앞 </html foo="1">뒤', parseHtml)).toEqual([{ kind: 'paragraph', text: '앞 뒤' }]);
    expect(parseBlocks('앞 </body x>뒤', parseHtml)).toEqual([{ kind: 'paragraph', text: '앞 뒤' }]);
  });
  it('10000 nested tags do not overflow the stack and keep the text', () => {
    expect(parseBlocks('<div>'.repeat(10000) + '끝', parseHtml)).toEqual([{ kind: 'paragraph', text: '끝' }]);
    expect(parseBlocks('<b>'.repeat(10000) + '깊은 글', parseHtml)).toEqual([{ kind: 'paragraph', text: '깊은 글' }]);
  });
  it('script text never becomes a block', () => {
    expect(parseBlocks('<script>bad()</script>ok', parseHtml)).toEqual([{ kind: 'paragraph', text: 'ok' }]);
  });
  it('a proper head section is dropped but body text after it stays', () => {
    expect(parseBlocks('<head><title>t</title><style>x</style></head>body text', parseHtml)).toEqual([{ kind: 'paragraph', text: 'body text' }]);
  });
  it('past the depth limit, skipped and hidden elements stay out of the text', () => {
    const input = '<div>'.repeat(600) + '<script>SECRET</script><span hidden>HID</span>deep<br>next';
    const text = parseBlocks(input, parseHtml).map((b) => (b.kind === 'paragraph' ? b.text : '')).join('|');
    expect(text).toContain('deep');
    expect(text).toContain('next');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('HID');
  });
  it('a literal <head>/<frameset> start tag in body text is ignored like a browser (happy-dom disagrees, so server-only)', () => {
    expect(parseBlocks('a <head> b <p>c</p>', parseHtml)).toEqual([{ kind: 'paragraph', text: 'a  b' }, { kind: 'paragraph', text: 'c' }]);
    expect(parseBlocks('a <frameset> b <p>c</p>', parseHtml)).toEqual([{ kind: 'paragraph', text: 'a  b' }, { kind: 'paragraph', text: 'c' }]);
  });
});
