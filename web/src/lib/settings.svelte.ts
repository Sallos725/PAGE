import { api } from './api';
import { applyTheme } from './theme-link';
import { DEFAULTS, SERVER_KEYS, cssVars, fromServer, normalizeSettings, parseLocal, type ReaderMode, type ReaderSettings } from './settings-core';

const LS_KEY = 'page.settings';
const LS_DIRTY = 'page.settings.dirty'; // 아직 서버가 확인하지 않은 키 (server key 목록)

function readLocal(): ReaderSettings {
  try {
    return parseLocal(localStorage.getItem(LS_KEY));
  } catch {
    return { ...DEFAULTS }; // 사생활 보호 모드 등에서 접근이 막힌 경우
  }
}
function writeLocal(s: ReaderSettings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}
function readDirty(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_DIRTY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeDirty() {
  try {
    localStorage.setItem(LS_DIRTY, JSON.stringify([...dirty]));
  } catch {
    /* 무시 */
  }
}

export const settings = $state<ReaderSettings>(readLocal());
// 로컬에서 바꿨지만 서버가 아직 받지 않은 키. 새로고침 직후 서버의 옛 값이 이 값을 덮어쓰면 안 된다.
const dirty = readDirty();
const BY_SERVER_KEY = Object.fromEntries(Object.entries(SERVER_KEYS).map(([k, sk]) => [sk, k as keyof ReaderSettings]));

/** 설정을 <html> 에 반영한다: CSS 변수는 CSSOM, 테마는 data-theme 속성 + 프리셋 링크 (theme-link). */
export function applySettings() {
  if (typeof document === 'undefined') return;
  const snap = $state.snapshot(settings);
  const { vars } = cssVars(snap);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  applyTheme(snap.theme);
}

let putTimer: ReturnType<typeof setTimeout> | null = null;

/** dirty 키를 지금 값으로 서버에 보낸다. 성공하면 그 사이 다시 바뀌지 않은 키만 dirty 에서 뺀다. */
function sendDirty(keepalive = false) {
  if (putTimer) { clearTimeout(putTimer); putTimer = null; }
  if (dirty.size === 0) return;
  const snap = $state.snapshot(settings);
  const body: Record<string, unknown> = {};
  for (const sk of dirty) { const k = BY_SERVER_KEY[sk]; if (k) body[sk] = snap[k]; }
  void api.putSettings(body, { keepalive })
    .then(() => {
      const now = $state.snapshot(settings);
      for (const [sk, v] of Object.entries(body)) { const k = BY_SERVER_KEY[sk]; if (k && now[k] === v) dirty.delete(sk); }
      writeDirty();
    })
    .catch(() => undefined); // 실패하면 dirty 로 남아 다음에 다시 보낸다
}

let resolveReady: () => void = () => {};
/** 서버 설정을 읽었거나 포기한 뒤에 풀린다. 리더는 이걸 기다린 뒤 모드를 정한다. */
export const settingsReady: Promise<void> = new Promise<void>((r) => { resolveReady = r; });

export async function loadSettings(): Promise<void> {
  const timeout = setTimeout(resolveReady, 1500); // 서버가 느려도 리더를 오래 붙잡지 않는다
  if (typeof window !== 'undefined') {
    const hide = () => sendDirty(true); // 페이지를 떠나기 직전에 미뤄 둔 변경을 보낸다
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hide(); });
  }
  try {
    const server = fromServer(await api.getSettings());
    for (const sk of dirty) { const k = BY_SERVER_KEY[sk]; if (k) delete server[k]; } // 로컬의 새 값이 이긴다
    Object.assign(settings, server);
    writeLocal($state.snapshot(settings));
    sendDirty(); // 지난번에 못 보낸 변경이 있으면 지금 보낸다
  } catch {
    /* 서버 설정을 못 읽으면 localStorage 값 그대로 */
  } finally {
    clearTimeout(timeout);
    applySettings();
    resolveReady();
  }
}

/** 설정을 바꾸고(정규화) 바로 화면에 반영한 뒤, 서버에는 0.4초 모아서 보낸다. */
export function update(patch: Partial<ReaderSettings>) {
  const next = normalizeSettings({ ...$state.snapshot(settings), ...patch });
  Object.assign(settings, next);
  writeLocal(next);
  applySettings();
  for (const k of Object.keys(patch) as (keyof ReaderSettings)[]) dirty.add(SERVER_KEYS[k]);
  writeDirty();
  if (putTimer) clearTimeout(putTimer);
  putTimer = setTimeout(() => sendDirty(), 400);
}

export function setMode(mode: ReaderMode) {
  update({ mode });
}
