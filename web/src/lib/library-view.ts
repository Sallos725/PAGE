import { spineRange, type SpineRange } from './spines';
import type { Shelf, ShelfChat } from './types';

// 서고 구역 (스펙 3D §3): 서가 = 살아 있는 캐릭터의 살아 있는 채팅, 아래 칸 = 원본에서 지워진 캐릭터.
export function splitShelves(shelves: Shelf[]): { live: Shelf[]; gone: Shelf[] } {
  return {
    live: shelves.filter((s) => !s.deleted).map((s) => ({ ...s, chats: s.chats.filter((c) => !c.deleted) })),
    gone: shelves.filter((s) => s.deleted),
  };
}

export type KeptItem = { char: string; charName: string; chat: ShelfChat; range: SpineRange | null };

/** 보관함: 보관한 순서 최신 먼저. 책등 높이는 그 캐릭터의 전체 채팅(지워진 것 포함) 기준. */
export function keptItems(shelves: Shelf[]): KeptItem[] {
  const out: (KeptItem & { at: number })[] = [];
  for (const s of shelves) {
    const range = spineRange(s.chats);
    const charName = s.displayName || s.originalName;
    for (const c of s.chats) if (c.keptAt !== null) out.push({ char: s.charId, charName, chat: c, range, at: c.keptAt });
  }
  return out.sort((a, b) => b.at - a.at).map((x) => ({ char: x.char, charName: x.charName, chat: x.chat, range: x.range }));
}
