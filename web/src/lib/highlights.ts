import { blockText, type Block } from './blocks';
import { relocate } from './position';
import type { ReadingPosition } from './types';

// 하이라이트: 시작/끝 ReadingPosition 사이의 텍스트. 렌더는 블록 텍스트를 <mark> 조각으로 나누되 텍스트 노드로만 만든다.

type Pt = Pick<ReadingPosition, 'msgIdx' | 'blockIdx' | 'charOffset'>;
export type Highlight = { id: string; start: ReadingPosition; end: ReadingPosition; color: string };
export type Mark = { from: number; to: number; id: string; color: string };
export type Segment = { text: string; mark: { id: string; color: string } | null };

export const cmpPos = (a: Pt, b: Pt): number => a.msgIdx - b.msgIdx || a.blockIdx - b.blockIdx || a.charOffset - b.charOffset;
const cmpBlock = (m1: number, b1: number, m2: number, b2: number) => m1 - m2 || b1 - b2;

/** 이 블록에 걸리는 하이라이트 조각들 [from, to) (블록 텍스트 기준, 길이로 잘라낸다). */
export function marksForBlock(hs: Highlight[], msgIdx: number, blockIdx: number, len: number): Mark[] {
  const out: Mark[] = [];
  for (const h of hs) {
    const s = cmpBlock(msgIdx, blockIdx, h.start.msgIdx, h.start.blockIdx);
    const e = cmpBlock(msgIdx, blockIdx, h.end.msgIdx, h.end.blockIdx);
    if (s < 0 || e > 0) continue;
    const from = s === 0 ? Math.min(len, Math.max(0, h.start.charOffset)) : 0;
    const to = e === 0 ? Math.min(len, Math.max(0, h.end.charOffset)) : len;
    if (to > from) out.push({ from, to, id: h.id, color: h.color });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** 텍스트를 표시 조각으로 나눈다. 겹치면 먼저 시작한 하이라이트가 그 구간을 갖는다. 글자는 하나도 잃지 않는다. */
export function segments(text: string, marks: Mark[]): Segment[] {
  if (marks.length === 0) return [{ text, mark: null }];
  const pts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.from, m.to])])]
    .filter((p) => p >= 0 && p <= text.length)
    .sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (b <= a) continue;
    const cover = marks.find((m) => m.from <= a && m.to >= b) ?? null;
    const piece = text.slice(a, b);
    const last = out[out.length - 1];
    if (last && (last.mark?.id ?? null) === (cover?.id ?? null)) last.text += piece;
    else out.push({ text: piece, mark: cover ? { id: cover.id, color: cover.color } : null });
  }
  return out;
}

/** 블록 요소 안에서 (node, offset) 이 블록 텍스트의 몇 번째 글자인지 (텍스트 노드를 순서대로 센다). */
export function offsetWithin(block: Element, node: Node, offset: number): number | null {
  if (!block.contains(node)) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let total = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t === node) return total + offset;
      total += (t.nodeValue ?? '').length;
    }
    return null;
  }
  const child = node.childNodes[offset] ?? null; // 요소 컨테이너: offset 은 자식 인덱스
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (child && (child === t || child.contains(t) || child.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) return total;
    total += (t.nodeValue ?? '').length;
  }
  return total;
}

function blockOf(n: Node): HTMLElement | null {
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  return (el?.closest('.block[data-msg][data-block]') as HTMLElement | null) ?? null;
}

/** 선택 범위 → 시작/끝 (블록 밖에서 시작·끝나거나 빈 선택이면 null). */
export function rangeToPositions(range: Range): { start: Pt; end: Pt } | null {
  const sb = blockOf(range.startContainer);
  const eb = blockOf(range.endContainer);
  if (!sb || !eb) return null;
  const so = offsetWithin(sb, range.startContainer, range.startOffset);
  const eo = offsetWithin(eb, range.endContainer, range.endOffset);
  if (so === null || eo === null) return null;
  const start = { msgIdx: Number(sb.dataset.msg), blockIdx: Number(sb.dataset.block), charOffset: so };
  const end = { msgIdx: Number(eb.dataset.msg), blockIdx: Number(eb.dataset.block), charOffset: eo };
  return cmpPos(end, start) > 0 ? { start, end } : null;
}

/**
 * 불러온 메시지의 현재 텍스트에 맞춰 하이라이트 끝점을 다시 찾는다 (숨김 규칙이 바뀌면 블록·오프셋이 밀린다).
 * 끝점을 못 찾은 하이라이트는 뺀다(숨겨진 동안 안 보임 — 데이터는 그대로). 불러오지 않은 메시지의 끝점은 그대로 둔다.
 */
export function relocateHighlights(hs: Highlight[], messages: { idx: number; blocks: Block[] }[]): Highlight[] {
  if (hs.length === 0) return hs;
  const texts = new Map(messages.map((m) => [m.idx, m.blocks.map(blockText)]));
  const out: Highlight[] = [];
  for (const h of hs) {
    const st = texts.get(h.start.msgIdx);
    const et = texts.get(h.end.msgIdx);
    const start = st ? relocate(h.start, st) : h.start;
    const end = et ? relocate(h.end, et) : h.end;
    if (!start || !end || cmpPos(end, start) <= 0) continue;
    out.push(start === h.start && end === h.end ? h : { ...h, start, end });
  }
  return out;
}
