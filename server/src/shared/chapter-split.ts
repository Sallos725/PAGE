// 챕터 나누기 (스펙 4.2). 웹 리더와 EPUB 이 같이 쓴다.
export const WINDOW = 40; // 챕터 = 메시지 ~40개
export const CHAPTER_CHAR_CAP = 24_000; // 또는 누적 글자 수 상한 (먼저 오는 쪽)

export type ChapterRange = { window: number; part: number; from: number; to: number }; // [from, to) 절대 메시지 인덱스

/**
 * 40개 단위로 정렬된 창을 기본 챕터로 하고, 창의 글자 합이 상한을 넘으면 그 창 안에서 메시지 경계로만 나눈다.
 * 경계가 창 내용만으로 결정되므로 어느 위치로 진입해도 같은 챕터가 나온다 (계획 결정 2).
 * 단일 메시지가 상한을 넘어도 나누지 않는다 (v1 한계).
 */
export function splitWindow(w: number, lengths: number[], cap: number = CHAPTER_CHAR_CAP): ChapterRange[] {
  const base = w * WINDOW;
  const out: ChapterRange[] = [];
  let start = 0;
  let sum = 0;
  lengths.forEach((len, i) => {
    if (i > start && sum + len > cap) {
      out.push({ window: w, part: out.length, from: base + start, to: base + i });
      start = i;
      sum = 0;
    }
    sum += len;
  });
  if (lengths.length > 0) out.push({ window: w, part: out.length, from: base + start, to: base + lengths.length });
  return out;
}
