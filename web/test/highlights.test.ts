import { describe, expect, it } from 'vitest';
import { cmpPos, marksForBlock, offsetWithin, rangeToPositions, relocateHighlights, segments, type Highlight } from '../src/lib/highlights';
import { anchorOf } from '../src/lib/position';

const P = (m: number, b: number, o: number) => ({ msgIdx: m, blockIdx: b, charOffset: o, anchorHash: '' });
const H = (id: string, s: ReturnType<typeof P>, e: ReturnType<typeof P>, color = 'yellow'): Highlight => ({ id, start: s, end: e, color });

describe('cmpPos', () => {
  it('orders by message, then block, then offset', () => {
    expect(cmpPos(P(1, 0, 0), P(2, 0, 0))).toBeLessThan(0);
    expect(cmpPos(P(1, 2, 0), P(1, 1, 9))).toBeGreaterThan(0);
    expect(cmpPos(P(1, 1, 3), P(1, 1, 3))).toBe(0);
  });
});

describe('marksForBlock', () => {
  const span = H('a', P(3, 1, 4), P(4, 0, 2));
  it('clips a multi-block highlight to each block', () => {
    expect(marksForBlock([span], 3, 1, 10)).toEqual([{ from: 4, to: 10, id: 'a', color: 'yellow' }]); // 시작 블록
    expect(marksForBlock([span], 3, 2, 7)).toEqual([{ from: 0, to: 7, id: 'a', color: 'yellow' }]); // 가운데 블록 전체
    expect(marksForBlock([span], 4, 0, 9)).toEqual([{ from: 0, to: 2, id: 'a', color: 'yellow' }]); // 끝 블록
  });
  it('ignores blocks outside the range, empty pieces, and clamps to the text length', () => {
    expect(marksForBlock([span], 3, 0, 10)).toEqual([]);
    expect(marksForBlock([span], 4, 1, 10)).toEqual([]);
    expect(marksForBlock([H('b', P(1, 0, 5), P(1, 0, 50))], 1, 0, 8)).toEqual([{ from: 5, to: 8, id: 'b', color: 'yellow' }]);
    expect(marksForBlock([H('c', P(1, 0, 9), P(1, 0, 20))], 1, 0, 8)).toEqual([]); // 텍스트가 짧아져 범위가 사라짐
  });
});

describe('segments', () => {
  it('splits text into marked and plain pieces without losing characters', () => {
    expect(segments('abcdef', [])).toEqual([{ text: 'abcdef', mark: null }]);
    const s = segments('abcdef', [{ from: 2, to: 4, id: 'x', color: 'yellow' }]);
    expect(s).toEqual([{ text: 'ab', mark: null }, { text: 'cd', mark: { id: 'x', color: 'yellow' } }, { text: 'ef', mark: null }]);
    expect(s.map((p) => p.text).join('')).toBe('abcdef');
  });
  it('overlaps: the earlier-starting mark wins; same-mark neighbours merge', () => {
    const s = segments('abcdefgh', [{ from: 1, to: 5, id: 'x', color: 'yellow' }, { from: 3, to: 7, id: 'y', color: 'green' }]);
    expect(s.map((p) => [p.text, p.mark?.id ?? null])).toEqual([['a', null], ['bcde', 'x'], ['fg', 'y'], ['h', null]]);
  });
  it('marks at the edges', () => {
    expect(segments('abc', [{ from: 0, to: 3, id: 'x', color: 'yellow' }])).toEqual([{ text: 'abc', mark: { id: 'x', color: 'yellow' } }]);
  });
});

describe('selection → positions (DOM)', () => {
  function dom() {
    document.body.innerHTML = '';
    const make = (msg: number, block: number, parts: (string | [string])[]) => {
      const div = document.createElement('div');
      div.className = 'block';
      div.dataset.msg = String(msg);
      div.dataset.block = String(block);
      const p = document.createElement('p');
      for (const part of parts) {
        if (typeof part === 'string') p.appendChild(document.createTextNode(part));
        else { const m = document.createElement('mark'); m.textContent = part[0]; p.appendChild(m); }
      }
      div.appendChild(p);
      document.body.appendChild(div);
      return p;
    };
    return { p1: make(2, 0, ['ab', ['cd'], 'ef']), p2: make(2, 1, ['ghij']) };
  }

  it('offsetWithin counts text before the point across <mark> pieces', () => {
    const { p1 } = dom();
    const block = p1.parentElement!;
    expect(offsetWithin(block, p1.childNodes[2]!, 1)).toBe(5); // 'ef' 의 1번째 → ab|cd|e
    expect(offsetWithin(block, p1.childNodes[1]!.firstChild!, 0)).toBe(2);
    expect(offsetWithin(block, p1, 1)).toBe(2); // 요소 컨테이너: 자식 인덱스 1 앞의 글자 수
    expect(offsetWithin(block, p1, 3)).toBe(6);
    expect(offsetWithin(block, document.body, 0)).toBeNull();
  });

  it('rangeToPositions maps a range across blocks; collapsed or outside ranges are null', () => {
    const { p1, p2 } = dom();
    const r = document.createRange();
    r.setStart(p1.childNodes[0]!, 1);
    r.setEnd(p2.firstChild!, 3);
    expect(rangeToPositions(r)).toEqual({ start: { msgIdx: 2, blockIdx: 0, charOffset: 1 }, end: { msgIdx: 2, blockIdx: 1, charOffset: 3 } });
    const c = document.createRange();
    c.setStart(p2.firstChild!, 2);
    c.setEnd(p2.firstChild!, 2);
    expect(rangeToPositions(c)).toBeNull();
    const o = document.createRange();
    o.setStart(document.body, 0);
    o.setEnd(p2.firstChild!, 1);
    expect(rangeToPositions(o)).toBeNull();
  });
});

describe('relocateHighlights', () => {
  const para = (text: string) => ({ kind: 'paragraph' as const, text });
  const pos = (msgIdx: number, blockIdx: number, text: string, charOffset: number) => ({ msgIdx, blockIdx, charOffset, anchorHash: anchorOf(text, charOffset) });
  // 지워지는 조각은 끝점에서 16자(앵커 범위) 넘게 떨어져 있다
  const T = '앞부분 숨길조각 그리고 충분히 긴 사이 문장이 있고 나서 강조할 문장이 여기에 있습니다 그리고 끝';
  const h = { id: 'h1', color: 'yellow', start: pos(3, 0, T, T.indexOf('강조')), end: pos(3, 0, T, T.indexOf(' 여기')) };

  it('keeps highlights whose text did not move', () => {
    expect(relocateHighlights([h], [{ idx: 3, blocks: [para(T)] }])).toEqual([h]);
  });
  it('moves endpoints when text before them disappeared', () => {
    const after = '앞부분  그리고 충분히 긴 사이 문장이 있고 나서 강조할 문장이 여기에 있습니다 그리고 끝';
    const [r] = relocateHighlights([h], [{ idx: 3, blocks: [para(after)] }]);
    expect(r!.start.charOffset).toBe(after.indexOf('강조'));
    expect(r!.end.charOffset).toBe(after.indexOf(' 여기'));
  });
  it('drops a highlight whose text is hidden, keeps endpoints in unloaded messages as they are', () => {
    expect(relocateHighlights([h], [{ idx: 3, blocks: [para('앞부분 숨길조각')] }])).toEqual([]);
    expect(relocateHighlights([h], [{ idx: 9, blocks: [para('다른 메시지')] }])).toEqual([h]);
  });
});
