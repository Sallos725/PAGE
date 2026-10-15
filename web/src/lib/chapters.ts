import { CHAPTER_CHAR_CAP, WINDOW, splitWindow, type ChapterRange } from '../../../server/src/shared/chapter-split';
export { CHAPTER_CHAR_CAP, WINDOW, splitWindow, type ChapterRange };
import { blockText, type Block } from './blocks';
import { parseMessage } from './parse';
import { anchorOf } from './position';
import type { MessagesPage, PageMessage, ReadingPosition } from './types';

export type ParsedMessage = { idx: number; role: 'user' | 'char'; text: string; time?: number; blocks: Block[] };
export type Chapter = { id: string; range: ChapterRange; messages: ParsedMessage[] };
export type FetchPage = (from: number, limit: number, version?: number) => Promise<MessagesPage>;

/** 보기 옵션: 파싱 전에 원문을 바꾸는 함수(숨김 규칙)와 user 메시지 빼기. 챕터 경계·total 은 원문 기준 그대로. */
export type ChapterView = { transform?: (text: string) => string; hideUser?: boolean };

/** 위치가 보이지 않는 메시지를 가리키면 다음(없으면 마지막) 보이는 메시지의 시작으로 (스펙 §5.4). */
export function snapToVisible(pos: ReadingPosition, visible: ParsedMessage[]): ReadingPosition {
  if (visible.length === 0 || visible.some((m) => m.idx === pos.msgIdx)) return pos;
  const next = visible.find((m) => m.idx > pos.msgIdx) ?? visible[visible.length - 1]!;
  const t = next.blocks[0] ? blockText(next.blocks[0]) : '';
  return { msgIdx: next.idx, blockIdx: 0, charOffset: 0, anchorHash: anchorOf(t, 0) };
}

export const windowOf = (idx: number): number => Math.floor(idx / WINDOW);

type Win = { ranges: ChapterRange[]; messages: PageMessage[] };

export class ChapterLoader {
  /** 첫 창을 가져오기 전엔 -1 */
  total = -1;
  private version: number | undefined;
  /** 첫 응답에서 고정한 라이브러리 버전 (내보내기가 화면과 같은 버전을 쓰게 한다). */
  get pinnedVersion(): number | undefined { return this.version; }
  private readonly wins = new Map<number, Promise<Win>>();
  private readonly built = new Map<string, Chapter>();
  private readonly raw = new Map<number, PageMessage[]>(); // 받은 창의 원문 (시험 실행용)
  private view: ChapterView = {};

  constructor(private readonly fetchPage: FetchPage, private readonly cap: number = CHAPTER_CHAR_CAP) {}

  /** 보기 옵션을 바꾼다. 만든 챕터만 버리고 받아 둔 창은 그대로 쓴다. */
  setView(v: ChapterView) {
    this.view = v;
    this.built.clear();
  }

  /** 지금 받아 둔 메시지들의 원문 (숨김 규칙 시험 실행 범위). */
  loadedTexts(): string[] {
    return [...this.raw.values()].flat().map((m) => m.text);
  }

  private window(w: number): Promise<Win> {
    let p = this.wins.get(w);
    if (!p) {
      p = this.fetchPage(w * WINDOW, WINDOW, this.version).then((page) => {
        this.total = page.total;
        this.version ??= page.version; // 첫 응답의 라이브러리 버전에 고정 → 읽는 도중 일관성
        this.raw.set(w, page.messages);
        return { ranges: splitWindow(w, page.messages.map((m) => m.text.length), this.cap), messages: page.messages };
      });
      p.catch(() => this.wins.delete(w)); // 실패는 캐시하지 않는다
      this.wins.set(w, p);
      this.evict(w);
    }
    return p;
  }

  /** 현재 창에서 멀리 떨어진 창과 거기서 만든 챕터를 버려 메모리를 묶어 둔다. */
  private evict(keep: number) {
    while (this.wins.size > 6) {
      const far = [...this.wins.keys()].find((k) => Math.abs(k - keep) > 2);
      if (far === undefined) break;
      this.wins.delete(far);
      this.raw.delete(far);
      for (const key of [...this.built.keys()]) if (key.startsWith(`${far}.`)) this.built.delete(key);
    }
  }

  private build(w: number, win: Win, range: ChapterRange): Chapter {
    const key = `${w}.${range.part}`;
    let c = this.built.get(key);
    if (!c) {
      const slice = win.messages.slice(range.from - w * WINDOW, range.to - w * WINDOW);
      c = {
        id: key,
        range,
        messages: slice
          .filter((m) => !(this.view.hideUser && m.role === 'user'))
          .map((m) => {
            const src = this.view.transform ? this.view.transform(m.text) : m.text;
            const pm: ParsedMessage = { idx: m.idx, role: m.role, text: m.text, blocks: parseMessage(src) };
            if (m.time !== undefined) pm.time = m.time;
            return pm;
          }),
      };
      this.built.set(key, c);
    }
    return c;
  }

  async chapterAt(idx: number): Promise<Chapter | null> {
    let at = Math.max(0, idx);
    let w = windowOf(at);
    let win = await this.window(w);
    if (win.messages.length === 0) {
      if (this.total <= 0) return null; // 빈 채팅
      at = this.total - 1; // 메시지가 줄어 저장된 인덱스가 범위를 벗어남
      w = windowOf(at);
      win = await this.window(w);
    }
    const range = win.ranges.find((r) => at >= r.from && at < r.to) ?? win.ranges[win.ranges.length - 1];
    return range ? this.build(w, win, range) : null;
  }

  async next(c: Chapter): Promise<Chapter | null> {
    const w = c.range.window;
    const win = await this.window(w);
    const nxt = win.ranges[c.range.part + 1];
    if (nxt) return this.build(w, win, nxt);
    if ((w + 1) * WINDOW >= this.total) return null;
    const nwin = await this.window(w + 1);
    const r = nwin.ranges[0];
    return r ? this.build(w + 1, nwin, r) : null;
  }

  async prev(c: Chapter): Promise<Chapter | null> {
    const w = c.range.window;
    if (c.range.part > 0) {
      const win = await this.window(w);
      const r = win.ranges[c.range.part - 1];
      return r ? this.build(w, win, r) : null;
    }
    if (w === 0) return null;
    const pwin = await this.window(w - 1);
    const r = pwin.ranges[pwin.ranges.length - 1];
    return r ? this.build(w - 1, pwin, r) : null;
  }
}
