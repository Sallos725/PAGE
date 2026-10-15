// 커스텀 테마의 공식 손잡이와 Default 템플릿 (스펙 2.4–2.5). LIGHT_TOKENS 는 tokens.css 밝게 블록과 같아야 한다 (테스트가 비교).

/** 업데이트해도 유지하는 이름표. [이름, 설명] */
export const THEME_PARTS = [
  ['app-header', '서고·캐릭터 화면 머리'],
  ['desk', '이어 읽기 책상'],
  ['kept-shelf', '보관함'],
  ['shelf', '서가 (책등 줄)'],
  ['shelf-label', '서가 이름표'],
  ['spine', '책등'],
  ['chat-list', '채팅 목록 화면'],
  ['reader-bar', '리더 머리'],
  ['reader-scroll', '리더 본문 (스크롤)'],
  ['reader-book', '리더 본문 (책)'],
  ['message', '메시지 — data-role="user" | "char" 로 나뉜다'],
  ['panel', '패널 (보기 설정·책갈피·숨김 규칙·내보내기)'],
  ['appearance', '테마·글꼴 화면'],
  ['highlights', '형광펜 모아 보기 화면'],
  ['safe-banner', '안전 모드 띠'],
] as const;

export const LIGHT_TOKENS: Record<string, string> = {
  '--bg': '#f3f1ec', '--fg': '#24221e', '--muted': '#5c574e', '--ink-faint': '#6a645a', '--line': '#d8d4ca', '--rule-strong': '#857f73',
  '--accent': '#2b6860', '--on-accent': '#f6f4ef', '--accent-wash': '#dde8e3',
  '--surface-raised': '#faf9f6', '--surface-sunken': '#e9e6df', '--surface-strong': '#2d2a25', '--bubble': '#e9e6df',
  '--hl-yellow': '#efe0a6', '--hl-green': '#cfe3c6', '--hl-blue': '#c9dbe8', '--hl-pink': '#ecd0d6',
  '--shadow-overlay': '0 8px 24px rgb(36 34 30 / 14%)',
};

const READER_VARS = ['--reader-font', '--reader-size', '--reader-lh', '--reader-para', '--reader-width', '--reader-align', '--reader-indent'];

export function defaultThemeCss(): string {
  const tokens = Object.entries(LIGHT_TOKENS).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const parts = THEME_PARTS.map(([p, d]) => `/* ${d} */\n[data-part="${p}"] { }`).join('\n');
  return `/* PAGE 테마
   업데이트해도 유지하는 손잡이:
   1) 색 토큰 — 아래 :root[data-theme] 블록. 기본 테마 규칙보다 우선하려면 이 선택자 아래에 쓴다.
   2) 글꼴 변수 — --font-body (본문 기본), --font-ui (버튼·메뉴).
   3) 리더 변수 — ${READER_VARS.join(', ')}
      보기 설정이 정하는 값이라 테마보다 우선한다. 꼭 바꾸려면 !important 를 붙인다.
   4) [data-part="…"] 이름표 — 맨 아래 목록. 쓰고 싶은 이름표의 { } 안에 쓴다. 그 밖의 클래스·구조는 업데이트 때 바뀔 수 있다.
   바탕을 바꾸면 위 토큰 블록도 그 바탕에 맞게 바꾼다 (이 값은 밝게 기준).
   글꼴: 테마·글꼴 화면에서 올린 글꼴은 font-family: "이름" 으로 부른다.
   화면이 깨지면: 주소에 ?theme=off 를 붙여 열면 테마 없이 열린다 (예: /?theme=off#/appearance).
*/
:root[data-theme] {
${tokens}
}

/* 이름표 */
${parts}
`;
}
