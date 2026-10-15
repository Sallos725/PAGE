import { fnv1a } from './position';

// 책등 규칙 (스펙 6.3). 순수 함수 — 컴포넌트는 결과를 CSSOM 으로만 적용한다 (CSP).
export const SPINE_COLORS = 7;

const SPINE_MAX = 124;
const SPINE_FLOOR = 54; // 제목이 보이는 최소 높이
const SPINE_MIN_RATIO = 0.7;

export type SpineRange = { min: number; max: number };

/** 캐릭터 한 명의 채팅 길이 범위 (메시지가 있는 채팅만). 없으면 null. */
export function spineRange(chats: { msgCount: number | null }[]): SpineRange | null {
  const ns = chats.map((c) => c.msgCount ?? 0).filter((n) => n > 0);
  return ns.length ? { min: Math.min(...ns), max: Math.max(...ns) } : null;
}

/**
 * 높이: 캐릭터마다 가장 긴 채팅 = 124px(100%), 가장 짧은 채팅 = 70%, 사이는 로그 눈금. scale 배 (모바일 홈 0.75).
 * 빈 채팅은 54px. 채팅이 하나뿐이거나 길이가 모두 같으면 100%. 줄여도 54px 아래로는 안 내려간다(제목이 보이게).
 */
export function spineHeight(msgCount: number | null, range: SpineRange | null, scale = 1): number {
  const n = msgCount ?? 0;
  if (n <= 0) return SPINE_FLOOR;
  let f = 1;
  if (range && range.max > range.min) {
    const lo = Math.log1p(range.min);
    f = Math.min(1, Math.max(0, (Math.log1p(n) - lo) / (Math.log1p(range.max) - lo)));
  }
  const ratio = SPINE_MIN_RATIO + (1 - SPINE_MIN_RATIO) * f;
  return Math.max(SPINE_FLOOR, Math.round(SPINE_MAX * ratio * scale));
}

/** 두께: 제목 길이로 22–34px (세로쓰기 한 줄이 들어가게, 넘치면 CSS 가 말줄임). */
export function spineWidth(title: string): number {
  const len = [...title].length;
  return Math.min(34, Math.max(22, 22 + Math.round(Math.max(0, len - 5) * 1.5)));
}

/** 색: chatId 해시로 고정 (같은 책은 항상 같은 색). */
export const spineColor = (chatId: string): number => parseInt(fnv1a(chatId), 16) % SPINE_COLORS;

export type SpineState = 'reading' | 'normal' | 'empty';
export function spineState(c: { msgCount: number | null; progress: number | null; lastError: string | null }): SpineState {
  if (!c.msgCount || c.lastError) return 'empty';
  return c.progress !== null && c.progress < 0.98 ? 'reading' : 'normal';
}
