import { describe, expect, it } from 'vitest';
import { syncSummary, type SyncReportLite } from '../src/lib/sync-summary';

const r = (o: Omit<Partial<SyncReportLite>, 'chats'> & { chats?: Partial<SyncReportLite['chats']> } = {}): SyncReportLite => ({
  outcome: 'synced', finishedAt: 1, ...o,
  chats: { created: 0, appended: 0, edited: 0, tombstoned: 0, ...o.chats },
});

describe('sync summary', () => {
  it('counts new, changed and deleted chats across sources', () => {
    expect(syncSummary([r({ chats: { created: 2, appended: 1 } }), r({ chats: { edited: 3, tombstoned: 1 } })]))
      .toBe('동기화했어요 · 새 채팅 2 · 바뀐 채팅 4 · 원본에서 지워진 채팅 1');
  });
  it('nothing changed', () => {
    expect(syncSummary([r(), r({ outcome: 'unchanged' })])).toBe('바뀐 게 없어요.');
  });
  it('held mass deletion and unreadable sources are mentioned', () => {
    expect(syncSummary([r({ held: { items: 10, missing: 8 } })])).toBe('바뀐 게 없어요. 지워진 채팅이 한꺼번에 너무 많아서 삭제 표시는 보류했어요.');
    expect(syncSummary([r({ chats: { created: 1 } }), r({ outcome: 'skipped' })])).toBe('동기화했어요 · 새 채팅 1. 읽지 못한 소스가 있어요.');
    expect(syncSummary([r({ outcome: 'skipped' })])).toBe('원본을 읽지 못해서 건너뛰었어요.');
  });
  it('sources whose request failed are counted, and the rest still report', () => {
    expect(syncSummary([r({ chats: { created: 1 } })], 1)).toBe('동기화했어요 · 새 채팅 1. 소스 1개는 동기화하지 못했어요.');
    expect(syncSummary([r()], 2)).toBe('바뀐 게 없어요. 소스 2개는 동기화하지 못했어요.');
    expect(syncSummary([], 1)).toBe('동기화하지 못했어요.');
    expect(syncSummary([r({ outcome: 'skipped' })], 1)).toBe('원본을 읽지 못해서 건너뛰었어요. 소스 1개는 동기화하지 못했어요.');
  });
  it('unreadable and failed sources merge into one sentence', () => {
    expect(syncSummary([r({ chats: { created: 1 } }), r({ outcome: 'skipped' })], 2)).toBe('동기화했어요 · 새 채팅 1. 소스 3개는 읽지 못했거나 동기화하지 못했어요.');
    expect(syncSummary([r(), r({ outcome: 'skipped' })], 1)).toBe('바뀐 게 없어요. 소스 2개는 읽지 못했거나 동기화하지 못했어요.');
  });
});
