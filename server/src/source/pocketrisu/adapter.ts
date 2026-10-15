import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../canon.js';
import { openSourceDb, retryBusy } from '../../sqlite.js';
import type {
  CharacterHandle, ChatRead, RawChat, ScanOptions, ScanResult, SourceAdapter, SourceHealth,
} from '../types.js';
import { createAssetResolver } from './assets.js';
import { coldKeyOf, readColdChat } from './cold.js';
import { ChunkIntegrityError, fingerprintKv, peekKv, readKv } from './kv.js';
import { extractImageRules } from './image-rules.js';
import { extractAssetNames, isTrackedAssetName } from './refs.js';
import { vendor } from './vendor.js';

const DB_KEY = 'database/database.bin';
// 검증된 범위 (findings §2.1): 레거시 raw 헤더, 디코드된 DB 의 formatversion 5. 그 밖은 읽되 degraded 로 표시한다.
const KNOWN_HEADERS = new Set(['raw']);
const KNOWN_FORMAT_VERSIONS = new Set([5]);
// 캐릭터 대표 이미지는 kv 키를 직접 가리킨다 (실제 save: 22/23 이 `assets/<…>.png`). assets/ 아래 한 단계만, `..` 금지.
const IMAGE_REF = /^assets\/(?!.*\.\.)[^/\\\u0000]{1,200}$/;

type Json = Record<string, unknown>;
type Db = ReturnType<typeof openSourceDb>;

export class PocketRisuAdapter implements SourceAdapter {
  readonly kind = 'pocketrisu-sqlite' as const;
  private readonly file: string;
  private lastFormatVersion: number | null = null;

  constructor(readonly id: string, dir: string, private readonly sleep?: (ms: number) => Promise<void>) {
    this.file = path.join(dir, 'risuai.db');
  }

  private busy<T>(fn: () => T): Promise<T> {
    return retryBusy(fn, { sleep: this.sleep });
  }

  async health(): Promise<SourceHealth> {
    const base = { id: this.id, kind: this.kind };
    if (!fs.existsSync(this.file)) return { ...base, status: 'unavailable', reasons: ['risuai.db not found'] };
    try {
      const reasons = await this.busy(() => {
        const db = openSourceDb(this.file);
        try {
          const head = peekKv(db, DB_KEY, 16);
          if (!head) return ['database.bin missing'];
          const out: string[] = [];
          const kind = vendor.checkHeader(head);
          if (!kind || !KNOWN_HEADERS.has(kind)) out.push(`unverified save header: ${kind || 'unknown'}`);
          return out;
        } finally {
          db.close();
        }
      });
      if (reasons.includes('database.bin missing')) return { ...base, status: 'unavailable', reasons };
      if (this.lastFormatVersion !== null && !KNOWN_FORMAT_VERSIONS.has(this.lastFormatVersion)) {
        reasons.push(`unverified formatversion: ${this.lastFormatVersion}`);
      }
      return { ...base, status: reasons.length ? 'degraded' : 'ok', reasons };
    } catch {
      return { ...base, status: 'unavailable', reasons: ['risuai.db could not be opened'] };
    }
  }

  async fingerprint(): Promise<string | null> {
    try {
      return await this.busy(() => {
        const db = openSourceDb(this.file);
        try {
          const bin = fingerprintKv(db, DB_KEY);
          if (bin === null) return null;
          // database.bin 밖의 읽기 입력도 지문에 넣는다: cold 항목, 에셋 매니페스트 (바뀌면 해석 결과가 달라진다).
          const cold = db.prepare("SELECT count(*) AS c, coalesce(max(updated_at),0) AS m FROM kv WHERE key LIKE 'coldstorage/%'").get() as { c: number; m: number };
          let manifests = 'none';
          try {
            const m = db.prepare('SELECT count(*) AS c, coalesce(max(updated_at),0) AS m FROM asset_manifest_live').get() as { c: number; m: number };
            manifests = `${m.c}:${m.m}`;
          } catch {
            /* 구버전 스키마: 테이블 없음 */
          }
          return sha256Hex([bin, `${cold.c}:${cold.m}`, manifests].join('|'));
        } finally {
          db.close();
        }
      });
    } catch {
      return null;
    }
  }

  async scan(onCharacter: (c: CharacterHandle) => Promise<void> | void, options: ScanOptions = {}): Promise<ScanResult> {
    const seen = new Map<string, Set<string>>();
    const fail = (error: string): ScanResult => ({ complete: false, seen: new Map(), unreadable: 0, error });
    if (!fs.existsSync(this.file)) return fail('risuai.db not found');

    let db: Db;
    try {
      db = await this.busy(() => openSourceDb(this.file));
    } catch {
      return fail('risuai.db could not be opened');
    }
    try {
      let bin: Buffer | null;
      try {
        bin = await this.busy(() => this.readBinWithRetry(db));
      } catch (e) {
        return fail(e instanceof ChunkIntegrityError ? 'chunk integrity error' : 'database.bin read failed');
      }
      if (!bin) return fail('database.bin missing');
      if (vendor.hasRemoteBlocks(bin)) return fail('remote blocks are not supported');

      let dec: { characters?: unknown; formatversion?: unknown };
      try {
        dec = (await vendor.decodeRisuSave(bin)) as typeof dec;
      } catch {
        return fail('database.bin decode failed');
      }
      if (!dec || !Array.isArray(dec.characters)) return fail('characters array missing');
      this.lastFormatVersion = typeof dec.formatversion === 'number' ? dec.formatversion : null;

      const resolver = createAssetResolver(db);
      const characters = dec.characters as (Json | null)[];
      let unreadable = 0;

      for (let i = 0; i < characters.length; i++) {
        const c = characters[i];
        characters[i] = null; // 처리 후 바로 해제 (스펙 6.2)
        const charId = c && typeof c === 'object' && typeof c.chaId === 'string' && c.chaId ? c.chaId : null;
        if (!c || !charId) {
          unreadable++;
          continue;
        }
        const only = options.only;
        if (only && only.charId !== charId) continue; // only 스캔은 삭제 판단에 쓰이지 않는다
        if (options.onlyChar && options.onlyChar !== charId) continue;
        const chats = this.readChats(db, c, only);
        const ids = seen.get(charId) ?? new Set<string>();
        for (const r of chats) ids.add(r.ok ? r.chat.chatId : r.chatId);
        seen.set(charId, ids);
        unreadable += chats.filter((r) => !r.ok).length;

        const imageRef = typeof c.image === 'string' && IMAGE_REF.test(c.image) ? c.image : null;
        const handle: CharacterHandle = {
          charId,
          name: typeof c.name === 'string' ? c.name : '',
          meta: pickCharMeta(c),
          imageRef,
          readImage: () => {
            if (!imageRef) return null;
            try {
              return readKv(db, imageRef, { verify: false });
            } catch {
              return null;
            }
          },
          chats,
          assetNames: (messages) => extractAssetNames(messages),
          isTrackedAssetName,
          readAsset: (name) => resolver.resolveAsset(c, name),
        };
        await onCharacter(handle);
      }
      return { complete: true, seen, unreadable };
    } finally {
      db.close();
    }
  }

  // 청크 해시 불일치는 1회 재시도 (스펙 6.1: 읽는 도중 라이브 DB 가 바뀐 경우를 걸러낸다).
  private readBinWithRetry(db: Db): Buffer | null {
    try {
      return readKv(db, DB_KEY);
    } catch (e) {
      if (!(e instanceof ChunkIntegrityError)) throw e;
      return readKv(db, DB_KEY);
    }
  }

  private readChats(db: Db, c: Json, only?: ScanOptions['only']): ChatRead[] {
    const raw = Array.isArray(c.chats) ? (c.chats as unknown[]) : [];
    const used = new Set<string>();
    const out: ChatRead[] = [];
    raw.forEach((item, n) => {
      const ch = (item && typeof item === 'object' ? item : {}) as Json;
      const baseId = typeof ch.id === 'string' && ch.id ? ch.id : `~noid${n}`;
      let chatId = baseId;
      for (let k = 2; used.has(chatId); k++) chatId = `${baseId}~dup${k}`;
      used.add(chatId);
      if (only && only.chatId !== chatId) return;
      out.push(this.readOneChat(db, ch, chatId));
    });
    return out;
  }

  private readOneChat(db: Db, ch: Json, chatId: string): ChatRead {
    if (!Array.isArray(ch.message)) return { ok: false, chatId, reason: 'chat has no message array' };
    let messages = ch.message as unknown[];
    const meta: Json = {};
    for (const [k, v] of Object.entries(ch)) if (k !== 'message') meta[k] = v;

    const coldKey = coldKeyOf(ch);
    if (coldKey !== null) {
      const cold = readColdChat(db, coldKey);
      if (!cold.ok) return { ok: false, chatId, reason: cold.reason };
      messages = cold.messages;
      Object.assign(meta, cold.extra);
    }
    const chat: RawChat = {
      chatId,
      title: typeof ch.name === 'string' ? ch.name : '',
      lastDate: typeof ch.lastDate === 'number' ? ch.lastDate : null,
      meta,
      messages,
    };
    return { ok: true, chat };
  }
}

// 캐릭터 표시 메타: 필요한 최소 필드만 (프롬프트·로어북 등 비대/민감 필드는 라이브러리에 두지 않는다).
function pickCharMeta(c: Json): Json {
  const out: Json = {};
  for (const k of ['name', 'image']) if (typeof c[k] === 'string') out[k] = c[k];
  for (const k of ['lastInteraction', 'creation_date', 'modification_date']) if (typeof c[k] === 'number') out[k] = c[k];
  const scripts = displayScripts(c.customscript);
  if (scripts.length) out.displayScripts = scripts;
  const imageRules = extractImageRules(c.customscript);
  if (imageRules.length) out.imageRules = imageRules;
  return out;
}

const MAX_DISPLAY_SCRIPTS = 50;
const MAX_SCRIPT_PATTERN = 500;

/** 숨김 규칙 후보 (스펙 §5.3, D28): editdisplay 스크립트의 이름·패턴·플래그만. 치환부(out)는 담지 않는다. */
function displayScripts(v: unknown): { comment: string; in: string; flag: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { comment: string; in: string; flag: string }[] = [];
  for (const s of v) {
    if (out.length >= MAX_DISPLAY_SCRIPTS) break;
    if (!s || typeof s !== 'object') continue;
    const o = s as Json;
    if (o.type !== 'editdisplay' || typeof o.in !== 'string' || o.in.length < 1 || o.in.length > MAX_SCRIPT_PATTERN) continue;
    const raw = o.ableFlag === true && typeof o.flag === 'string' ? o.flag : 'g';
    const flag = [...'gimsu'].filter((ch) => raw.includes(ch)).join('');
    out.push({ comment: typeof o.comment === 'string' ? o.comment.slice(0, 40) : '', in: o.in, flag });
  }
  return out;
}
