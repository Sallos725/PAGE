export type ChangeKind = 'new' | 'unchanged' | 'appended' | 'truncated' | 'edited' | 'removed';

/** prev/cur: 메시지 해시 배열 (채팅이 없으면 null). 스펙 3.4.3 의 변경 유형에 대응. */
export function classifyChat(prev: string[] | null, cur: string[] | null): ChangeKind {
  if (prev === null && cur === null) return 'unchanged';
  if (prev === null) return 'new';
  if (cur === null) return 'removed';
  const same = (n: number) => { for (let i = 0; i < n; i++) if (prev[i] !== cur[i]) return false; return true; };
  if (prev.length === cur.length) return same(prev.length) ? 'unchanged' : 'edited';
  if (cur.length > prev.length) return same(prev.length) ? 'appended' : 'edited';
  return same(cur.length) ? 'truncated' : 'edited';
}
