import { isTrackedAssetName } from '../../source/pocketrisu/refs.js';
import type { Block } from '../../shared/blocks.js';

// Block[] → XHTML (스펙 2.5 §2.3, page-design §3.5.5 의 순수 모듈). 원문 HTML 은 여기 들어오지 않는다 —
// 글자는 Block 텍스트를 이스케이프해서만 쓴다 (§4.3 성질 유지).

// XML 1.0 이 담을 수 없는 글자: C0 제어문자(탭·개행·CR 제외), U+FFFE/U+FFFF, 짝 없는 서로게이트.
// u 플래그 없이 UTF-16 코드 유닛 단위로 보므로 정상 쌍(😀 등)은 남는다.
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function esc(s: string): string {
  return s.replace(XML_BAD, '').replace(/[&<>"']/g, (c) => ENT[c]!);
}

export type RenderMessage = { role: 'user' | 'char'; blocks: Block[] };
/** 이미지 이름 → EPUB 안의 경로. 넣지 않을 그림이면 null. */
export type ImageHref = (assetName: string) => string | null;

function blockXhtml(b: Block, href: ImageHref): string {
  switch (b.kind) {
    case 'paragraph': return `<p>${esc(b.text)}</p>`;
    case 'dialogue': return `<p class="dialogue">${esc(b.text)}</p>`;
    case 'divider': return '<hr/>';
    case 'image': {
      const h = href(b.assetName);
      return h ? `<figure><img src="${esc(h)}" alt=""/></figure>` : '';
    }
  }
}

export function messageXhtml(m: RenderMessage, href: ImageHref): string {
  const inner = m.blocks.map((b) => blockXhtml(b, href)).join('');
  return inner ? `<div class="msg ${m.role}">${inner}</div>` : '';
}

const XHTML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko">';

export function xhtmlDoc(title: string, body: string): string {
  return `${XHTML_HEAD}<head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
}

export function chapterXhtml(title: string, body: string): string {
  return xhtmlDoc(title, `<section epub:type="chapter"><h2>${esc(title)}</h2>${body}</section>`);
}

/** 그림 토글 (X4): Asset Maid 생성 이름 = 채팅 속 그림, 나머지 = 본문 카드 그림. */
export function filterImages(blocks: Block[], opts: { cardImages: boolean; chatImages: boolean }): Block[] {
  return blocks.filter((b) => b.kind !== 'image' || (isTrackedAssetName(b.assetName) ? opts.chatImages : opts.cardImages));
}
