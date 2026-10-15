import type { LibraryStore, VersionRow } from '../library/store.js';

export type ChatVersion = { version: VersionRow; hashes: string[] };

/** 채팅의 버전(기본 head)과 메시지 해시. 모르는 채팅·다른 채팅의 버전이면 null. 지워진 채팅도 라이브러리에 있으면 찾는다. */
export function chatVersion(store: LibraryStore, source: string, charId: string, chatId: string, versionId?: number): ChatVersion | null {
  const row = store.getChat(source, charId, chatId);
  if (!row) return null;
  const id = versionId ?? row.headVersion;
  const version = id == null ? null : store.getVersion(id);
  if (!version || version.source !== source || version.charId !== charId || version.chatId !== chatId) return null;
  const hashes = store.getManifest(version.manifestHash);
  return hashes ? { version, hashes } : null;
}
