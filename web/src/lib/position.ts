import type { ReadingPosition } from './types';

export type { ReadingPosition };

const CTX = 16; // 앵커가 보는 앞/뒤 글자 수

/** FNV-1a 32bit → 8자리 hex. 비암호 해시: 원문 변경 감지용이지 보안용이 아니다 (동기 계산 필요). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 위치 앞뒤 N자의 해시 — 원문이 수정/스와이프로 바뀌었는지 감지한다 (스펙 4.1). */
export function anchorOf(text: string, offset: number): string {
  const o = Math.min(Math.max(0, offset), text.length);
  return fnv1a(`${text.slice(Math.max(0, o - CTX), o)}|${text.slice(o, o + CTX)}`);
}

export type Resolved = { pos: ReadingPosition; exact: boolean; relocated: boolean };

/**
 * 앵커 해시가 같은 자리를 메시지의 블록들에서 찾는다 (원문 수정·숨김 규칙으로 블록/오프셋이 밀린 경우).
 * hint 블록에서 가까운 블록부터 본다. 메시지 하나(수천 자) 안에서만 돌므로 전수 검색으로 충분하다.
 */
export function findAnchor(blockTexts: string[], anchorHash: string, hint: number): { blockIdx: number; charOffset: number } | null {
  const order = blockTexts.map((_, i) => i).sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint) || a - b);
  for (const b of order) {
    const t = blockTexts[b]!;
    for (let o = 0; o <= t.length; o++) if (anchorOf(t, o) === anchorHash) return { blockIdx: b, charOffset: o };
  }
  return null;
}

/** 위치가 그대로면 그 객체를, 밀렸으면 찾은 자리를, 못 찾으면 null. */
export function relocate(p: ReadingPosition, blockTexts: string[]): ReadingPosition | null {
  const t = blockTexts[p.blockIdx];
  if (t !== undefined && anchorOf(t, p.charOffset) === p.anchorHash) return p;
  const f = findAnchor(blockTexts, p.anchorHash, p.blockIdx);
  return f ? { ...p, ...f } : null;
}

/**
 * 저장된 위치를 실제 텍스트에 맞춰 검증한다.
 * blockTexts: saved.msgIdx 메시지의 블록 텍스트들 (로드되지 않았으면 null), total: 채팅 전체 메시지 수.
 * 그대로면 exact, 메시지 안에서 다시 찾았으면 relocated, 둘 다 아니면 그 메시지의 처음으로 폴백
 * (UI 는 exact 도 relocated 도 아닐 때만 "내용이 바뀌었을 수 있어요" 를 띄운다).
 */
export function resolvePosition(saved: ReadingPosition, blockTexts: string[] | null, total: number): Resolved {
  const msgIdx = Math.min(saved.msgIdx, Math.max(0, total - 1));
  const fallback = (): Resolved => ({
    pos: { msgIdx, blockIdx: 0, charOffset: 0, anchorHash: anchorOf(blockTexts?.[0] ?? '', 0) },
    exact: false,
    relocated: false,
  });
  if (msgIdx !== saved.msgIdx || !blockTexts) return fallback();
  const r = relocate(saved, blockTexts);
  if (!r) return fallback();
  return r === saved ? { pos: saved, exact: true, relocated: false } : { pos: r, exact: false, relocated: true };
}
