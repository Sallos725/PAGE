import { describe, expect, it } from 'vitest';
import { chapterXhtml, esc, filterImages, messageXhtml } from '../src/export/epub/render.js';
import type { Block } from '../src/shared/blocks.js';

const AM = 'Alice.__am__.chat.00000001-2222-3333-4444-555555555555';

describe('XHTML render', () => {
  it('escapes markup characters and removes characters XML cannot carry', () => {
    expect(esc(`<b a="1">'&'</b>`)).toBe('&lt;b a=&quot;1&quot;&gt;&apos;&amp;&apos;&lt;/b&gt;');
    expect(esc('a\u0000b\u0008c\u000bd\ufffee\uffff')).toBe('abcde');
    expect(esc('짝 없는 \ud800 서로게이트 😀')).toBe('짝 없는  서로게이트 😀');
    expect(esc('줄\n탭\t')).toBe('줄\n탭\t');
  });

  it('removes lone surrogates in every position but keeps valid pairs', () => {
    expect(esc('\udc00')).toBe('');
    expect(esc('x\udc00y')).toBe('xy');
    expect(esc('\ud800𐀀')).toBe('𐀀');
    expect(esc('😀\udc00')).toBe('😀');
    expect(esc('\ud83d')).toBe('');
  });

  it('renders each block kind inside a message div by role; images use the resolved href or vanish', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', text: '문단 <script>' }, { kind: 'dialogue', text: '"대사"' }, { kind: 'divider' },
      { kind: 'image', assetName: '웃음' }, { kind: 'image', assetName: '없음' },
    ];
    const href = (n: string) => (n === '웃음' ? 'images/abc.png' : null);
    expect(messageXhtml({ role: 'char', blocks }, href)).toBe(
      '<div class="msg char"><p>문단 &lt;script&gt;</p><p class="dialogue">&quot;대사&quot;</p><hr/><figure><img src="images/abc.png" alt=""/></figure></div>',
    );
    expect(messageXhtml({ role: 'user', blocks: [{ kind: 'paragraph', text: '나' }] }, href)).toBe('<div class="msg user"><p>나</p></div>');
    expect(messageXhtml({ role: 'user', blocks: [] }, href)).toBe('');
  });

  it('chapter document is XHTML with title and stylesheet', () => {
    const x = chapterXhtml('1장', '<p>a</p>');
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(x).toContain('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko">');
    expect(x).toContain('<title>1장</title>');
    expect(x).toContain('<link rel="stylesheet" type="text/css" href="style.css"/>');
    expect(x).toContain('<section epub:type="chapter"><h2>1장</h2><p>a</p></section>');
  });

  it('filters images by kind: Asset Maid names are chat images, everything else is a card image', () => {
    const blocks: Block[] = [{ kind: 'image', assetName: AM }, { kind: 'image', assetName: '웃음' }, { kind: 'paragraph', text: 'p' }];
    expect(filterImages(blocks, { cardImages: true, chatImages: true })).toEqual(blocks);
    expect(filterImages(blocks, { cardImages: false, chatImages: true })).toEqual([blocks[0], blocks[2]]);
    expect(filterImages(blocks, { cardImages: true, chatImages: false })).toEqual([blocks[1], blocks[2]]);
    expect(filterImages(blocks, { cardImages: false, chatImages: false })).toEqual([blocks[2]]);
  });
});
