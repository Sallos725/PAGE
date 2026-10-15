import type { ThemeBase } from './theme-file';

export type PageMessage = { idx: number; role: 'user' | 'char'; text: string; time?: number };
export type MessagesPage = { total: number; from: number; version: number; messages: PageMessage[] };

export type SourceInfo = { id: string; kind: string; status: 'ok' | 'degraded' | 'unavailable'; reasons: string[]; lastSyncAt: number | null };
export type CharInfo = { charId: string; name: string; deleted: boolean; chatCount: number; displayName: string; originalName: string; imageUrl: string | null };
export type ChatInfo = {
  chatId: string; title: string; deleted: boolean; headVersion: number | null;
  lastDate: number | null; lastError: string | null; msgCount: number | null;
  displayName: string; originalName: string;
  progress: number | null; readAt: number | null; keptAt: number | null;
};
export type LibraryStatus = {
  library: { assetCount: number; assetBytes: number; dbBytes: number };
  freeSpace: { freeBytes: number; totalBytes: number; freePct: number };
  warnings: string[];
};

/** 스펙 4.1: 위치는 페이지 번호가 아니라 이 값이다. */
export type ReadingPosition = { msgIdx: number; blockIdx: number; charOffset: number; anchorHash: string };

export type Bookmark = {
  id: string; kind: 'bookmark' | 'highlight'; start: ReadingPosition; end: ReadingPosition | null;
  note: string; color: string; text: string; createdAt: number;
};
export type NewBookmark = { kind: 'bookmark' | 'highlight'; start: ReadingPosition; end?: ReadingPosition | null; note?: string; color?: string; text?: string };

export type HideRuleScope = 'global' | 'char';
export type HideRule = {
  id: string; scope: HideRuleScope; charId: string; name: string; pattern: string; flags: string;
  enabled: boolean; origin: 'manual' | 'card'; createdAt: number; updatedAt: number;
};
export type HideRuleInput = { name: string; pattern: string; flags: string; scope: HideRuleScope; enabled?: boolean; origin?: 'manual' | 'card' };
export type HideRulePatch = Partial<Pick<HideRule, 'name' | 'pattern' | 'flags' | 'enabled'>>;
export type HideCandidate = { name: string; pattern: string; flags: string };

export type ShelfChat = {
  chatId: string; displayName: string; msgCount: number | null; lastError: string | null; lastDate: number | null;
  progress: number | null; readAt: number | null; deleted: boolean; keptAt: number | null;
};
export type Shelf = { charId: string; displayName: string; originalName: string; deleted: boolean; chatCount: number; imageUrl: string | null; chats: ShelfChat[] };
export type RecentItem = {
  source: string; charId: string; chatId: string; title: string; charName: string;
  chapter: number; progress: number; updatedAt: number; imageUrl: string | null; deleted: boolean;
};
export type ImageRule = { key: string; name: string; pattern: string; flags: string; images: string[]; enabled: boolean; slow: boolean };

export type ExportFormat = 'json' | 'epub' | 'pdf';
export type ExportWarnings = { missingImages: number; skippedImages: number; slowRules: string[] };
export type ExportStatus = {
  jobId: string; state: 'queued' | 'running' | 'done' | 'failed'; format: ExportFormat;
  size?: number; warnings?: ExportWarnings; error?: string;
};
export type EpubOptions = {
  includeUser: boolean; cover: boolean; cardImages: boolean; chatImages: boolean; hideRuleIds: string[]; imageRuleKeys: string[];
  imageMode: 'small' | 'compat' | 'original';
};

export type ThemeMeta = { id: string; name: string; base: ThemeBase; updatedAt: number };
export type ThemeFull = ThemeMeta & { css: string };
export type FontMeta = { id: string; family: string; format: 'woff2' | 'ttf' | 'otf'; size: number; createdAt: number };

export type LibraryHighlight = {
  id: string; source: string; charId: string; chatId: string; charName: string; chatTitle: string; deleted: boolean;
  start: ReadingPosition; end: ReadingPosition; text: string; color: string; createdAt: number;
};
