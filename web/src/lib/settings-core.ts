// 리더 설정의 순수 로직: 정규화(범위·형식 검증), 서버 키 매핑, CSS 변수 계산. (상태·저장은 settings.svelte.ts)

export type ReaderMode = 'scroll' | 'book';
export type FontPreset = 'serif' | 'sans' | 'system';
export type BuiltinTheme = 'system' | 'light' | 'dark' | 'sepia';
/** custom:<id> = 사용자 CSS 프리셋 (커스텀 테마 스펙 2.2). */
export type Theme = BuiltinTheme | `custom:${string}`;

export type ReaderSettings = {
  mode: ReaderMode;
  bubble: boolean;
  font: string; // 프리셋 이름 또는 직접 입력한 글꼴 목록
  fontSize: number; // px
  lineHeight: number;
  paraSpacing: number; // em
  width: number; // rem (스크롤 모드 본문 폭)
  justify: boolean;
  indent: boolean;
  theme: Theme;
  hideUser: boolean; // 내 메시지 숨기기 (스펙 §5.4)
};

export const DEFAULTS: ReaderSettings = {
  mode: 'scroll', bubble: false, font: 'serif', fontSize: 18, lineHeight: 1.85, paraSpacing: 0.9, width: 38,
  justify: false, indent: false, theme: 'system', hideUser: false,
};

export const LIMITS = {
  fontSize: [14, 28],
  lineHeight: [1.3, 2.4],
  paraSpacing: [0, 2],
  width: [26, 52],
} as const;

export const FONT_STACKS: Record<FontPreset, string> = {
  serif: '"MaruBuri", "Noto Serif KR", "AppleMyungjo", Georgia, serif',
  sans: '"Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const PRESETS = new Set<string>(['serif', 'sans', 'system']);
// 직접 입력: 글자·숫자·공백·쉼표·따옴표·하이픈·밑줄·점만. `;(){}` 같은 CSS 구문은 받지 않는다.
const CUSTOM_FONT = /^[\p{L}\p{N} ,'"\-_.]{1,120}$/u;

export const SERVER_KEYS: Record<keyof ReaderSettings, string> = {
  mode: 'reader.mode', bubble: 'reader.bubble', font: 'reader.font', fontSize: 'reader.fontSize', lineHeight: 'reader.lineHeight',
  paraSpacing: 'reader.paraSpacing', width: 'reader.width', justify: 'reader.justify', indent: 'reader.indent', theme: 'reader.theme',
  hideUser: 'reader.hideUser',
};

export const normalizeMode = (v: unknown): ReaderMode => (v === 'book' ? 'book' : 'scroll');

export function normalizeFont(v: unknown): string {
  if (typeof v !== 'string') return DEFAULTS.font;
  const t = v.trim();
  if (PRESETS.has(t)) return t;
  return CUSTOM_FONT.test(t) ? t : DEFAULTS.font;
}

const num = (v: unknown, [lo, hi]: readonly [number, number], d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const CUSTOM_THEME = /^custom:[0-9a-f]{32}$/;
const theme = (v: unknown): Theme =>
  v === 'light' || v === 'dark' || v === 'sepia' ? v : typeof v === 'string' && CUSTOM_THEME.test(v) ? (v as Theme) : 'system';
export const customThemeId = (t: string): string | null => (CUSTOM_THEME.test(t) ? t.slice('custom:'.length) : null);

export function normalizeSettings(raw: Record<string, unknown>): ReaderSettings {
  return {
    mode: normalizeMode(raw.mode),
    bubble: raw.bubble === true,
    font: raw.font === undefined ? DEFAULTS.font : normalizeFont(raw.font),
    fontSize: num(raw.fontSize, LIMITS.fontSize, DEFAULTS.fontSize),
    lineHeight: num(raw.lineHeight, LIMITS.lineHeight, DEFAULTS.lineHeight),
    paraSpacing: num(raw.paraSpacing, LIMITS.paraSpacing, DEFAULTS.paraSpacing),
    width: num(raw.width, LIMITS.width, DEFAULTS.width),
    justify: raw.justify === true,
    indent: raw.indent === true,
    theme: theme(raw.theme),
    hideUser: raw.hideUser === true,
  };
}

/** localStorage 의 보조 캐시를 안전하게 읽는다 (없거나 깨졌거나 낯선 값이면 기본값). */
export function parseLocal(raw: string | null): ReaderSettings {
  if (!raw) return { ...DEFAULTS };
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return normalizeSettings(v as Record<string, unknown>);
  } catch {
    /* 깨진 캐시는 무시 */
  }
  return { ...DEFAULTS };
}

/** 서버 설정 맵에서 reader.* 키만, 있는 것만 정규화해 꺼낸다. */
export function fromServer(map: Record<string, unknown>): Partial<ReaderSettings> {
  const raw: Record<string, unknown> = {};
  for (const [k, key] of Object.entries(SERVER_KEYS)) if (key in map) raw[k] = map[key];
  const full = normalizeSettings(raw);
  return Object.fromEntries(Object.keys(raw).map((k) => [k, full[k as keyof ReaderSettings]])) as Partial<ReaderSettings>;
}

/** <html> 에 CSSOM 으로 넣을 CSS 변수와 data-theme 값 (CSP: 인라인 style 속성을 쓰지 않는다). */
export function cssVars(s: ReaderSettings): { vars: Record<string, string>; theme: string | null } {
  const stack = PRESETS.has(s.font) ? FONT_STACKS[s.font as FontPreset] : `${s.font}, ${FONT_STACKS.serif}`;
  return {
    vars: {
      '--reader-font': stack,
      '--reader-size': `${s.fontSize}px`,
      '--reader-lh': String(s.lineHeight),
      '--reader-para': `${s.paraSpacing}em`,
      '--reader-width': `${s.width}rem`,
      '--reader-align': s.justify ? 'justify' : 'start',
      '--reader-indent': s.indent ? '1em' : '0',
    },
    theme: s.theme === 'system' ? null : s.theme,
  };
}

/** 레이아웃(쪽 나눔·줄바꿈)에 영향을 주는 값만. 바뀌면 리더가 현재 위치에서 뷰를 다시 만든다. */
export function layoutSignature(s: ReaderSettings): string {
  return JSON.stringify([s.font, s.fontSize, s.lineHeight, s.paraSpacing, s.width, s.justify, s.indent, s.bubble, s.hideUser]);
}
