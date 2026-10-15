import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { parseBlocks, type ParseHtml } from '../../shared/parse.js';
import type { ExportWarnings } from '../jobs.js';
import { parseHtml } from './html.js';
import { buildEpub } from './package.js';
import { prepareBook, type EpubContext, type EpubOptions } from './prepare.js';
import { chapterXhtml, filterImages, messageXhtml, type ImageHref } from './render.js';

// EPUB 파이프라인 (스펙 2.5 §2.3, X8): prepareBook(준비, EPUB·PDF 공용) → XHTML 렌더 → 패키지.
export { DEFAULT_EPUB_OPTIONS, type EpubContext, type EpubOptions } from './prepare.js';

const YIELD_EVERY = 10;
const tick = () => new Promise<void>((r) => setImmediate(r));

/** 메시지 하나의 파싱·렌더. 실패하면 그 메시지만 이스케이프한 한 문단으로 대체한다 (내용은 로그·오류에 넣지 않는다). */
export function renderMessage(role: 'user' | 'char', text: string, opts: Pick<EpubOptions, 'cardImages' | 'chatImages'>, href: ImageHref, parse: ParseHtml = parseHtml): string {
  try {
    return messageXhtml({ role, blocks: filterImages(parseBlocks(text, parse), opts) }, href);
  } catch {
    return messageXhtml({ role, blocks: [{ kind: 'paragraph', text }] }, href);
  }
}

export async function produceEpub(ctx: EpubContext, opts: EpubOptions, tmpFile: string): Promise<{ warnings: ExportWarnings }> {
  const book = await prepareBook(ctx, opts);
  const chapters: { title: string; xhtml: string }[] = [];
  let n = 0;
  for (const ch of book.chapters) {
    let body = '';
    for (const m of ch.messages) {
      if (n++ % YIELD_EVERY === 0) await tick(); // 큰 채팅에서도 서버를 오래 붙잡지 않는다
      body += messageXhtml(m, book.hrefOf);
    }
    ch.messages.length = 0; // 그린 메시지는 놓아 준다
    chapters.push({ title: ch.title, xhtml: chapterXhtml(ch.title, body) });
  }
  const bytes = await buildEpub({
    id: randomUUID(), title: ctx.title, author: ctx.author,
    modified: new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    chapters, images: book.images, cover: book.cover,
  });
  await fs.promises.writeFile(tmpFile, bytes);
  return { warnings: book.warnings };
}
