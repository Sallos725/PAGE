// 스모크의 유일한 출력 통로. 형식 검사만으로는 이름 같은 ASCII 식별자가 새므로,
// 데이터에서 유래한 라벨은 반드시 허용 목록(allow)을 거친다 (스파이크 0 의 유출 사고 교훈).
const SAFE_STR = /^[A-Za-z0-9_.:\/ -]{0,48}$/;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export function assertSafe(key: string, v: unknown): void {
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (typeof v === 'string' && SAFE_STR.test(v)) return;
  throw new Error(`unsafe output refused for "${String(key).slice(0, 48)}"`);
}

export function emit(key: string, v: unknown): void {
  assertSafe(key, v);
  assertSafe('key', key);
  process.stdout.write(`${key}=${v}\n`);
}

export function foldCounts(counts: Map<string, number>, allow: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, n] of counts) {
    const k = SAFE_NAME.test(name) && allow.has(name) ? name : 'other';
    out.set(k, (out.get(k) ?? 0) + n);
  }
  return out;
}
