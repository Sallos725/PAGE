import type { ChangeKind } from './classify.js';
import type { Reason } from './store.js';

export type Decision =
  | { commit: Exclude<Reason, 'deleted-marker'>; pending: null }
  | { commit: null; pending: { fp: string; since: number } | null };

export type DecideArgs = {
  kind: ChangeKind;
  manifestHash: string; // 현재 소스 상태의 정체성 (대기 중인 변화와 비교)
  pendingFp: string | null;
  pendingSince: number | null;
  now: number;
  debounceMs: number; // D17 잠정값 (기본 10분)
  force: boolean; // 채팅 열 때 동기화: 디바운스 무시
};

/**
 * 스펙 3.4.4: 단순 추가는 N분 변화가 없을 때 새 버전으로 확정(디바운스).
 * 기존 메시지가 바뀌거나 사라지는 변경(edited/truncated)은 즉시 버전을 만들어 손실을 막는다.
 */
export function decideVersion(a: DecideArgs): Decision {
  switch (a.kind) {
    case 'new':
      return { commit: 'initial', pending: null };
    case 'edited':
    case 'truncated':
      return { commit: 'edited', pending: null };
    case 'appended': {
      if (a.force) return { commit: 'appended', pending: null };
      const sameWait = a.pendingFp === a.manifestHash && a.pendingSince !== null;
      if (sameWait && a.now - (a.pendingSince as number) >= a.debounceMs) return { commit: 'appended', pending: null };
      return { commit: null, pending: { fp: a.manifestHash, since: sameWait ? (a.pendingSince as number) : a.now } };
    }
    case 'unchanged':
    case 'removed':
      return { commit: null, pending: null };
  }
}
