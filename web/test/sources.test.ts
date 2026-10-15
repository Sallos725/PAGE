import { describe, expect, it } from 'vitest';
import { checkMessage, importSummary, sourceLabel } from '../src/lib/sources';

describe('sources', () => {
  it('labels the imported source', () => {
    expect(sourceLabel('imported')).toBe('가져온 채팅');
    expect(sourceLabel('main')).toBe('main');
    expect(sourceLabel('pocketrisu')).toBe('PocketRisu');
  });
  it('explains a failed source check', () => {
    expect(checkMessage('not-found')).toContain('찾지 못했어요');
    expect(checkMessage('unc')).toContain('네트워크 폴더');
    expect(checkMessage('not-absolute')).toContain('경로 전체');
    expect(checkMessage('unreadable')).toContain('권한');
  });
  it('summarises an upload', () => {
    expect(importSummary([{ status: 'new' }, { status: 'new' }, { status: 'updated' }, { status: 'unchanged' }])).toBe('새 채팅 2 · 갱신 1 · 그대로 1');
    expect(importSummary([{ status: 'new' }])).toBe('새 채팅 1');
    expect(importSummary([])).toBe('채팅이 없어요');
  });
});
