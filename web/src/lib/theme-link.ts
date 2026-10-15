// 테마 적용 (커스텀 테마 스펙 2.2–2.3): <html data-theme> 과 프리셋 CSS <link>. CSP: 같은 출처 링크라 style-src 'self' 안이다.
import { customThemeId } from './settings-core';
import { isThemeBase, type ThemeBase } from './theme-file';
import type { ThemeMeta } from './types';

const LS_KEY = 'page.theme.known';
type Known = Record<string, { base: ThemeBase; v: number }>;

function readKnown(): Known {
  const out: Known = {};
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[0-9a-f]{32}$/.test(id) || !e || typeof e !== 'object') continue;
      const { base, v: ver } = e as { base?: unknown; v?: unknown };
      if (isThemeBase(base) && typeof ver === 'number' && Number.isFinite(ver)) out[id] = { base, v: ver };
    }
  } catch { /* 깨진 캐시는 무시 */ }
  return out;
}
// 서버 목록을 받기 전 첫 화면도 프리셋으로 그리려고, 마지막으로 본 프리셋 메타(id → 바탕·버전)를 기억한다.
let known: Known = readKnown();

export const knownThemes = (): Known => known;

export function setKnownThemes(list: ThemeMeta[]) {
  known = Object.fromEntries(list.map((t) => [t.id, { base: t.base, v: t.updatedAt }]));
  try { localStorage.setItem(LS_KEY, JSON.stringify(known)); } catch { /* 무시 */ }
}

/** 주소 쿼리에 theme=off 가 있으면 프리셋 CSS 를 걸지 않는다 (탈출구). */
export const safeMode = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).get('theme') === 'off';

export function applyTheme(theme: string) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const id = customThemeId(theme);
  const k = id ? known[id] : undefined;
  // 없어진 프리셋이면 기기 설정 테마로 보여 준다 (설정 값은 그대로 둔다).
  const attr = id ? (k ? k.base : null) : theme === 'system' ? null : theme;
  if (attr) root.dataset.theme = attr;
  else delete root.dataset.theme;
  let link = document.getElementById('page-theme') as HTMLLinkElement | null;
  const href = id && k && !safeMode() ? `/api/themes/${id}/theme.css?v=${k.v}` : null;
  if (!href) { link?.remove(); return; }
  if (!link) {
    link = document.createElement('link');
    link.id = 'page-theme';
    link.rel = 'stylesheet';
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  if (document.head.lastElementChild !== link) document.head.append(link); // 앱 CSS 보다 뒤 → 같은 특이도면 프리셋이 이긴다
}
