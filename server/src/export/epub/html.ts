import { DOMParser } from 'linkedom';
import type { ParseHtml } from '../../shared/parse.js';

// 서버의 비활성 문서 (스펙 2.5 X6). linkedom 은 스크립트를 실행하지 않고 리소스도 불러오지 않는다.
// 조각만 주면 문서가 생기지 않아 html/body 로 감싼다. 글자 그대로의 </body>·</html> 은 브라우저처럼 무시되도록
// 먼저 지운다 (그대로 두면 linkedom 이 거기서 문서를 끝내 뒷부분이 사라진다 — 계획 작성 때 확인).
const parser = new DOMParser();
const STRAY_END = /<\/(?:body|html)(?=[\s/>])[^>]*>/gi;

export const parseHtml: ParseHtml = (html) =>
  parser.parseFromString(`<!doctype html><html><head></head><body>${html.replace(STRAY_END, '')}</body></html>`, 'text/html') as unknown as { body: Node | null };
