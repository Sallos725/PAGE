import type { Block } from './blocks.js';

// 스펙 4.3 — 메시지 원문은 신뢰하지 않는 입력이다. 주입된 DOM(웹: DOMParser, 서버: linkedom)으로 *비활성 문서*에 파싱하고(스크립트 실행·리소스 로딩 없음),
// 허용 목록으로 Block 데이터만 뽑는다. 원문 HTML 은 어떤 경로로도 라이브 DOM 에 들어가지 않는다.

/** 비활성 문서를 만드는 함수 (웹: DOMParser, 서버: linkedom). 스크립트를 실행하거나 리소스를 불러오지 않아야 한다. */
export type ParseHtml = (html: string) => { body: Node | null };

const SKIP_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'link', 'meta', 'title',
  'svg', 'math', 'form', 'select', 'textarea', 'audio', 'video', 'canvas', 'base', 'frame',
  'xmp', 'noembed', 'noframes', 'plaintext',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'blockquote', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'tr',
  'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd',
]);
// 중첩이 이보다 깊으면 재귀를 멈추고 글자만 이어 붙인다 (브라우저 파서도 깊이를 제한한다 — 스택 오버플로로 내보내기 전체가 실패하는 것을 막는다).
const MAX_DEPTH = 512;
const RAW_MARKER = /\{\{raw::([^}\n]{1,300}?)\}\}/g;
const RAW_SRC = /^\{\{raw::([^}\n]{1,300})\}\}$/;

const QUOTE_PAIRS: Record<string, string> = { '"': '"', '“': '”', '「': '」', '『': '』' };

function isDialogue(t: string): boolean {
  if (t.length < 2) return false;
  const open = t[0]!;
  const close = QUOTE_PAIRS[open];
  if (!close || t[t.length - 1] !== close) return false;
  const count = (c: string) => t.split(c).length - 1;
  // 같은 따옴표(")는 정확히 2개, 짝이 다른 따옴표는 각각 1개 — "A," 그가 말했다. "B." 같은 혼합 문단을 제외한다.
  return open === close ? count(open) === 2 : count(open) === 1 && count(close) === 1;
}

function addParagraphs(out: Block[], s: string) {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) out.push({ kind: isDialogue(t) ? 'dialogue' : 'paragraph', text: t });
  }
}

/** 버퍼 텍스트를 문단으로 나누되, `{{raw::NAME}}` 는 이미지 블록으로 해석한다. */
function pushText(out: Block[], raw: string) {
  let last = 0;
  for (const m of raw.matchAll(RAW_MARKER)) {
    const at = m.index ?? 0;
    addParagraphs(out, raw.slice(last, at));
    out.push({ kind: 'image', assetName: (m[1] ?? '').trim() });
    last = at + m[0].length;
  }
  addParagraphs(out, raw.slice(last));
}

const num = (v: string | null): number | undefined => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase().includes('display:none')) return true;
  return /(^|\s)am-illustration-history-(sources|bank)(\s|$)/.test(el.getAttribute('class') ?? '');
}

/** `data-am-asset` 이거나 src 가 정확히 `{{raw::NAME}}` 인 이미지만 인정한다. 외부/알 수 없는 src 는 버린다. */
function imageOf(el: Element): Block | null {
  const m = RAW_SRC.exec((el.getAttribute('src') ?? '').trim());
  const name = (el.getAttribute('data-am-asset') ?? m?.[1] ?? '').trim();
  if (!name) return null;
  const b: Block = { kind: 'image', assetName: name };
  const w = num(el.getAttribute('width'));
  const h = num(el.getAttribute('height'));
  if (w !== undefined) b.width = w;
  if (h !== undefined) b.height = h;
  return b;
}

function projectionImage(div: Element): Block | null {
  const img = div.querySelector('img.am-image__media') ?? div.querySelector('img[data-am-asset]:not(.am-illustration-history-source)');
  const block = img ? imageOf(img) : null;
  if (!block || block.kind !== 'image') return null;
  const slot = div.getAttribute('data-am-slot-id');
  const rev = div.getAttribute('data-am-chat-history-revision-id');
  if (slot) block.slotId = slot;
  if (rev) block.revisionId = rev;
  return block;
}

/** 깊이 제한을 넘은 가지의 글자만 모은다 — 건너뛸 태그·숨김 요소는 빼고, 재귀 없이 명시적 스택으로 돈다. */
function visibleText(root: Element): string {
  let s = '';
  const stack: Node[] = Array.from(root.childNodes).reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.nodeType === 3) { s += n.nodeValue ?? ''; continue; }
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    const t = e.tagName.toLowerCase();
    if (SKIP_TAGS.has(t) || isHidden(e)) continue;
    if (t === 'br') { s += '\n'; continue; }
    const kids = e.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return s;
}

export function parseBlocks(text: string, parseHtml: ParseHtml): Block[] {
  // HTML 토크나이저 규칙: `<` 뒤가 영문자·`/`·`!`·`?` 가 아니면 태그가 아니라 글자다. 브라우저와 테스트 DOM(happy-dom·linkedom)이 어긋나지 않게 먼저 이스케이프한다.
  // CR/CRLF 는 HTML 전처리가 LF 로 바꾼다 (브라우저에서는 no-op). 서버 DOM 도 같게 먼저 맞춘다.
  const doc = parseHtml(text.replace(/\r\n?/g, '\n').replace(/<(?![A-Za-z/!?])/g, '&lt;'));
  const out: Block[] = [];
  let buf = '';
  const flush = () => {
    if (buf) pushText(out, buf);
    buf = '';
  };

  const walk = (node: Node, depth: number) => {
    if (node.nodeType === 3) { buf += node.nodeValue ?? ''; return; } // text
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || isHidden(el)) return;
    if (depth > MAX_DEPTH) { buf += visibleText(el); return; }
    if (tag === 'br') { buf += '\n'; return; }
    if (tag === 'hr') { flush(); out.push({ kind: 'divider' }); return; }
    if (tag === 'img') {
      flush();
      const b = imageOf(el);
      if (b) out.push(b);
      return;
    }
    if (el.classList.contains('am-illustration-projection')) {
      flush();
      const b = projectionImage(el);
      if (b) out.push(b);
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    for (const child of Array.from(el.childNodes)) walk(child, depth + 1);
    if (isBlock) flush();
  };

  if (doc.body) walk(doc.body, 0);
  flush();
  return out;
}
