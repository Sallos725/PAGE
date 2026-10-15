// 테마 프리셋·글꼴 서재 목록 상태 (커스텀 테마 스펙 §5). 적용 자체는 theme-link·settings 가 한다.
import { api } from './api';
import { applySettings } from './settings.svelte';
import { setKnownThemes } from './theme-link';
import type { FontMeta, ThemeMeta } from './types';

export const appearance = $state<{ themes: ThemeMeta[]; fonts: FontMeta[] }>({ themes: [], fonts: [] });

/** 올린 글꼴을 고르면 설정 값은 따옴표로 감싼 패밀리 이름 (기존 '직접 입력' 규칙 안). */
export const fontValue = (family: string): string => `"${family}"`;
export function familyOf(font: string): string | null {
  const m = /^"([^"]+)"$/.exec(font);
  return m ? m[1]! : null;
}

export async function refreshThemes() {
  const list = await api.themes();
  appearance.themes = list;
  setKnownThemes(list);
  applySettings(); // 고른 프리셋의 버전(v)이 바뀌었으면 링크를 다시 건다
}

export async function refreshFonts(bustCss = false) {
  appearance.fonts = await api.fonts();
  if (bustCss) reloadFontsCss();
}

export async function loadAppearance() {
  await Promise.all([refreshThemes(), refreshFonts()]);
}

/** 글꼴 서재의 @font-face 묶음. 실제로 쓰는 글꼴만 브라우저가 받는다. 안전 모드에서도 건다. */
export function mountFontsCss() {
  if (typeof document === 'undefined' || document.getElementById('page-fonts')) return;
  const l = document.createElement('link');
  l.id = 'page-fonts';
  l.rel = 'stylesheet';
  l.href = '/api/fonts.css';
  document.head.append(l);
}

export function reloadFontsCss() {
  const l = document.getElementById('page-fonts') as HTMLLinkElement | null;
  if (l) l.href = `/api/fonts.css?v=${Date.now()}`;
}
