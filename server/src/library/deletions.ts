export type DeletionPlan = { tombstone: string[]; held: boolean; missing: number };

/**
 * R6: "전부 삭제됨" 오판 방지. known = 라이브러리의 살아있는 항목 키, seen = 이번 정상 스캔에서 존재가 확인된 키.
 * 한 번의 동기화로 known 의 ratio 를 *초과* 해 사라지면 보류한다 (accept 로만 적용).
 */
export function planDeletions(a: { known: string[]; seen: Set<string>; accept: boolean; ratio: number }): DeletionPlan {
  const missing = a.known.filter((k) => !a.seen.has(k));
  if (missing.length === 0) return { tombstone: [], held: false, missing: 0 };
  if (!a.accept && a.known.length > 0 && missing.length / a.known.length > a.ratio) {
    return { tombstone: [], held: true, missing: missing.length };
  }
  return { tombstone: missing, held: false, missing: missing.length };
}
