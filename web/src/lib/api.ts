import type {
  AppInfo, Bookmark, CharInfo, ChatInfo, EpubOptions, ExportFormat, ExportStatus, FontMeta, Health, HideCandidate, HideRule, HideRuleInput, HideRulePatch, ImageRule, ImportChar, ImportResult, LibraryHighlight, LibraryStatus, MessagesPage, NewBookmark, PortableSource, ReadingPosition, RecentItem, Shelf, SourceCheck, SourceInfo, ThemeFull, ThemeMeta,
} from './types';
import type { SyncReportLite } from './sync-summary';
import type { ThemeFile } from './theme-file';

export class ApiError extends Error {
  /** 서버가 { error: '<코드>' } 를 주면 그 코드 (테마·글꼴 API). */
  constructor(readonly status: number, readonly code?: string) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
  }
}

async function fail(r: Response): Promise<never> {
  let code: string | undefined;
  try {
    const b = (await r.json()) as { error?: unknown };
    if (typeof b.error === 'string') code = b.error;
  } catch { /* 본문이 없거나 JSON 이 아니다 */ }
  throw new ApiError(r.status, code);
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = init === undefined ? await fetch(url) : await fetch(url, init);
  if (!r.ok) return fail(r);
  return (await r.json()) as T;
}

const q = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  health: () => req<Health>('/api/health'),
  app: () => req<AppInfo>('/api/app'),
  sources: () => req<SourceInfo[]>('/api/sources'),
  status: () => req<LibraryStatus>('/api/library/status'),
  chars: (source: string, o: { includeDeleted?: boolean } = {}) =>
    req<CharInfo[]>(`/api/chars?${q({ source, includeDeleted: o.includeDeleted ? 1 : undefined })}`),
  chats: (source: string, char: string, o: { includeDeleted?: boolean } = {}) =>
    req<ChatInfo[]>(`/api/chats?${q({ source, char, includeDeleted: o.includeDeleted ? 1 : undefined })}`),
  shelves: (source: string) => req<Shelf[]>(`/api/shelves?${q({ source })}`),
  recent: (limit = 3) => req<RecentItem[]>(`/api/recent?${q({ limit })}`),
  messages: (source: string, char: string, chat: string, p: { from?: number; limit?: number; version?: number }) =>
    req<MessagesPage>(`/api/chat/${encodeURIComponent(chat)}/messages?${q({ source, char, from: p.from, limit: p.limit, version: p.version })}`),
  /** 채팅을 열 때 해당 채팅만 즉시 동기화 (스펙 3.4.4-③). 실패해도 라이브러리 사본으로 읽을 수 있다. */
  syncChat: (source: string, char: string, chat: string) => req<unknown>(`/api/library/sync?${q({ source, char, chat })}`, { method: 'POST' }),
  getPosition: async (source: string, char: string, chat: string) => {
    const r = await req<{ position: ReadingPosition | null; updatedAt: number | null }>(`/api/state/position?${q({ source, char, chat })}`);
    return r.position ? { position: r.position, updatedAt: r.updatedAt as number } : null;
  },
  putPosition: (source: string, char: string, chat: string, position: ReadingPosition, opts: { keepalive?: boolean } = {}) =>
    req<unknown>(`/api/state/position?${q({ source, char, chat })}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(position), keepalive: opts.keepalive === true,
    }),
  getSettings: async () => (await req<{ settings: Record<string, unknown> }>('/api/state/settings')).settings,
  /** keepalive: 페이지를 떠나는 중에도 보낸다 (지정할 때만 넣어 기존 호출 형태를 유지). */
  putSettings: (entries: Record<string, unknown>, opts: { keepalive?: boolean } = {}) =>
    req<unknown>('/api/state/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entries), ...(opts.keepalive ? { keepalive: true } : {}),
    }),
  listBookmarks: async (source: string, char: string, chat: string) =>
    (await req<{ bookmarks: Bookmark[] }>(`/api/state/bookmarks?${q({ source, char, chat })}`)).bookmarks,
  addBookmark: async (source: string, char: string, chat: string, b: NewBookmark) =>
    (await req<{ bookmark: Bookmark }>(`/api/state/bookmarks?${q({ source, char, chat })}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    })).bookmark,
  /** 204 = 지움, 404 = 이미 없음(성공으로 본다). 그 밖은 오류. */
  deleteBookmark: async (source: string, char: string, chat: string, id: string) => {
    const r = await fetch(`/api/state/bookmarks/${encodeURIComponent(id)}?${q({ source, char, chat })}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new ApiError(r.status);
  },
  setBookmarkText: async (source: string, char: string, chat: string, id: string, text: string) =>
    req<{ id: string; text: string }>(`/api/state/bookmarks/${encodeURIComponent(id)}?${q({ source, char, chat })}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    }),
  libraryHighlights: (limit = 2000) => req<{ highlights: LibraryHighlight[]; hasMore: boolean }>(`/api/state/highlights?${q({ limit })}`),
  /** 빈 이름 = 별칭 삭제. chat 이 있으면 채팅, 없으면 캐릭터. */
  setAlias: (source: string, char: string, chat: string | undefined, name: string) =>
    req<{ displayName: string; originalName: string }>(`/api/state/alias?${q({ source, char, chat })}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    }),
  hideRules: async (source: string, char: string) =>
    (await req<{ rules: HideRule[] }>(`/api/state/hide-rules?${q({ source, char })}`)).rules,
  addHideRule: async (source: string, char: string, r: HideRuleInput) =>
    (await req<{ rule: HideRule }>(`/api/state/hide-rules?${q({ source })}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: r.name, pattern: r.pattern, flags: r.flags, scope: r.scope,
        ...(r.scope === 'char' ? { char } : {}), enabled: r.enabled ?? true, origin: r.origin ?? 'manual',
      }),
    })).rule,
  updateHideRule: async (source: string, id: string, patch: HideRulePatch) =>
    (await req<{ rule: HideRule }>(`/api/state/hide-rules/${encodeURIComponent(id)}?${q({ source })}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    })).rule,
  /** 204 = 지움, 404 = 이미 없음(성공으로 본다). */
  deleteHideRule: async (source: string, id: string) => {
    const r = await fetch(`/api/state/hide-rules/${encodeURIComponent(id)}?${q({ source })}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new ApiError(r.status);
  },
  hideCandidates: async (source: string, char: string) =>
    (await req<{ candidates: HideCandidate[] }>(`/api/state/hide-candidates?${q({ source, char })}`)).candidates,
  imageRules: async (source: string, char: string) =>
    (await req<{ rules: ImageRule[] }>(`/api/state/image-rules?${q({ source, char })}`)).rules,
  setImageRule: (source: string, char: string, key: string, enabled: boolean) =>
    req<{ key: string; enabled: boolean }>(`/api/state/image-rules/${encodeURIComponent(key)}?${q({ source, char })}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    }),
  assetUrl: (source: string, char: string, name: string) =>
    `/api/asset/${encodeURIComponent(source)}/${encodeURIComponent(char)}/${encodeURIComponent(name)}`,
  /** 보관 (스펙 3D E3). */
  setKept: (source: string, char: string, chat: string, kept: boolean) =>
    req<{ kept: boolean; keptAt: number | null }>(`/api/state/kept?${q({ source, char, chat })}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kept }),
    }),
  /** 지금 동기화 (스펙 3D E4): 디바운스를 무시하고 소스 전체를 즉시 동기화. */
  syncNow: (source: string) => req<SyncReportLite>(`/api/library/sync?${q({ source, force: 1 })}`, { method: 'POST' }),
  /** 내보내기 시작 (스펙 2.5 §2.4). JSON 은 options 없이. */
  startExport: (source: string, char: string, chat: string, body: { format: ExportFormat; version?: number; options?: EpubOptions }) =>
    req<{ jobId: string }>(`/api/export?${q({ source, char, chat })}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  /** 서버가 만들 수 있는 내보내기 형식 (PDF 는 사이드카가 있을 때만). */
  exportFormats: () => req<{ formats: ExportFormat[] }>('/api/export/formats'),
  exportStatus: (jobId: string) => req<ExportStatus>(`/api/export/${encodeURIComponent(jobId)}`),
  exportDownloadUrl: (jobId: string) => `/api/export/${encodeURIComponent(jobId)}/download`,

  // ── 커스텀 테마 · 글꼴 서재
  themes: async () => (await req<{ themes: ThemeMeta[] }>('/api/themes')).themes,
  theme: (id: string) => req<ThemeFull>(`/api/themes/${encodeURIComponent(id)}`),
  createTheme: async (t: ThemeFile) =>
    (await req<{ theme: ThemeMeta }>('/api/themes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) })).theme,
  updateTheme: async (id: string, patch: Partial<ThemeFile>) =>
    (await req<{ theme: ThemeMeta }>(`/api/themes/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).theme,
  /** 204 = 지움, 404 = 이미 없음(성공으로 본다). */
  deleteTheme: async (id: string) => {
    const r = await fetch(`/api/themes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) await fail(r);
  },
  themeDownloadUrl: (id: string) => `/api/themes/${encodeURIComponent(id)}/download`,
  fonts: async () => (await req<{ fonts: FontMeta[] }>('/api/fonts')).fonts,
  addFont: async (family: string, file: Blob) =>
    (await req<{ font: FontMeta }>(`/api/fonts?${q({ family })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })).font,
  renameFont: async (id: string, family: string) =>
    (await req<{ font: FontMeta }>(`/api/fonts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ family }) })).font,
  deleteFont: async (id: string) => {
    const r = await fetch(`/api/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) await fail(r);
  },

  // ── 가져오기 (임포트 스펙 §6). 오류는 ApiError.code.
  importChars: async () => (await req<{ chars: ImportChar[] }>('/api/import/chars')).chars,
  createImportChar: async (name: string) =>
    (await req<{ charId: string }>('/api/import/chars', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).charId,
  renameImportChar: (id: string, name: string) =>
    req<unknown>(`/api/import/chars/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  setImportCharImage: (id: string, file: Blob) =>
    req<unknown>(`/api/import/chars/${encodeURIComponent(id)}/image`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  deleteImportCharImage: async (id: string) => {
    const r = await fetch(`/api/import/chars/${encodeURIComponent(id)}/image`, { method: 'DELETE' });
    if (!r.ok) await fail(r);
  },
  /** 파일 글자를 그대로 보낸다 (다시 직렬화하지 않는다). */
  importChats: (id: string, text: string) =>
    req<{ results: ImportResult[]; sync?: 'pending' }>(`/api/import/chars/${encodeURIComponent(id)}/chats`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
    }),
  /** 204 = 지움, 404 = 이미 없음(성공으로 본다). */
  deleteImportChat: async (id: string, chatId: string) => {
    const r = await fetch(`/api/import/chars/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) await fail(r);
  },
  deleteImportChar: async (id: string) => {
    const r = await fetch(`/api/import/chars/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) await fail(r);
  },

  // ── 포터블 원본 연결 (포터블 스펙 §4). 연결·해제는 202 뒤 서버가 다시 켜진다.
  portableSource: () => req<PortableSource>('/api/portable/source'),
  checkPortableSource: (path: string) =>
    req<SourceCheck>('/api/portable/source/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }),
  connectPortableSource: (path: string) =>
    req<{ restarting: true }>('/api/portable/source', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }),
  disconnectPortableSource: () => req<{ restarting: true }>('/api/portable/source', { method: 'DELETE' }),
  /** 본문이 비면 서버가 400 을 준다 — 빈 객체를 보낸다. */
  browsePortable: () =>
    req<{ path: string } | { cancelled: true }>('/api/portable/browse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
};
