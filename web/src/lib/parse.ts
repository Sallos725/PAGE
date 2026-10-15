import { parseBlocks } from '../../../server/src/shared/parse';
import type { Block } from './blocks';

// 스펙 4.3 — 메시지 원문은 신뢰하지 않는 입력이다. DOMParser 로 *비활성 문서*에 파싱한다(스크립트 실행·리소스 로딩 없음).
// 파서 본체는 서버와 같은 소스(server/src/shared/parse.ts)이고, 여기서는 브라우저 DOM 만 넣어 준다.
export function parseMessage(text: string): Block[] {
  return parseBlocks(text, (html) => new DOMParser().parseFromString(html, 'text/html'));
}
