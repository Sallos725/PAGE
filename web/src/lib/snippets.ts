// 책갈피·형광펜의 문장 미리보기와 서고 전체 묶기 (형광펜 스펙 §2, §4). 화면에 보이는 블록 글자 기준이다.
import { blockText, type Block } from './blocks';
import { cmpPos, relocateHighlights } from './highlights';
import { relocate } from './position';
import type { LibraryHighlight, ReadingPosition } from './types';

export const HIGHLIGHT_SNIPPET = 2000;
export const BOOKMARK_SNIPPET = 60;

type Pt = { msgIdx: number; blockIdx: number; charOffset: number };
type Msg = { idx: number; blocks: Block[] };

export const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 코드포인트 max 개 이내로 자른다. 넘으면 max-1 개 + … (… 포함 max 이내 — 서버 maxLength 와 같은 단위). */
export function cap(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}

/** 글자를 보이는 블록인가. 이미지·구분선은 아니다 (blockText 는 이미지에 `image:이름` 을 돌려주지만 그건 위치 계산용이다). */
const showsText = (b: Block): boolean => b.kind === 'paragraph' || b.kind === 'dialogue';

/** 오프셋으로 자르다 짝 잃은 서로게이트가 양 끝에 남으면 지운다. */
const trimSurrogates = (s: string): string => s.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');

/** start~end 사이 화면 글자. 양 끝 메시지·블록이 없으면 null. 가운데 메시지가 없으면(숨긴 내 메시지 등) 건너뛰고, 글자 없는 블록(이미지 등)은 건너뛴다. */
export function textBetween(start: Pt, end: Pt, messages: Msg[]): string | null {
  const byIdx = new Map(messages.map((m) => [m.idx, m]));
  const parts: string[] = [];
  for (let mi = start.msgIdx; mi <= end.msgIdx; mi++) {
    const m = byIdx.get(mi);
    if (!m) {
      if (mi === start.msgIdx || mi === end.msgIdx) return null;
      continue;
    }
    const texts = m.blocks.map(blockText); // 오프셋·존재 확인은 blockText 기준
    if (mi === start.msgIdx && texts[start.blockIdx] === undefined) return null;
    const b0 = mi === start.msgIdx ? start.blockIdx : 0;
    const b1 = mi === end.msgIdx ? end.blockIdx : texts.length - 1;
    for (let bi = b0; bi <= b1; bi++) {
      const t = texts[bi];
      if (t === undefined) return null;
      if (!showsText(m.blocks[bi]!)) continue;
      const from = mi === start.msgIdx && bi === start.blockIdx ? start.charOffset : 0;
      const to = mi === end.msgIdx && bi === end.blockIdx ? end.charOffset : t.length;
      parts.push(trimSurrogates(t.slice(from, to)));
    }
  }
  const s = tidy(parts.join(' '));
  return s ? cap(s, HIGHLIGHT_SNIPPET) : null;
}

/** 책갈피 미리보기: 그 자리부터 n 자 (같은 메시지의 다음 글자 블록으로 이어 간다). 시작 블록에 글자가 없으면 다음 글자 블록부터. */
export function textAt(p: Pt, messages: Msg[], n = BOOKMARK_SNIPPET): string | null {
  const m = messages.find((x) => x.idx === p.msgIdx);
  if (!m || m.blocks[p.blockIdx] === undefined) return null;
  const texts = m.blocks.map(blockText);
  let s = '';
  for (let bi = p.blockIdx; bi < m.blocks.length && Array.from(tidy(s)).length < n; bi++) {
    if (!showsText(m.blocks[bi]!)) continue;
    s += ` ${bi === p.blockIdx ? trimSurrogates(texts[bi]!.slice(p.charOffset)) : texts[bi]}`;
  }
  const t = tidy(s);
  return t ? cap(t, n) : null;
}

/** 저장된 책갈피·형광펜의 문장 미리보기. 위치가 어긋났으면 앵커로 다시 찾고, 못 찾으면 null. msgs 는 시작~끝을 덮는 메시지들. */
export function snippetFor(
  b: { kind: 'bookmark' | 'highlight'; start: ReadingPosition; end: ReadingPosition | null; color: string },
  msgs: Msg[],
): string | null {
  if (b.kind === 'highlight' && b.end) {
    const [h] = relocateHighlights([{ id: 'snippet', start: b.start, end: b.end, color: b.color || 'yellow' }], msgs);
    return h ? textBetween(h.start, h.end, msgs) : null;
  }
  const m = msgs.find((x) => x.idx === b.start.msgIdx);
  const p = m ? relocate(b.start, m.blocks.map(blockText)) : null;
  return p ? textAt(p, msgs) : null;
}

export type HighlightGroup = {
  key: string; source: string; charId: string; charName: string;
  chats: { chatId: string; chatTitle: string; deleted: boolean; items: LibraryHighlight[] }[];
};

/** 캐릭터 → 채팅으로 묶는다. 캐릭터·채팅은 가장 최근 형광펜 순, 채팅 안은 위치 순. */
export function groupHighlights(hs: LibraryHighlight[]): HighlightGroup[] {
  const chars = new Map<string, HighlightGroup & { latest: number; chatMap: Map<string, HighlightGroup['chats'][number] & { latest: number }> }>();
  for (const h of hs) {
    const key = `${h.source}\u0000${h.charId}`;
    let g = chars.get(key);
    if (!g) { g = { key, source: h.source, charId: h.charId, charName: h.charName, chats: [], latest: 0, chatMap: new Map() }; chars.set(key, g); }
    g.latest = Math.max(g.latest, h.createdAt);
    let c = g.chatMap.get(h.chatId);
    if (!c) { c = { chatId: h.chatId, chatTitle: h.chatTitle, deleted: h.deleted, items: [], latest: 0 }; g.chatMap.set(h.chatId, c); }
    c.latest = Math.max(c.latest, h.createdAt);
    c.items.push(h);
  }
  return [...chars.values()].sort((a, b) => b.latest - a.latest).map((g) => ({
    key: g.key, source: g.source, charId: g.charId, charName: g.charName,
    chats: [...g.chatMap.values()].sort((a, b) => b.latest - a.latest)
      .map((c) => ({ chatId: c.chatId, chatTitle: c.chatTitle, deleted: c.deleted, items: [...c.items].sort((x, y) => cmpPos(x.start, y.start)) })),
  }));
}
