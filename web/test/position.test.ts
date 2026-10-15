import { describe, expect, it } from 'vitest';
import { anchorOf, findAnchor, fnv1a, relocate, resolvePosition } from '../src/lib/position';

describe('fnv1a / anchorOf', () => {
  it('is deterministic 8-hex and sensitive to content', () => {
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'));
    expect(fnv1a('')).toBe('811c9dc5'); // FNV-1a 32bit offset basis
  });

  it('anchors the text around the offset (16 chars each side) and clamps the offset', () => {
    const t = 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(anchorOf(t, 10)).toBe(anchorOf(t, 10));
    expect(anchorOf(t, 10)).not.toBe(anchorOf(t, 11));
    expect(anchorOf(t, 9999)).toBe(anchorOf(t, t.length));
    expect(anchorOf(t, -5)).toBe(anchorOf(t, 0));
    // 앵커 창 밖의 변경은 감지하지 않는다 (의도: 앞뒤 N자만 본다)
    expect(anchorOf(`Z${t}`, 21)).toBe(anchorOf(t, 20)); // 맨 앞 Z 는 오프셋 앞 16자 창 밖
  });
});

describe('resolvePosition', () => {
  const blocks = ['첫 문단입니다 첫 문단입니다', '"대사입니다"', '마지막 문단'];
  const saved = (b: number, off: number) => ({ msgIdx: 4, blockIdx: b, charOffset: off, anchorHash: anchorOf(blocks[b]!, off) });

  it('exact when the anchor still matches', () => {
    const p = saved(1, 3);
    expect(resolvePosition(p, blocks, 10)).toEqual({ pos: p, exact: true, relocated: false });
  });

  it('falls back to the start of the message when the text changed', () => {
    const p = saved(1, 3);
    const r = resolvePosition(p, ['첫 문단입니다 첫 문단입니다', '"전혀 다른 대사"', '마지막 문단'], 10);
    expect(r.exact).toBe(false);
    expect(r.relocated).toBe(false);
    expect(r.pos).toMatchObject({ msgIdx: 4, blockIdx: 0, charOffset: 0 });
    expect(r.pos.anchorHash).toBe(anchorOf('첫 문단입니다 첫 문단입니다', 0));
  });

  it('relocates by searching the anchor when the block index moved', () => {
    const p = { ...saved(2, 2), blockIdx: 9 };
    expect(resolvePosition(p, blocks, 10)).toEqual({ pos: { ...p, blockIdx: 2, charOffset: 2 }, exact: false, relocated: true });
  });

  // 앵커는 앞뒤 16자를 본다: 지워진 부분이 위치에서 16자 넘게 떨어져 있어야 다시 찾을 수 있다.
  it('relocates when text well before the position was removed (hide rule)', () => {
    const before = ['머리말 <상태> 그리고 충분히 긴 사이 문장이 있고 나서 본문이 이어지는 문단입니다'];
    const off = before[0]!.indexOf('이어지는');
    const p = { msgIdx: 4, blockIdx: 0, charOffset: off, anchorHash: anchorOf(before[0]!, off) };
    const after = ['머리말  그리고 충분히 긴 사이 문장이 있고 나서 본문이 이어지는 문단입니다'];
    expect(resolvePosition(p, after, 10)).toMatchObject({ exact: false, relocated: true, pos: { blockIdx: 0, charOffset: after[0]!.indexOf('이어지는') } });
  });

  it('clamps to the last message when messages were removed', () => {
    const r = resolvePosition({ msgIdx: 50, blockIdx: 3, charOffset: 7, anchorHash: 'x' }, null, 12);
    expect(r).toMatchObject({ exact: false, pos: { msgIdx: 11, blockIdx: 0, charOffset: 0 } });
  });

  it('unknown block texts (not loaded) cannot be verified', () => {
    const p = saved(1, 3);
    expect(resolvePosition(p, null, 10)).toMatchObject({ exact: false, pos: { msgIdx: 4, blockIdx: 0 } });
  });
});

describe('findAnchor / relocate', () => {
  const texts = ['가나다라마바사아자차카타파하 하나', '둘째 블록의 긴 문장입니다 그리고 더', '하나'];
  it('prefers the block nearest to the hint', () => {
    const h = anchorOf(texts[2]!, 0);
    expect(findAnchor(texts, h, 2)).toEqual({ blockIdx: 2, charOffset: 0 });
  });
  it('returns null when the anchor text is gone', () => {
    expect(findAnchor(texts, 'ffffffff', 0)).toBeNull();
  });
  it('relocate keeps an exact position, moves a shifted one, drops a lost one', () => {
    const p = { msgIdx: 1, blockIdx: 1, charOffset: 3, anchorHash: anchorOf(texts[1]!, 3) };
    expect(relocate(p, texts)).toBe(p);
    expect(relocate({ ...p, blockIdx: 0 }, texts)).toEqual(p);
    expect(relocate({ ...p, anchorHash: 'ffffffff' }, texts)).toBeNull();
  });
});
