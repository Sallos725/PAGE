import { describe, expect, it } from 'vitest';
import { keptItems, splitShelves } from '../src/lib/library-view';
import type { Shelf, ShelfChat } from '../src/lib/types';

const chat = (chatId: string, msgCount: number, o: Partial<ShelfChat> = {}): ShelfChat =>
  ({ chatId, displayName: chatId, msgCount, lastError: null, lastDate: null, progress: null, readAt: null, deleted: false, keptAt: null, ...o });
const shelf = (charId: string, chats: ShelfChat[], deleted = false): Shelf =>
  ({ charId, displayName: charId, originalName: charId, chatCount: chats.length, imageUrl: null, deleted, chats });

describe('library view', () => {
  it('splits live characters (live chats only) from characters deleted in the source', () => {
    const s = [shelf('a', [chat('a1', 10), chat('a2', 5, { deleted: true })]), shelf('b', [chat('b1', 3, { deleted: true })], true)];
    const v = splitShelves(s);
    expect(v.live.map((x) => [x.charId, x.chats.map((c) => c.chatId)])).toEqual([['a', ['a1']]]);
    expect(v.gone.map((x) => [x.charId, x.chats.map((c) => c.chatId)])).toEqual([['b', ['b1']]]);
  });

  it('kept items: newest keep first, across characters, deleted included, each with its character range over all chats', () => {
    const s = [
      shelf('a', [chat('a1', 10, { keptAt: 5 }), chat('a2', 100, { deleted: true, keptAt: 9 }), chat('a3', 40)]),
      shelf('b', [chat('b1', 7, { keptAt: 7 })], true),
    ];
    expect(keptItems(s)).toEqual([
      { char: 'a', charName: 'a', chat: s[0]!.chats[1], range: { min: 10, max: 100 } },
      { char: 'b', charName: 'b', chat: s[1]!.chats[0], range: { min: 7, max: 7 } },
      { char: 'a', charName: 'a', chat: s[0]!.chats[0], range: { min: 10, max: 100 } },
    ]);
    expect(keptItems([shelf('a', [chat('a1', 1)])])).toEqual([]);
  });
  it('kept items fall back to the original name when the display name is empty', () => {
    const s: Shelf[] = [{ ...shelf('a', [chat('a1', 3, { keptAt: 1 })]), displayName: '', originalName: '원래 이름' }];
    expect(keptItems(s)[0]!.charName).toBe('원래 이름');
  });
});
