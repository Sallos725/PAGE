import type { ImageRule } from './types';

// 카드 그림 규칙 적용 (스펙 3C §4.1). 일치한 자리를 `{{raw::이름}}` 줄로 바꾼다 — 파서가 이미지 블록으로 그린다.
// 템플릿 풀이는 server/src/sync/image-rule-names.ts 와 같은 규칙이다 — 바꾸면 둘 다 바꾼다.
const MAX_MESSAGE = 200_000;
const valid = (n: string) => n.length >= 1 && n.length <= 300 && !/[{}\n\r]/.test(n);

function expand(t: string, whole: string, groups: string[], named: Record<string, string> | undefined): string {
  return t.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (_all, k: string) => {
    if (k === '$') return '$';
    if (k === '&') return whole;
    if (k.startsWith('<')) return named?.[k.slice(1, -1)] ?? '';
    return Number(k) === 0 ? '' : (groups[Number(k) - 1] ?? '');
  });
}

export function applyImageRules(text: string, rules: ImageRule[]): string {
  if (rules.length === 0 || text.length > MAX_MESSAGE) return text;
  let out = text;
  for (const r of rules) {
    if (!r.enabled || r.slow) continue;
    let re: RegExp;
    try {
      const flags = r.flags.includes('g') ? r.flags : `${r.flags}g`;
      if (new RegExp(r.pattern, flags.replace('g', '')).test('')) continue;
      re = new RegExp(r.pattern, flags);
    } catch {
      continue;
    }
    out = out.replace(re, (...args: unknown[]) => {
      const whole = args[0] as string;
      const last = args[args.length - 1];
      const named = last && typeof last === 'object' ? (last as Record<string, string>) : undefined;
      const end = named ? args.length - 3 : args.length - 2; // [..groups, offset, string, groups?]
      const groups = args.slice(1, end).map((g) => (typeof g === 'string' ? g : ''));
      const names = r.images.map((t) => expand(t, whole, groups, named).trim()).filter(valid);
      return names.length ? `\n${names.map((n) => `{{raw::${n}}}`).join('\n')}\n` : whole;
    });
  }
  return out;
}
