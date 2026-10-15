// 원본(source) 표시 이름과 가져오기 결과 문구. 'imported' 는 서버가 예약한 이름이다.
export const IMPORTED = 'imported';

export const PORTABLE = 'pocketrisu';

export const sourceLabel = (id: string): string => (id === IMPORTED ? '가져온 채팅' : id === PORTABLE ? 'PocketRisu' : id);

/** 원본 연결 판별 실패 문구 (포터블 스펙 §4.2). */
export function checkMessage(reason: 'not-absolute' | 'unc' | 'not-found' | 'unreadable'): string {
  if (reason === 'unreadable') return '그 폴더를 읽을 권한이 없어요. 다른 폴더를 고르거나 PAGE 를 같은 사용자로 실행해 주세요.';
  if (reason === 'unc') return '네트워크 폴더는 연결할 수 없어요. 이 PC 의 폴더를 골라 주세요.';
  if (reason === 'not-absolute') return '폴더 경로 전체를 넣어 주세요 (예: C:\\Users\\…\\PocketRisu).';
  return 'PocketRisu 저장 폴더를 찾지 못했어요. PocketRisu 폴더(안에 save 폴더가 있는 곳)를 골라 주세요. RisuBard 는 아직 지원하지 않아요.';
}

export function importSummary(results: { status: 'new' | 'updated' | 'unchanged' }[]): string {
  if (results.length === 0) return '채팅이 없어요';
  const n = (s: 'new' | 'updated' | 'unchanged') => results.filter((r) => r.status === s).length;
  return [['새 채팅', n('new')], ['갱신', n('updated')], ['그대로', n('unchanged')]]
    .filter(([, c]) => (c as number) > 0)
    .map(([label, c]) => `${label as string} ${c as number}`)
    .join(' · ');
}
