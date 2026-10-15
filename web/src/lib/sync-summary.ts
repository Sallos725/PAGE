// 지금 동기화 결과 문구 (스펙 3D E4·E6). 개수만 — 채팅 이름은 넣지 않는다.
export type SyncReportLite = {
  outcome: 'synced' | 'unchanged' | 'skipped';
  finishedAt: number;
  chats: { created: number; appended: number; edited: number; tombstoned: number };
  held?: { items: number; missing: number };
};

/** failed = 요청 자체가 실패한 소스 수 (네트워크·서버 오류). skipped(원본을 못 읽음)와 따로 센다. */
export function syncSummary(reports: SyncReportLite[], failed = 0): string {
  if (reports.length === 0) return '동기화하지 못했어요.';
  const ok = reports.filter((r) => r.outcome !== 'skipped');
  const skipped = reports.length - ok.length;
  const failTail = ` 소스 ${failed}개는 동기화하지 못했어요.`;
  if (ok.length === 0) return `원본을 읽지 못해서 건너뛰었어요.${failed > 0 ? failTail : ''}`;
  let created = 0;
  let changed = 0;
  let gone = 0;
  for (const r of ok) {
    created += r.chats.created;
    changed += r.chats.appended + r.chats.edited;
    gone += r.chats.tombstoned;
  }
  const parts: string[] = [];
  if (created) parts.push(`새 채팅 ${created}`);
  if (changed) parts.push(`바뀐 채팅 ${changed}`);
  if (gone) parts.push(`원본에서 지워진 채팅 ${gone}`);
  let s = parts.length ? `동기화했어요 · ${parts.join(' · ')}` : '바뀐 게 없어요.';
  if (ok.some((r) => r.held)) s += ' 지워진 채팅이 한꺼번에 너무 많아서 삭제 표시는 보류했어요.';
  const tail = skipped > 0 && failed > 0 ? ` 소스 ${skipped + failed}개는 읽지 못했거나 동기화하지 못했어요.`
    : skipped > 0 ? ' 읽지 못한 소스가 있어요.'
    : failed > 0 ? failTail : '';
  if (tail && !s.endsWith('.')) s += '.';
  return s + tail;
}
