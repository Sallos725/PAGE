import { createHash } from 'node:crypto';

export const sha256Hex = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

// 키 정렬 정규 JSON — 같은 내용이면 같은 문자열 → 같은 해시 (메시지 내용 주소 / 저장 본문).
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'bigint') return `"${v}n"`;
    return JSON.stringify(v === undefined ? null : v);
  }
  if (v instanceof Uint8Array) return `"b64:${Buffer.from(v).toString('base64')}"`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}
