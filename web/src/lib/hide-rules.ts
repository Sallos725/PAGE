import type { HideRule } from './types';

// 숨김 규칙 (스펙 §5.2). 검증 규칙은 server/src/state/hide-rules.ts 와 같다 — 바꾸면 둘 다 바꾼다.
// 적용은 메시지 원문 → 일치 부분 삭제 → 파서. 원문 보기(showRaw)는 이 함수를 거치지 않는다.

export const RULE_LIMITS = { pattern: 500, name: 40, perMessage: 200_000 } as const;
export type RuleError = 'name' | 'pattern' | 'flags' | 'compile' | 'empty-match' | 'slow';
export type RuleCheck = { ok: true; flags: string } | { ok: false; error: RuleError };

export const RULE_ERROR_TEXT: Record<RuleError, string> = {
  name: '이름은 1–40자로 써 주세요.',
  pattern: '패턴은 1–500자이고 줄바꿈 같은 제어 문자는 못 넣어요.',
  flags: '플래그는 g, i, m, s, u 만 쓸 수 있어요.',
  compile: '정규식 문법이 맞지 않아요.',
  'empty-match': '빈 문자열에도 걸리는 패턴이에요. 숨길 부분을 더 구체적으로 써 주세요.',
  slow: '이 패턴은 너무 오래 걸려요.',
};

const FLAG_ORDER = 'gimsu';
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeFlags(f: string): string | null {
  if (/[^gimsu]/.test(f)) return null;
  return [...FLAG_ORDER].filter((c) => f.includes(c)).join('');
}

export function checkRule(name: string, pattern: string, flags: string): RuleCheck {
  const n = name.trim();
  if (n.length < 1 || n.length > RULE_LIMITS.name || CONTROL.test(n)) return { ok: false, error: 'name' };
  if (pattern.length < 1 || pattern.length > RULE_LIMITS.pattern || CONTROL.test(pattern)) return { ok: false, error: 'pattern' };
  const f = normalizeFlags(flags);
  if (f === null) return { ok: false, error: 'flags' };
  let re: RegExp;
  try {
    re = new RegExp(pattern, f.replace('g', ''));
  } catch {
    return { ok: false, error: 'compile' };
  }
  if (re.test('')) return { ok: false, error: 'empty-match' };
  return { ok: true, flags: f };
}

const withG = (flags: string) => (flags.includes('g') ? flags : `${flags}g`);

/** 켜진 규칙만, 유효한 것만, 항상 전역(g)으로. 저장된 규칙이 깨져 있어도 던지지 않는다. */
export function compileRules(rules: HideRule[]): RegExp[] {
  const out: RegExp[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const c = checkRule(r.name || 'n', r.pattern, r.flags);
    if (!c.ok) continue;
    out.push(new RegExp(r.pattern, withG(c.flags)));
  }
  return out;
}

export function applyHideRules(text: string, res: RegExp[]): string {
  if (res.length === 0 || text.length > RULE_LIMITS.perMessage) return text;
  let out = text;
  for (const re of res) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  return out;
}

/** 시험 실행용 (Worker 안에서 돈다): 비어 있지 않은 일치 수. */
export function countMatches(texts: string[], pattern: string, flags: string): number {
  const re = new RegExp(pattern, withG(flags));
  let n = 0;
  for (const t of texts) {
    if (t.length > RULE_LIMITS.perMessage) continue;
    for (const m of t.matchAll(re)) if (m[0].length > 0) n++;
  }
  return n;
}
