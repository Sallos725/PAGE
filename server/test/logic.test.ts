import { describe, expect, it } from 'vitest';
import { canon, sha256Hex } from '../src/canon.js';
import { classifyChat } from '../src/library/classify.js';
import { decideVersion } from '../src/library/decide.js';
import { planDeletions } from '../src/library/deletions.js';

describe('canon', () => {
  it('is key-order independent and content sensitive', () => {
    expect(sha256Hex(canon({ a: 1, b: [1, { c: 2, d: 3 }] }))).toBe(sha256Hex(canon({ b: [1, { d: 3, c: 2 }], a: 1 })));
    expect(canon({ a: 1 })).not.toBe(canon({ a: 2 }));
    expect(canon(new Uint8Array([1, 2]))).toBe('"b64:AQI="');
  });
});

describe('classifyChat', () => {
  it.each([
    [['a', 'b'], ['a', 'b'], 'unchanged'],
    [['a', 'b'], ['a', 'b', 'c'], 'appended'],
    [['a', 'b', 'c'], ['a', 'b'], 'truncated'],
    [['a', 'b'], ['a', 'X'], 'edited'],
    [['a', 'b'], ['X', 'a', 'b'], 'edited'],
    [null, ['a'], 'new'],
    [['a'], null, 'removed'],
    [[], ['a'], 'appended'],
    [[], [], 'unchanged'],
  ] as const)('%j → %j = %s', (prev, cur, want) => {
    expect(classifyChat(prev as string[] | null, cur as string[] | null)).toBe(want);
  });
});

describe('decideVersion (D17 provisional debounce)', () => {
  const base = { manifestHash: 'M', pendingFp: null, pendingSince: null, now: 1000, debounceMs: 600, force: false };
  it('new → initial immediately; edits/truncation → edited immediately (no data loss)', () => {
    expect(decideVersion({ ...base, kind: 'new' })).toEqual({ commit: 'initial', pending: null });
    expect(decideVersion({ ...base, kind: 'edited' })).toEqual({ commit: 'edited', pending: null });
    expect(decideVersion({ ...base, kind: 'truncated' })).toEqual({ commit: 'edited', pending: null });
  });
  it('unchanged clears pending', () => {
    expect(decideVersion({ ...base, kind: 'unchanged', pendingFp: 'M', pendingSince: 5 })).toEqual({ commit: null, pending: null });
  });
  it('append: first sighting starts pending; same fp after debounce commits; changed fp restarts', () => {
    expect(decideVersion({ ...base, kind: 'appended' })).toEqual({ commit: null, pending: { fp: 'M', since: 1000 } });
    expect(decideVersion({ ...base, kind: 'appended', pendingFp: 'M', pendingSince: 500, now: 1000 })).toEqual({ commit: null, pending: { fp: 'M', since: 500 } });
    expect(decideVersion({ ...base, kind: 'appended', pendingFp: 'M', pendingSince: 400, now: 1000 })).toEqual({ commit: 'appended', pending: null });
    expect(decideVersion({ ...base, kind: 'appended', pendingFp: 'OLD', pendingSince: 0, now: 1000 })).toEqual({ commit: null, pending: { fp: 'M', since: 1000 } });
  });
  it('force bypasses the debounce (chat-open sync)', () => {
    expect(decideVersion({ ...base, kind: 'appended', force: true })).toEqual({ commit: 'appended', pending: null });
  });
});

describe('planDeletions (R6)', () => {
  const known = ['c:1', 'h:1/a', 'h:1/b', 'c:2', 'h:2/z'];
  it('nothing missing → nothing to do', () => {
    expect(planDeletions({ known, seen: new Set(known), accept: false, ratio: 0.5 })).toEqual({ tombstone: [], held: false, missing: 0 });
  });
  it('minor loss is tombstoned', () => {
    const r = planDeletions({ known, seen: new Set(known.filter((k) => k !== 'h:1/b')), accept: false, ratio: 0.5 });
    expect(r).toEqual({ tombstone: ['h:1/b'], held: false, missing: 1 });
  });
  it('more than the ratio is held, not applied', () => {
    const seen = new Set(['c:2', 'h:2/z']); // 3 of 5 missing = 60%
    const r = planDeletions({ known, seen, accept: false, ratio: 0.5 });
    expect(r).toMatchObject({ tombstone: [], held: true, missing: 3 });
  });
  it('exactly at the ratio is not held; accept overrides the hold', () => {
    const half = ['a', 'b', 'c', 'd'];
    expect(planDeletions({ known: half, seen: new Set(['a', 'b']), accept: false, ratio: 0.5 }).held).toBe(false);
    const held = planDeletions({ known, seen: new Set(), accept: true, ratio: 0.5 });
    expect(held).toMatchObject({ held: false, missing: 5 });
    expect(held.tombstone).toHaveLength(5);
  });
});
