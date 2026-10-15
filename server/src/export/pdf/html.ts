import { strToU8, zip, type Zippable } from 'fflate';
import { ExportError } from '../jobs.js';
import type { PreparedBook } from '../epub/prepare.js';
import { esc, messageXhtml } from '../epub/render.js';

// PDF 용 HTML 묶음 (스펙 2.5c §2·§3): index.html + images/*. 사이드카(pdf/src/bundle.mjs)가 받는 이름은
// 정확히 이 두 가지뿐이다. 폰트(fonts/MaruBuri-*.woff2)는 사이드카가 index.html 옆에 넣어 준다.
// 마크업은 EPUB 의 messageXhtml 과 같다 (`<hr/>`·`<img …/>` 는 HTML5 에서도 유효).

/** 사이드카 bundle.mjs 의 허용 이름 중 images/ 아래 부분과 같은 규칙. */
const IMAGE_PATH = /^images\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

const CSS = `@font-face { font-family: "MaruBuri"; src: url("fonts/MaruBuri-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; }
@font-face { font-family: "MaruBuri"; src: url("fonts/MaruBuri-SemiBold.woff2") format("woff2"); font-weight: 600; font-style: normal; }
body { font-family: "MaruBuri", serif; font-size: 10.5pt; line-height: 1.75; word-break: keep-all; overflow-wrap: anywhere; orphans: 2; widows: 2; margin: 0; }
h1 { font-size: 14pt; text-align: center; margin: 0 0 1.2em; }
p { margin: 0 0 0.8em; }
p.dialogue { margin-left: 0.5em; }
.msg { margin: 0 0 1.4em; }
.msg.user { color: #555; font-style: italic; border-left: 2px solid #ccc; padding-left: 0.8em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; max-height: 160mm; break-inside: avoid; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 20%; }
section.cover { text-align: center; }
section.cover img { max-width: 100%; max-height: 135mm; margin: 0 0 1.5em; }
section.cover h1 { font-size: 20pt; }
section.cover p.author { margin: 0; color: #555; }
section.chapter { break-before: page; }
`;

const YIELD_EVERY = 10;
const tick = () => new Promise<void>((r) => setImmediate(r));

function checked(href: string): string {
  if (!IMAGE_PATH.test(href)) throw new ExportError('pdf-failed'); // 코드만 — 이름·내용은 넣지 않는다
  return href;
}

/**
 * 준비된 책 → zip 묶음. 그림은 이미 압축된 형식이라 저장만(level 0), HTML 은 deflate. 렌더 중 10개 메시지마다 이벤트 루프를 양보한다.
 * 렌더한 장의 `messages` 는 비워서 메모리를 놓아 준다 (produceEpub 과 같다) — 한 번만 부를 수 있다.
 */
export async function buildPdfBundle(book: PreparedBook, meta: { title: string; author: string }): Promise<Uint8Array> {
  const parts: string[] = [];
  const cover = book.cover ? `<img src="${esc(checked(book.cover.href))}" alt="">` : '';
  parts.push(`<section class="cover">${cover}<h1>${esc(meta.title)}</h1><p class="author">${esc(meta.author)}</p></section>`);
  let n = 0;
  for (const ch of book.chapters) {
    let body = '';
    for (const m of ch.messages) {
      if (n++ % YIELD_EVERY === 0) await tick(); // 큰 채팅에서도 서버를 오래 붙잡지 않는다
      body += messageXhtml(m, book.hrefOf);
    }
    ch.messages.length = 0;
    parts.push(`<section class="chapter"><h1>${esc(ch.title)}</h1>${body}</section>`);
  }
  const html = `<!DOCTYPE html>\n<html lang="ko"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>\n${CSS}</style></head><body>${parts.join('')}</body></html>`;

  const files: Zippable = { 'index.html': [strToU8(html), { level: 6 }] };
  for (const im of [...book.images, ...(book.cover ? [book.cover] : [])]) files[checked(im.href)] = [im.bytes, { level: 0 }];
  // 비동기 zip: 압축을 워커 스레드에서 해 이벤트 루프를 막지 않는다.
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))));
}
