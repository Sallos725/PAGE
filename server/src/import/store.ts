// 가져온 채팅 파일 저장소 (임포트 스펙 §3). page-data/imports/chars/<charId>/{char.json,image.<ext>,chats/<chatId>.json}
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from '../canon.js';
import { withRetry } from '../util/fs-retry.js';
import { IMPORT_LIMITS, type ParsedChat } from './format.js';

/** broken: 폴더는 있는데 char.json 을 못 읽는 캐릭터 (이름 '', createdAt 0). 지우기만 할 수 있다. */
export type ImportCharInfo = { charId: string; name: string; broken?: true; hasImage: boolean; chatCount: number; createdAt: number };
export type ImportResult = { chatId: string; title: string; messages: number; status: 'new' | 'updated' | 'unchanged' };
const ID = /^[0-9a-f]{32}$/;
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const newId = () => randomBytes(16).toString('hex');
// eslint-disable-next-line no-control-regex
export const cleanName = (s: string) => Array.from(s.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, IMPORT_LIMITS.nameMax).join('').trim();

function sniffImage(b: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const h = Buffer.from(b.subarray(0, 12));
  if (h.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (h.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpg';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  withRetry(() => fs.renameSync(tmp, file)); // Windows: 백신·OneDrive 의 순간 잠금
}

export class ImportStore {
  readonly root: string;
  constructor(dataDir: string) {
    const base = path.join(dataDir, 'imports');
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(base, 0o700); } catch { /* 권한이 없으면 무시 */ }
    this.root = path.join(base, 'chars');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private dir(charId: string) {
    if (!ID.test(charId)) throw new Error('bad-id');
    return path.join(this.root, charId);
  }

  /** char.json 을 읽는다. 없거나 깨졌거나 name(문자열)·createdAt(숫자)가 아니면 null. */
  private readChar(charId: string): { name: string; createdAt: number } | null {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dir(charId), 'char.json'), 'utf8')) as { name?: unknown; createdAt?: unknown } | null;
      if (!v || typeof v.name !== 'string' || typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
      return { name: v.name, createdAt: v.createdAt };
    } catch { return null; }
  }

  /** 폴더는 있는데 char.json 을 못 읽는 캐릭터 id 들. 동기화가 삭제 판단을 미루는 데 쓴다. */
  brokenChars(): string[] {
    return fs.readdirSync(this.root).filter((id) => ID.test(id) && this.readChar(id) === null).sort();
  }

  /** 캐릭터 목록. char.json 을 못 읽는 폴더도 `broken: true` 로 맨 뒤에 낸다 (화면에서 지울 수 있게). */
  listChars(): ImportCharInfo[] {
    const out: ImportCharInfo[] = [];
    for (const charId of fs.readdirSync(this.root)) {
      if (!ID.test(charId)) continue;
      try { if (!fs.statSync(this.dir(charId)).isDirectory()) continue; } catch { continue; }
      const c = this.readChar(charId);
      const files = { hasImage: this.imageFile(charId) !== null, chatCount: this.listChatFiles(charId).length };
      out.push(c ? { charId, name: c.name, ...files, createdAt: c.createdAt } : { charId, name: '', broken: true, ...files, createdAt: 0 });
    }
    return out.sort((a, b) => Number(!!a.broken) - Number(!!b.broken) || a.createdAt - b.createdAt || a.charId.localeCompare(b.charId));
  }

  getChar(charId: string) { return ID.test(charId) ? this.readChar(charId) : null; }

  createChar(name: string, now: number): string {
    const n = cleanName(name);
    if (!n) throw new Error('bad-name');
    const charId = newId();
    const d = this.dir(charId);
    fs.mkdirSync(path.join(d, 'chats'), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(d, 'char.json'), JSON.stringify({ name: n, createdAt: now }));
    return charId;
  }

  renameChar(charId: string, name: string): boolean {
    const c = this.getChar(charId);
    const n = cleanName(name);
    if (!c) return false;
    if (!n) throw new Error('bad-name');
    writeAtomic(path.join(this.dir(charId), 'char.json'), JSON.stringify({ ...c, name: n }));
    return true;
  }

  imageFile(charId: string): { path: string; ext: string; size: number; mtimeMs: number } | null {
    if (!ID.test(charId)) return null;
    for (const ext of ['png', 'jpg', 'webp']) {
      const p = path.join(this.dir(charId), `image.${ext}`);
      try { const st = fs.statSync(p); return { path: p, ext, size: st.size, mtimeMs: st.mtimeMs }; } catch { /* 다음 */ }
    }
    return null;
  }

  setImage(charId: string, bytes: Uint8Array): string {
    if (!this.getChar(charId)) throw new Error('not-found');
    if (bytes.length > IMPORT_LIMITS.imageBytes) throw new Error('too-large');
    const ext = sniffImage(bytes);
    if (!ext) throw new Error('bad-image');
    this.removeImage(charId);
    writeAtomic(path.join(this.dir(charId), `image.${ext}`), bytes);
    return ext;
  }

  removeImage(charId: string): boolean {
    const f = this.imageFile(charId);
    if (!f) return false;
    withRetry(() => fs.rmSync(f.path, { force: true }));
    return true;
  }

  listChatFiles(charId: string): { chatId: string; path: string; size: number; mtimeMs: number }[] {
    if (!ID.test(charId)) return [];
    const d = path.join(this.dir(charId), 'chats');
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => CHAT_ID.test(id)).sort()
      .map((chatId) => { const p = path.join(d, `${chatId}.json`); const st = fs.statSync(p); return { chatId, path: p, size: st.size, mtimeMs: st.mtimeMs }; });
  }

  putChats(charId: string, chats: ParsedChat[]): ImportResult[] {
    if (!this.getChar(charId)) throw new Error('not-found');
    const d = path.join(this.dir(charId), 'chats');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return chats.map((c) => {
      const chatId = c.id && CHAT_ID.test(c.id) ? c.id : newId();
      const file = path.join(d, `${chatId}.json`);
      const body = JSON.stringify(c.raw);
      let status: ImportResult['status'] = 'new';
      if (fs.existsSync(file)) {
        let same = false;
        try { same = canon(JSON.parse(fs.readFileSync(file, 'utf8'))) === canon(c.raw); } catch { /* 깨진 파일은 덮어쓴다 */ }
        status = same ? 'unchanged' : 'updated';
      }
      if (status !== 'unchanged') writeAtomic(file, body);
      return { chatId, title: c.title, messages: c.messages.length, status };
    });
  }

  deleteChat(charId: string, chatId: string): boolean {
    if (!ID.test(charId) || !CHAT_ID.test(chatId)) return false;
    const p = path.join(this.dir(charId), 'chats', `${chatId}.json`);
    if (!fs.existsSync(p)) return false;
    withRetry(() => fs.rmSync(p, { force: true }));
    return true;
  }

  /** 캐릭터 폴더가 있는가 (char.json 이 깨져 있어도 true — 지우기를 다시 시도할 수 있게). */
  charDirExists(charId: string): boolean {
    if (!ID.test(charId)) return false;
    try { return fs.statSync(this.dir(charId)).isDirectory(); } catch { return false; }
  }

  /**
   * 폴더가 있으면 지운다 (char.json 이 깨졌어도). 채팅·그림을 먼저, char.json 을 마지막에 지운다 —
   * 도중에 멈춰도 char.json 이 남아 있는 동안은 같은 캐릭터로 다시 지울 수 있다.
   */
  deleteChar(charId: string): boolean {
    if (!this.charDirExists(charId)) return false;
    const d = this.dir(charId);
    withRetry(() => fs.rmSync(path.join(d, 'chats'), { recursive: true, force: true }));
    this.removeImage(charId);
    withRetry(() => fs.rmSync(path.join(d, 'char.json'), { force: true }));
    withRetry(() => fs.rmSync(d, { recursive: true, force: true }));
    return true;
  }

  /** 폴더 전체의 지문 (경로·크기·수정 시각). 바뀐 게 없으면 동기화를 건너뛴다. */
  fingerprint(): string {
    const h = createHash('sha256');
    for (const c of this.listChars()) {
      if (c.broken) continue; // 읽을 수 있는 캐릭터만 (깨진 폴더는 어댑터가 따로 본다)
      h.update(`c:${c.charId}:${c.name}\n`);
      const img = this.imageFile(c.charId);
      if (img) h.update(`i:${img.ext}:${img.size}:${Math.floor(img.mtimeMs)}\n`);
      for (const f of this.listChatFiles(c.charId)) h.update(`f:${f.chatId}:${f.size}:${Math.floor(f.mtimeMs)}\n`);
    }
    return h.digest('hex');
  }
}
