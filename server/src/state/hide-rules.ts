// 숨김 규칙 검증 (스펙 §5.2.2). 웹의 web/src/lib/hide-rules.ts 와 같은 규칙이다 — 바꾸면 둘 다 바꾼다.
// 패턴은 사용자/캐릭터 데이터다: 오류 응답·로그에는 오류 코드만 남기고 패턴 원문을 넣지 않는다.

export const RULE_LIMITS = { pattern: 500, name: 40, perSource: 200 } as const;
export type RuleError = 'name' | 'pattern' | 'flags' | 'compile' | 'empty-match';
export type RuleCheck = { ok: true; flags: string } | { ok: false; error: RuleError };

const FLAG_ORDER = 'gimsu';
const CONTROL = /[\u0000-\u001f\u007f]/;

/** gimsu 만 허용하고 정해진 순서로, 중복 없이. 그 밖의 글자가 있으면 null. */
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
  if (re.test('')) return { ok: false, error: 'empty-match' }; // 빈 문자열에도 걸리는 패턴은 의도와 다를 가능성이 크다
  return { ok: true, flags: f };
}
