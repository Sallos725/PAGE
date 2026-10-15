import fs from 'node:fs';
import type { LibraryStore } from '../../library/store.js';
import { normalizeMessage } from '../../source/normalize.js';
import type { SourceKind } from '../../source/types.js';
import { splitWindow, WINDOW } from '../../shared/chapter-split.js';
import type { Block } from '../../shared/blocks.js';
import { parseBlocks } from '../../shared/parse.js';
import { checkRule } from '../../state/hide-rules.js';
import type { StateStore } from '../../state/store.js';
import type { ExportWarnings } from '../jobs.js';
import type { ChatVersion } from '../source.js';
import { parseHtml } from './html.js';
import { convertImage, isConvertible, type ImageMode } from './images.js';
import type { EpubImage } from './package.js';
import { filterImages } from './render.js';
import { transformInWorker, type TRule } from './transform.js';

// EPUB·PDF 공용 준비 과정: 원문 → 고른 규칙(워커) → 공유 파서 → 그림 토글 →
// (그림 이름 → 해시 → 변환 → 한도) → 챕터 나누기·제목 → 표지. 렌더는 소비자 몫이다.

export type EpubOptions = { includeUser: boolean; cover: boolean; cardImages: boolean; chatImages: boolean; hideRuleIds: string[]; imageRuleKeys: string[]; imageMode: ImageMode };
export const DEFAULT_EPUB_OPTIONS: EpubOptions = { includeUser: true, cover: true, cardImages: true, chatImages: true, hideRuleIds: [], imageRuleKeys: [], imageMode: 'small' };
export type EpubContext = {
  store: LibraryStore; state: StateStore; kind: SourceKind;
  source: string; charId: string; cv: ChatVersion;
  title: string; author: string; now: () => number;
  perRuleMs?: number; imageBudgetBytes?: number;
  /** 테스트에서만 쓴다: 그림 변환 함수 바꿔치기. */
  convert?: typeof convertImage;
};

const IMAGE_BUDGET = 300 * 1024 * 1024;
const YIELD_EVERY = 10;
const CONVERT_CONCURRENCY = 4;
const tick = () => new Promise<void>((r) => setImmediate(r));

function chosenRules(ctx: EpubContext, opts: EpubOptions): TRule[] {
  const hideIds = new Set(opts.hideRuleIds);
  const hide: TRule[] = [];
  for (const r of ctx.state.listHideRules(ctx.source, ctx.charId)) {
    if (!hideIds.has(r.id)) continue;
    const c = checkRule(r.name, r.pattern, r.flags);
    if (c.ok) hide.push({ kind: 'hide', name: r.name, pattern: r.pattern, flags: c.flags });
  }
  const keys = new Set(opts.imageRuleKeys);
  const slow = ctx.store.imageRulesSlow(ctx.source, ctx.charId);
  const meta = ctx.store.getCharMeta(ctx.source, ctx.charId);
  const metaRules = meta && Array.isArray(meta.imageRules) ? (meta.imageRules as { key: string; name: string; in: string; flag: string; images: string[] }[]) : [];
  const image: TRule[] = metaRules
    .filter((r) => keys.has(r.key) && !slow.has(r.key))
    .map((r) => ({ kind: 'image', name: r.name, pattern: r.in, flags: r.flag, images: r.images }));
  return [...hide, ...image];
}

type Parsed = { role: 'user' | 'char'; blocks: Block[] } | null;
type Fetched = { image: EpubImage } | 'missing' | 'skipped';

/** 메시지 하나의 파싱. 실패하면 그 메시지만 이스케이프한 한 문단으로 대체한다 (renderMessage 와 같은 규칙). */
function parseMessage(text: string, opts: Pick<EpubOptions, 'cardImages' | 'chatImages'>): Block[] {
  try {
    return filterImages(parseBlocks(text, parseHtml), opts);
  } catch {
    return [{ kind: 'paragraph', text }];
  }
}

/**
 * 해시별 그림 읽기·변환. 동시 CONVERT_CONCURRENCY 개, 결과는 첫 등장 순서대로 확정(한도는 변환 뒤 크기).
 * 미끄러지는 창: i 번째는 i - CONVERT_CONCURRENCY 번째가 확정된 뒤에야 시작하므로, 앞쪽 그림 하나가 느려도
 * 읽은 파일·변환 결과가 메모리에 최대 CONVERT_CONCURRENCY 개만 쌓인다.
 */
async function fetchImages(ctx: EpubContext, hashes: string[], mimes: Map<string, string>, mode: ImageMode, budget: number): Promise<Map<string, Fetched>> {
  const convert = ctx.convert ?? convertImage;
  const out = new Map<string, Fetched>();
  const raw: (EpubImage | 'missing' | 'skipped' | undefined)[] = new Array(hashes.length); // undefined = 아직 안 끝남
  let used = 0;
  let commit = 0;
  let waiters: (() => void)[] = [];
  const settle = () => {
    while (commit < hashes.length && raw[commit] !== undefined) {
      const hash = hashes[commit]!;
      const r = raw[commit]!;
      raw[commit] = 'skipped'; // 확정한 뒤에는 바이트를 붙잡지 않는다
      if (typeof r === 'string') out.set(hash, r);
      else if (used + r.bytes.length > budget) out.set(hash, 'skipped');
      else { used += r.bytes.length; out.set(hash, { image: r }); }
      commit++;
    }
    const w = waiters;
    waiters = [];
    for (const f of w) f(); // 창이 움직였다
  };
  let next = 0;
  const worker = async () => {
    for (let k = next++; k < hashes.length; k = next++) {
      while (k - CONVERT_CONCURRENCY >= commit) await new Promise<void>((r) => waiters.push(r));
      if (used >= budget) { raw[k] = 'skipped'; settle(); continue; } // 한도를 다 썼다 — 읽지도 변환하지도 않는다
      const hash = hashes[k]!;
      let bytes: Uint8Array;
      try {
        bytes = await fs.promises.readFile(ctx.store.blobPath(hash));
      } catch {
        raw[k] = 'missing'; // 파일이 사라진 그림
        settle();
        continue;
      }
      try {
        const c = await convert(bytes, mimes.get(hash)!, mode);
        raw[k] = c ? { id: `img-${hash.slice(0, 16)}`, href: `images/${hash.slice(0, 16)}.${c.ext}`, mime: c.mime, bytes: c.bytes } : 'skipped';
      } catch {
        raw[k] = 'skipped'; // 변환 실패 — 내용은 로그에 남기지 않는다
      }
      settle();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONVERT_CONCURRENCY, hashes.length) }, worker));
  return out;
}

export type PreparedMessage = { role: 'user' | 'char'; blocks: Block[] };
export type PreparedChapter = { title: string; messages: PreparedMessage[] };
export type PreparedBook = {
  /** 소비자가 메시지를 렌더한 뒤 `messages` 를 비워 메모리를 놓아 줄 수 있다. 제외된 사용자 메시지는 빠진다. */
  chapters: PreparedChapter[];
  /** 그림 이름 → 패키지 안 경로. 없거나 건너뛴 그림은 null. */
  hrefOf: (name: string) => string | null;
  images: EpubImage[];
  cover: EpubImage | null;
  warnings: ExportWarnings;
};

export async function prepareBook(ctx: EpubContext, opts: EpubOptions): Promise<PreparedBook> {
  const { store, source, charId } = ctx;
  const messages = store.getMsgJson(ctx.cv.hashes).map((j, i) => normalizeMessage(ctx.kind, JSON.parse(j), i));
  const rules = chosenRules(ctx, opts);
  const original = messages.map((m) => m.text);
  const { texts, slowRules } = rules.length ? await transformInWorker(original, rules, ctx.perRuleMs) : { texts: original, slowRules: [] };

  // 1단계: 메시지를 모두 파싱하고 그림 이름을 첫 등장 순서로 모은다.
  const parsed: Parsed[] = [];
  const names = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    if (i % YIELD_EVERY === 0) await tick(); // 큰 채팅에서도 서버를 오래 붙잡지 않는다
    const m = messages[i]!;
    if (m.role === 'user' && !opts.includeUser) { parsed.push(null); continue; }
    const blocks = parseMessage(texts[i]!, opts);
    for (const b of blocks) if (b.kind === 'image') names.add(b.assetName);
    parsed.push({ role: m.role, blocks });
  }

  // 2단계: 이름 → 해시(못 찾음·형식은 이름당 한 번 센다) → 해시 중복 제거 → 읽기·변환 → 한도.
  let missingImages = 0;
  let skippedImages = 0;
  const nameHash = new Map<string, string | null>();
  const mimes = new Map<string, string>();
  for (const name of names) {
    const hash = store.findAssetHash(source, charId, name);
    const info = hash ? store.assetInfo(hash) : null;
    if (!hash || !info) { missingImages++; nameHash.set(name, null); }
    else if (!isConvertible(info.mime)) { skippedImages++; nameHash.set(name, null); }
    else { nameHash.set(name, hash); mimes.set(hash, info.mime); }
  }
  const fetched = await fetchImages(ctx, [...mimes.keys()], mimes, opts.imageMode, ctx.imageBudgetBytes ?? IMAGE_BUDGET);
  const byName = new Map<string, string | null>();
  const used = new Map<string, EpubImage>();
  for (const [name, hash] of nameHash) {
    const f = hash ? fetched.get(hash)! : null;
    if (!hash) byName.set(name, null);
    else if (f === 'missing') { missingImages++; byName.set(name, null); }
    else if (f === 'skipped') { skippedImages++; byName.set(name, null); }
    else { used.set(hash, f!.image); byName.set(name, f!.image.href); }
  }
  const href = (name: string): string | null => byName.get(name) ?? null;

  // 3단계: 챕터 범위·제목.
  const chapters: PreparedChapter[] = [];
  for (let w = 0; w * WINDOW < messages.length; w++) {
    const lens = messages.slice(w * WINDOW, (w + 1) * WINDOW).map((m) => m.text.length);
    for (const range of splitWindow(w, lens)) {
      const msgs: PreparedMessage[] = [];
      for (let i = range.from; i < range.to; i++) {
        if (i % YIELD_EVERY === 0) await tick(); // 큰 채팅에서도 서버를 오래 붙잡지 않는다
        const p = parsed[i];
        parsed[i] = null; // 넘긴 메시지는 여기서 놓는다
        if (p) msgs.push(p);
      }
      const title = `${range.window + 1}장${range.part > 0 ? ' (이어서)' : ''}`; // 리더와 같은 이름
      chapters.push({ title, messages: msgs });
    }
  }

  // 표지: 같은 변환 함수. 파일이 없거나 변환에 실패하면 표지 없이 만든다.
  let cover: EpubImage | null = null;
  if (opts.cover) {
    const ci = store.getCharImage(source, charId);
    const info = ci?.hash ? store.assetInfo(ci.hash) : null;
    if (ci?.hash && info && isConvertible(info.mime)) {
      try {
        const c = await (ctx.convert ?? convertImage)(await fs.promises.readFile(store.blobPath(ci.hash)), info.mime, opts.imageMode);
        if (c) cover = { id: 'cover-image', href: `images/cover.${c.ext}`, mime: c.mime, bytes: c.bytes };
      } catch {
        cover = null; // 표지 파일이 없거나 변환에 실패하면 표지 없이 만든다
      }
    }
  }

  return { chapters, hrefOf: href, images: [...used.values()], cover, warnings: { missingImages, skippedImages, slowRules } };
}
