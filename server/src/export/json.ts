import fs from 'node:fs';
import type { LibraryStore } from '../library/store.js';
import { noWarnings, type ExportWarnings } from './jobs.js';
import type { ChatVersion } from './source.js';

// RisuAI 네이티브 채팅 JSON (D20, storage-notes §9). 원문 그대로 — 정규식·그림 옵션은 없다 (X5).
// 라이브러리가 채팅 폴더 목록을 갖지 않으므로 folderId 를 지우고 folders 는 비운다.
// 메시지 본문은 라이브러리에서 이미 정규(canonical) JSON 문자열이라 파싱·재직렬화 없이 그대로 이어 붙인다 (메모리·원문 보존).
export function risuChatJson(metaJson: string, rawMessages: string[]): string {
  const meta = JSON.parse(metaJson) as Record<string, unknown>;
  delete meta.folderId;
  delete meta.message;
  const m = JSON.stringify(meta);
  const data = `${m.slice(0, -1)}${m.length > 2 ? ',' : ''}"message":[${rawMessages.join(',')}]}`;
  return `{"type":"risuChat","ver":2,"data":${data},"folders":[]}`;
}

export async function produceJson(store: LibraryStore, cv: ChatVersion, tmpFile: string): Promise<{ warnings: ExportWarnings }> {
  await fs.promises.writeFile(tmpFile, risuChatJson(cv.version.metaJson, store.getMsgJson(cv.hashes)));
  return { warnings: noWarnings() };
}
