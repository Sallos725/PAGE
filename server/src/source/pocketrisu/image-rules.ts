import { sha256Hex } from '../../canon.js';

// 카드 그림 규칙 (스펙 3C §3.1). editdisplay 출력 속 `<img src="{{raw|img|image|asset|path::이름}}">` 중
// 조건 블록 밖에 있고 이름이 고정 문자열 또는 $n/$<name>/$& 템플릿인 것만. 출력 HTML 은 버린다.
export type ImageRule = { key: string; name: string; in: string; flag: string; images: string[] };

const MAX_RULES = 50;
const MAX_IMAGES = 10;
const MAX_PATTERN = 500;
const IMG = /<img\b[^>]*\bsrc\s*=\s*["']?\s*\{\{(?:raw|img|image|asset|path)::([^}]*)\}\}/gi;

type Json = Record<string, unknown>;

export function extractImageRules(v: unknown): ImageRule[] {
  if (!Array.isArray(v)) return [];
  const out: ImageRule[] = [];
  for (const s of v) {
    if (out.length >= MAX_RULES) break;
    if (!s || typeof s !== 'object') continue;
    const o = s as Json;
    if (o.type !== 'editdisplay' || typeof o.in !== 'string' || typeof o.out !== 'string') continue;
    if (o.in.length < 1 || o.in.length > MAX_PATTERN) continue;
    const images: string[] = [];
    for (const m of o.out.matchAll(IMG)) {
      if (images.length >= MAX_IMAGES) break;
      const before = o.out.slice(0, m.index ?? 0);
      const depth = (before.match(/\{\{#/g) ?? []).length - (before.match(/\{\{\//g) ?? []).length;
      if (depth > 0) continue; // 조건 블록 안 (C2)
      const arg = (m[1] ?? '').trim();
      if (!arg || arg.length > 300 || arg.includes('{{')) continue; // CBS 이름 제외
      images.push(arg);
    }
    if (images.length === 0) continue;
    const raw = o.ableFlag === true && typeof o.flag === 'string' ? o.flag : 'g';
    const flag = [...'gimsu'].filter((ch) => raw.includes(ch)).join('');
    const key = sha256Hex(`${o.in}\u0000${flag}\u0000${images.join('\u0000')}`).slice(0, 16);
    out.push({ key, name: typeof o.comment === 'string' ? o.comment.slice(0, 40) : '', in: o.in, flag, images });
  }
  return out;
}
