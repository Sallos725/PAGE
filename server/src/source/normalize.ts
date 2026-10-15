import type { PageMessage, SourceKind } from './types.js';

/** 소스 종류별 raw 메시지 → PageMessage. 어댑터 밖으로 원본 포맷이 새지 않게 하는 유일한 통로 (스펙 3.2). */
export function normalizeMessage(kind: SourceKind, raw: unknown, idx: number): PageMessage {
  switch (kind) {
    case 'pocketrisu-sqlite':
    case 'risu-import': // 같은 메시지 모양 (임포트 스펙 §2)
      return normalizePocketRisu(raw, idx);
  }
}

// 필드 근거: findings §2.2 (role/data/time). swipes/swipeId 의 의미는 UNKNOWN 이라 PageMessage 에 넣지 않는다 (raw 는 라이브러리가 보존).
function normalizePocketRisu(raw: unknown, idx: number): PageMessage {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PageMessage = { idx, role: m.role === 'user' ? 'user' : 'char', text: typeof m.data === 'string' ? m.data : '' };
  if (typeof m.time === 'number') out.time = m.time;
  return out;
}
