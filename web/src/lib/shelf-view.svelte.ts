import { api } from './api';

// 캐릭터 서가의 서가/목록 선택 (스펙 6.2, 설정 키 library.shelfView). 로컬 캐시 + 서버 설정.
export type ShelfView = 'shelf' | 'list';
const KEY = 'library.shelfView';
const LS = 'page.library.shelfView';
const norm = (v: unknown): ShelfView => (v === 'list' ? 'list' : 'shelf');
function readLocal(): ShelfView {
  try { return norm(localStorage.getItem(LS)); } catch { return 'shelf'; }
}

export const shelfView = $state<{ value: ShelfView }>({ value: readLocal() });

export async function loadShelfView() {
  try {
    const s = await api.getSettings();
    if (KEY in s) shelfView.value = norm(s[KEY]);
  } catch { /* 로컬 값으로 */ }
}

export function setShelfView(v: ShelfView) {
  shelfView.value = v;
  try { localStorage.setItem(LS, v); } catch { /* 무시 */ }
  void api.putSettings({ [KEY]: v }).catch(() => undefined);
}
