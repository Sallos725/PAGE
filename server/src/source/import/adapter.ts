// "가져온 채팅" 원본 (임포트 스펙 §4). imports 폴더를 읽기만 한다 — 쓰기는 ImportStore 가 API 에서 한다.
import fs from 'node:fs';
import { IMPORTED_SOURCE } from '../../import/constants.js';
import type { ImportStore } from '../../import/store.js';
import type { CharacterHandle, ChatRead, ScanOptions, ScanResult, SourceAdapter, SourceHealth } from '../types.js';

export { IMPORTED_SOURCE };

export class ImportAdapter implements SourceAdapter {
  readonly id = IMPORTED_SOURCE;
  readonly kind = 'risu-import' as const;
  constructor(private readonly imports: ImportStore) {}

  async health(): Promise<SourceHealth> {
    return { id: this.id, kind: this.kind, status: 'ok', reasons: [] };
  }

  async fingerprint(): Promise<string | null> {
    try { return this.imports.fingerprint(); } catch { return null; }
  }

  async scan(onCharacter: (c: CharacterHandle) => Promise<void> | void, options: ScanOptions = {}): Promise<ScanResult> {
    const seen = new Map<string, Set<string>>();
    let unreadable = 0;
    for (const c of this.imports.listChars()) {
      if (c.broken) continue; // 이름 없는 캐릭터로 넘기지 않는다 — 아래에서 이번 회차를 미완료로 둔다
      if (options.only && options.only.charId !== c.charId) continue;
      if (options.onlyChar && options.onlyChar !== c.charId) continue;
      const chats: ChatRead[] = [];
      const ids = new Set<string>();
      for (const f of this.imports.listChatFiles(c.charId)) {
        if (options.only && options.only.chatId !== f.chatId) continue;
        ids.add(f.chatId);
        try {
          const raw = JSON.parse(fs.readFileSync(f.path, 'utf8')) as Record<string, unknown>;
          const messages = Array.isArray(raw.message) ? raw.message : [];
          const { message: _drop, ...meta } = raw;
          chats.push({ ok: true, chat: { chatId: f.chatId, title: typeof raw.name === 'string' ? raw.name : '', lastDate: typeof raw.lastDate === 'number' ? raw.lastDate : null, meta, messages } });
        } catch {
          unreadable++;
          chats.push({ ok: false, chatId: f.chatId, reason: 'unreadable' });
        }
      }
      seen.set(c.charId, ids);
      const img = this.imports.imageFile(c.charId);
      // 그림을 바꾸면 참조 이름이 바뀌어야 Syncer 가 다시 읽는다 (같은 ref 면 건너뛴다).
      const imageRef = img ? `image-${img.size}-${Math.floor(img.mtimeMs)}` : null;
      await onCharacter({
        charId: c.charId, name: c.name, meta: {}, imageRef,
        readImage: () => { try { return img ? fs.readFileSync(img.path) : null; } catch { return null; } },
        chats,
        assetNames: () => [],
        isTrackedAssetName: () => false,
        readAsset: () => null,
      });
    }
    // char.json 을 못 읽는 캐릭터 폴더가 있으면 그 채팅들이 "없는 것"으로 보이지 않게 이번 회차는 삭제 판단을 하지 않는다.
    // (한 캐릭터만 읽는 스캔은 삭제 판단을 안 하므로 다른 캐릭터의 깨진 폴더와 상관없다.)
    if (!options.only && !options.onlyChar && this.imports.brokenChars().length > 0) return { complete: false, seen, unreadable, error: 'import character unreadable' };
    return { complete: true, seen, unreadable };
  }
}
