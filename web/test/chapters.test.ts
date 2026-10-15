import { describe, expect, it, vi } from 'vitest';
import { CHAPTER_CHAR_CAP, ChapterLoader, WINDOW, snapToVisible, splitWindow, windowOf } from '../src/lib/chapters';
import { anchorOf } from '../src/lib/position';
import type { MessagesPage, PageMessage } from '../src/lib/types';

describe('splitWindow', () => {
  it('keeps a window whole when under the cap', () => {
    expect(splitWindow(2, [10, 10, 10], 100)).toEqual([{ window: 2, part: 0, from: 80, to: 83 }]);
  });
  it('splits at message boundaries when the cap is exceeded', () => {
    expect(splitWindow(0, [60, 60, 60, 60], 100)).toEqual([
      { window: 0, part: 0, from: 0, to: 1 },
      { window: 0, part: 1, from: 1, to: 2 },
      { window: 0, part: 2, from: 2, to: 3 },
      { window: 0, part: 3, from: 3, to: 4 },
    ]);
    expect(splitWindow(0, [40, 40, 40, 40, 40], 100).map((r) => [r.from, r.to])).toEqual([[0, 2], [2, 4], [4, 5]]);
  });
  it('never splits a single oversized message (v1 limitation) and handles empty windows', () => {
    expect(splitWindow(0, [500, 5], 100).map((r) => [r.from, r.to])).toEqual([[0, 1], [1, 2]]);
    expect(splitWindow(0, [], 100)).toEqual([]);
  });
  it('windows are fixed 40-message slots', () => {
    expect(WINDOW).toBe(40);
    expect([windowOf(0), windowOf(39), windowOf(40), windowOf(125)]).toEqual([0, 0, 1, 3]);
    expect(CHAPTER_CHAR_CAP).toBeGreaterThan(1000);
  });
});

function fakeServer(total: number, len = 10) {
  const all: PageMessage[] = Array.from({ length: total }, (_, i) => ({ idx: i, role: i % 2 ? 'char' : 'user', text: `m${i}`.padEnd(len, 'x') }));
  const calls: { from: number; limit: number; version?: number }[] = [];
  const fetchPage = vi.fn(async (from: number, limit: number, version?: number): Promise<MessagesPage> => {
    calls.push({ from, limit, version });
    return { total, from, version: 7, messages: all.slice(from, from + limit) };
  });
  return { fetchPage, calls };
}

describe('ChapterLoader', () => {
  it('chapterAt loads only the window containing the index and parses blocks', async () => {
    const s = fakeServer(130);
    const l = new ChapterLoader(s.fetchPage);
    const c = (await l.chapterAt(85))!;
    expect(c.range).toMatchObject({ window: 2, from: 80, to: 120 });
    expect(c.messages).toHaveLength(40);
    expect(c.messages[5]).toMatchObject({ idx: 85, blocks: [{ kind: 'paragraph' }] });
    expect(s.calls).toEqual([{ from: 80, limit: 40, version: undefined }]);
    expect(l.total).toBe(130);
  });

  it('pins the library version after the first fetch so later windows are consistent', async () => {
    const s = fakeServer(130);
    const l = new ChapterLoader(s.fetchPage);
    const c = (await l.chapterAt(5))!;
    await l.next(c);
    expect(s.calls.map((x) => x.version)).toEqual([undefined, 7]);
  });

  it('next/prev walk windows in order and stop at the ends (last window is short)', async () => {
    const l = new ChapterLoader(fakeServer(130).fetchPage);
    let c = (await l.chapterAt(0))!;
    const seen = [c.range.from];
    for (let n = await l.next(c); n; n = await l.next(c)) { c = n; seen.push(c.range.from); }
    expect(seen).toEqual([0, 40, 80, 120]);
    expect(c.messages).toHaveLength(10);
    const back = [c.range.from];
    for (let p = await l.prev(c); p; p = await l.prev(c)) { c = p; back.push(c.range.from); }
    expect(back).toEqual([120, 80, 40, 0]);
  });

  it('walks sub-chapters inside an oversized window and across window boundaries', async () => {
    const l = new ChapterLoader(fakeServer(80, 60).fetchPage, 1000); // 한 메시지 60자 × 40 = 2400 > 1000
    const first = (await l.chapterAt(0))!;
    expect(first.range).toMatchObject({ window: 0, part: 0, from: 0 });
    expect(first.range.to).toBeLessThan(40);
    const second = (await l.next(first))!;
    expect(second.range).toMatchObject({ window: 0, part: 1, from: first.range.to });
    expect((await l.prev(second))!.id).toBe(first.id);
    // 임의 위치로 진입해도 같은 경계가 나온다 (결정적)
    const mid = (await l.chapterAt(second.range.from + 1))!;
    expect(mid.id).toBe(second.id);
  });

  it('clamps an index past the end (messages were removed) to the last message', async () => {
    const l = new ChapterLoader(fakeServer(45).fetchPage);
    const c = (await l.chapterAt(500))!;
    expect(c.range).toMatchObject({ window: 1, from: 40, to: 45 });
  });

  it('an empty chat has no chapters', async () => {
    const l = new ChapterLoader(fakeServer(0).fetchPage);
    expect(await l.chapterAt(0)).toBeNull();
  });

  it('caches windows and built chapters', async () => {
    const s = fakeServer(130);
    const l = new ChapterLoader(s.fetchPage);
    const a = (await l.chapterAt(3))!;
    const b = (await l.chapterAt(4))!;
    expect(a).toBe(b);
    expect(s.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch is not cached', async () => {
    let fail = true;
    const l = new ChapterLoader(async (from, limit) => {
      if (fail) { fail = false; throw new Error('net'); }
      return { total: 3, from, version: 1, messages: [{ idx: 0, role: 'user' as const, text: 'a' }].slice(0, limit) };
    });
    await expect(l.chapterAt(0)).rejects.toThrow('net');
    expect(await l.chapterAt(0)).not.toBeNull();
  });
});

describe('ChapterLoader views', () => {
  it('transform rewrites only the parsed blocks; text stays original (raw view)', async () => {
    const l = new ChapterLoader(fakeServer(10).fetchPage);
    l.setView({ transform: (t) => t.replace(/\d+/g, '#') });
    const c = (await l.chapterAt(3))!;
    const m = c.messages.find((x) => x.idx === 3)!;
    expect(JSON.stringify(m.blocks)).not.toMatch(/\d/);
    expect(m.text).toMatch(/\d/);
  });

  it('hideUser leaves user messages out; ranges and total stay the same', async () => {
    const l = new ChapterLoader(fakeServer(10).fetchPage);
    const all = (await l.chapterAt(0))!;
    l.setView({ hideUser: true });
    const c = (await l.chapterAt(0))!;
    expect(c.range).toEqual(all.range);
    expect(c.messages.every((m) => m.role !== 'user')).toBe(true);
    expect(c.messages.length).toBe(all.messages.filter((m) => m.role !== 'user').length);
    expect(l.total).toBe(10);
  });

  it('setView invalidates built chapters but not fetched windows', async () => {
    const s = fakeServer(10);
    const l = new ChapterLoader(s.fetchPage);
    await l.chapterAt(0);
    const calls = s.calls.length;
    l.setView({ hideUser: true });
    await l.chapterAt(0);
    expect(s.calls.length).toBe(calls);
  });

  it('loadedTexts returns raw texts of fetched windows', async () => {
    const l = new ChapterLoader(fakeServer(10).fetchPage);
    expect(l.loadedTexts()).toEqual([]);
    await l.chapterAt(0);
    expect(l.loadedTexts()).toHaveLength(10);
  });
});

describe('snapToVisible', () => {
  const pm = (idx: number, text: string) => ({ idx, role: 'char' as const, text, blocks: [{ kind: 'paragraph' as const, text }] });
  const pos = (msgIdx: number) => ({ msgIdx, blockIdx: 1, charOffset: 4, anchorHash: 'x' });
  it('keeps a visible position', () => {
    expect(snapToVisible(pos(3), [pm(1, 'a'), pm(3, 'b')])).toEqual(pos(3));
  });
  it('moves a hidden position to the start of the next visible message, else the last one', () => {
    expect(snapToVisible(pos(2), [pm(1, '하나'), pm(3, '셋')])).toEqual({ msgIdx: 3, blockIdx: 0, charOffset: 0, anchorHash: anchorOf('셋', 0) });
    expect(snapToVisible(pos(8), [pm(1, '하나'), pm(3, '셋')])).toEqual({ msgIdx: 3, blockIdx: 0, charOffset: 0, anchorHash: anchorOf('셋', 0) });
  });
  it('leaves the position alone when nothing is visible', () => {
    expect(snapToVisible(pos(2), [])).toEqual(pos(2));
  });
});

describe('ChapterLoader pinned version', () => {
  it('exposes the version pinned from the first page', async () => {
    const s = fakeServer(5);
    const loader = new ChapterLoader(s.fetchPage);
    expect(loader.pinnedVersion).toBeUndefined();
    await loader.chapterAt(0);
    expect(loader.pinnedVersion).toBe(7);
  });
});
