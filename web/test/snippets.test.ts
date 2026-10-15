import { describe, expect, it } from 'vitest';
import type { Block } from '../src/lib/blocks';
import { BOOKMARK_SNIPPET, HIGHLIGHT_SNIPPET, cap, groupHighlights, snippetFor, textAt, textBetween, tidy } from '../src/lib/snippets';
import { anchorOf } from '../src/lib/position';
import type { LibraryHighlight } from '../src/lib/types';

const para = (text: string): Block => ({ kind: 'paragraph', text });
const img = (assetName = 'a.png'): Block => ({ kind: 'image', assetName });
const msg = (idx: number, ...texts: string[]) => ({ idx, blocks: texts.map(para) });
const msgB = (idx: number, ...blocks: Block[]) => ({ idx, blocks });
const pt = (msgIdx: number, blockIdx: number, charOffset: number) => ({ msgIdx, blockIdx, charOffset });

describe('snippets', () => {
  it('tidy collapses whitespace; cap counts code points and adds an ellipsis', () => {
    expect(tidy('  a \n\t b  ')).toBe('a b');
    expect(cap('가나다라', 2)).toBe('가…');
    expect(cap('가나', 2)).toBe('가나');
    expect(cap('😀😀😀', 2)).toBe('😀…');
  });

  it('textBetween within a block, across blocks and across messages', () => {
    const ms = [msg(0, '첫 문단 글자', '둘째 문단'), msg(1, '셋째 메시지')];
    expect(textBetween(pt(0, 0, 2), pt(0, 0, 4), ms)).toBe('문단');
    expect(textBetween(pt(0, 0, 5), pt(0, 1, 2), ms)).toBe('글자 둘째');
    expect(textBetween(pt(0, 1, 3), pt(1, 0, 2), ms)).toBe('문단 셋째');
  });

  it('textBetween skips a missing middle message but needs both ends', () => {
    const ms = [msg(0, '앞'), msg(2, '뒤')];
    expect(textBetween(pt(0, 0, 0), pt(2, 0, 1), ms)).toBe('앞 뒤');
    expect(textBetween(pt(0, 0, 0), pt(3, 0, 1), ms)).toBeNull();
    expect(textBetween(pt(0, 5, 0), pt(0, 5, 1), ms)).toBeNull();
  });

  it('textBetween caps at the highlight limit', () => {
    const exact = '가'.repeat(HIGHLIGHT_SNIPPET);
    expect(textBetween(pt(0, 0, 0), pt(0, 0, exact.length), [msg(0, exact)])).toBe(exact);
    const over = '가'.repeat(HIGHLIGHT_SNIPPET + 1);
    const got = textBetween(pt(0, 0, 0), pt(0, 0, over.length), [msg(0, over)])!;
    expect(Array.from(got)).toHaveLength(HIGHLIGHT_SNIPPET);
    expect(got.endsWith('…')).toBe(true);
  });

  it('textBetween leaves out image blocks and returns null for an out-of-range start block', () => {
    const ms = [msgB(0, para('앞 글자'), img('secret.png'), para('뒤 글자'))];
    const got = textBetween(pt(0, 0, 0), pt(0, 2, 5), ms)!;
    expect(got).toBe('앞 글자 뒤 글자');
    expect(got).not.toContain('image:');
    expect(textBetween(pt(0, 1, 0), pt(0, 2, 3), ms)).toBe('뒤 글');
    expect(textBetween(pt(0, 7, 0), pt(1, 0, 1), [ms[0]!, msg(1, '다음')])).toBeNull();
  });

  it('textBetween drops a lone surrogate left at the cut', () => {
    expect(textBetween(pt(0, 0, 1), pt(0, 0, 3), [msg(0, '😀가나')])).toBe('가');
  });

  it('textAt takes ~60 chars from the position, continuing into the next blocks', () => {
    const ms = [msg(0, '짧은 첫 문단', '그다음 문단이 이어진다')];
    expect(textAt(pt(0, 0, 3), ms)).toBe('첫 문단 그다음 문단이 이어진다');
    const long = '나'.repeat(100);
    const cut = textAt(pt(0, 0, 0), [msg(0, long)])!;
    expect(cut).toBe(`${'나'.repeat(BOOKMARK_SNIPPET - 1)}…`);
    expect(Array.from(cut)).toHaveLength(BOOKMARK_SNIPPET);
    expect(textAt(pt(9, 0, 0), ms)).toBeNull();
  });

  it('textAt skips image blocks, also when starting on one', () => {
    const ms = [msgB(0, para('앞'), img('secret.png'), para('뒤'))];
    expect(textAt(pt(0, 0, 0), ms)).toBe('앞 뒤');
    expect(textAt(pt(0, 1, 0), ms)).toBe('뒤');
    expect(textAt(pt(0, 1, 0), [msgB(0, img())])).toBeNull();
  });

  it('groupHighlights: characters and chats by most recent highlight; items by position', () => {
    const h = (id: string, charId: string, chatId: string, msgIdx: number, createdAt: number): LibraryHighlight => ({
      id, source: 'main', charId, chatId, charName: charId.toUpperCase(), chatTitle: chatId, deleted: false,
      start: { msgIdx, blockIdx: 0, charOffset: 0, anchorHash: 'h' }, end: { msgIdx, blockIdx: 0, charOffset: 1, anchorHash: 'h' },
      text: '', color: 'yellow', createdAt,
    });
    const g = groupHighlights([h('1', 'a', 'x', 5, 10), h('2', 'b', 'y', 1, 30), h('3', 'a', 'z', 2, 20), h('4', 'a', 'x', 1, 5)]);
    expect(g.map((c) => c.charId)).toEqual(['b', 'a']);
    expect(g[1]!.chats.map((c) => c.chatId)).toEqual(['z', 'x']);
    expect(g[1]!.chats[1]!.items.map((i) => i.id)).toEqual(['4', '1']);
    expect(g[1]!.charName).toBe('A');
  });

  describe('snippetFor', () => {
    const T = '앞부분 가나다라 뒷부분';
    const at = (o: number) => ({ msgIdx: 0, blockIdx: 0, charOffset: o, anchorHash: anchorOf(T, o) });
    it('highlight: text between start and end', () => {
      expect(snippetFor({ kind: 'highlight', start: at(4), end: at(8), color: '' }, [msg(0, T)])).toBe('가나다라');
    });
    it('bookmark: text from the position', () => {
      expect(snippetFor({ kind: 'bookmark', start: at(4), end: null, color: '' }, [msg(0, T)])).toBe('가나다라 뒷부분');
    });
    it('returns null when the anchor cannot be found any more', () => {
      expect(snippetFor({ kind: 'highlight', start: at(4), end: at(8), color: '' }, [msg(0, '완전히 다른 글')])).toBeNull();
      expect(snippetFor({ kind: 'bookmark', start: at(4), end: null, color: '' }, [msg(0, '완전히 다른 글')])).toBeNull();
      expect(snippetFor({ kind: 'bookmark', start: at(4), end: null, color: '' }, [])).toBeNull();
    });
  });
});
