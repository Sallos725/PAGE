import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, parseRisuExport } from '../src/import/format.js';

const chat = (o: Record<string, unknown> = {}) => ({ id: 'c-1', name: '합성 채팅', lastDate: 5, message: [{ role: 'user', data: '안녕' }], extra: 1, ...o });

describe('parseRisuExport', () => {
  it('accepts risuChat ver 2 with one chat and keeps unknown fields', () => {
    const r = parseRisuExport({ type: 'risuChat', ver: 2, data: chat(), folders: [] });
    expect(r).toEqual({ ok: true, chats: [{ id: 'c-1', title: '합성 채팅', lastDate: 5, messages: [{ role: 'user', data: '안녕' }], raw: chat() }] });
  });

  it('accepts risuAllChats ver 2 with an array', () => {
    const r = parseRisuExport({ type: 'risuAllChats', ver: 2, data: [chat({ id: 'a' }), chat({ id: 'b' })] });
    expect(r.ok && r.chats.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('normalises odd fields like RisuAI does (no id, non-string name, non-array message)', () => {
    const r = parseRisuExport({ type: 'risuChat', ver: 2, data: { name: 3, message: 'x' } });
    expect(r).toEqual({ ok: true, chats: [{ id: null, title: '', lastDate: null, messages: [], raw: { name: 3, message: [] } }] });
  });

  it('rejects other shapes and versions', () => {
    for (const bad of [null, [], 'x', { type: 'risuChat', ver: 1, data: chat() }, { type: 'risuChat', ver: '2', data: chat() }, { type: 'character', ver: 2, data: chat() }, { type: 'risuChat', ver: 2 }, { type: 'risuChat', ver: 2, data: [1] }]) {
      expect(parseRisuExport(bad)).toEqual({ ok: false, error: 'unsupported-format' });
    }
  });

  it('limits chats per file', () => {
    const many = Array.from({ length: IMPORT_LIMITS.chatsPerFile + 1 }, (_, i) => chat({ id: `c${i}` }));
    expect(parseRisuExport({ type: 'risuAllChats', ver: 2, data: many })).toEqual({ ok: false, error: 'too-many-chats' });
  });
});
