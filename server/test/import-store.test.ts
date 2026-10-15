import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedChat } from '../src/import/format.js';
import { ImportStore } from '../src/import/store.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function setup() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'page-imp-')); dirs.push(d); return { d, s: new ImportStore(d) }; }
const pc = (id: string | null, msgs: string[], title = '합성'): ParsedChat => {
  const messages = msgs.map((m) => ({ role: 'char', data: m }));
  return { id, title, lastDate: 1, messages, raw: { ...(id ? { id } : {}), name: title, lastDate: 1, message: messages } };
};
// Windows 에는 POSIX 권한 비트가 없다 (mode 가 늘 0o666). 권한 단언만 건너뛴다.
const POSIX = process.platform !== 'win32';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('ImportStore', () => {
  it('creates, renames, lists characters (0700 dir), rejects bad names', () => {
    const { d, s } = setup();
    const id = s.createChar('합성 캐릭터', 10);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    if (POSIX) expect((fs.statSync(path.join(d, 'imports')).mode & 0o777)).toBe(0o700);
    expect(s.renameChar(id, '새 이름')).toBe(true);
    expect(s.listChars()).toEqual([{ charId: id, name: '새 이름', hasImage: false, chatCount: 0, createdAt: 10 }]);
    expect(() => s.createChar('  ', 1)).toThrow('bad-name');
    expect(s.renameChar('0'.repeat(32), 'x')).toBe(false);
  });

  it('puts chats: new, updated (same id), unchanged, and new for id-less chats', () => {
    const { s } = setup();
    const c = s.createChar('c', 1);
    expect(s.putChats(c, [pc('a', ['1'])]).map((r) => r.status)).toEqual(['new']);
    expect(s.putChats(c, [pc('a', ['1', '2'])])).toEqual([{ chatId: 'a', title: '합성', messages: 2, status: 'updated' }]);
    expect(s.putChats(c, [pc('a', ['1', '2'])])[0]!.status).toBe('unchanged');
    const r = s.putChats(c, [pc(null, ['x']), pc('bad id!', ['y'])]);
    expect(r.map((x) => x.status)).toEqual(['new', 'new']);
    expect(r.every((x) => /^[0-9a-f]{32}$/.test(x.chatId))).toBe(true);
    expect(s.listChatFiles(c).map((f) => f.chatId).sort()).toEqual(['a', r[0]!.chatId, r[1]!.chatId].sort());
  });

  it('image: set (sniffed), replace, remove; rejects non-images', () => {
    const { s } = setup();
    const c = s.createChar('c', 1);
    expect(s.setImage(c, PNG)).toBe('png');
    expect(s.imageFile(c)?.ext).toBe('png');
    expect(() => s.setImage(c, Buffer.from('not an image....'))).toThrow('bad-image');
    expect(s.removeImage(c)).toBe(true);
    expect(s.imageFile(c)).toBeNull();
  });

  it('deletes chats and characters; fingerprint follows changes', () => {
    const { s } = setup();
    const c = s.createChar('c', 1);
    const f0 = s.fingerprint();
    s.putChats(c, [pc('a', ['1'])]);
    const f1 = s.fingerprint();
    expect(f1).not.toBe(f0);
    expect(s.deleteChat(c, 'a')).toBe(true);
    expect(s.deleteChat(c, 'a')).toBe(false);
    expect(s.deleteChar(c)).toBe(true);
    expect(s.listChars()).toEqual([]);
  });

  it('never leaves its folder: path-escaping ids are refused', () => {
    const { d, s } = setup();
    const c = s.createChar('c', 1);
    const outside = path.join(d, 'imports', 'chars', c, 'x.json'); // chats/../x
    fs.writeFileSync(outside, '{}');
    expect(s.deleteChat(c, '../x')).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(s.deleteChat('../..', 'a')).toBe(false);
    expect(s.getChar('../..')).toBeNull();
    expect(s.getChar('../' + 'a'.repeat(30))).toBeNull();
    expect(s.imageFile('../..')).toBeNull();
    expect(s.listChatFiles('../..')).toEqual([]);
    expect(s.deleteChar('../..')).toBe(false);
    expect(() => s.setImage('../..', PNG)).toThrow('not-found');
    // 채팅 id 가 경로 모양이면 새 id 로 저장된다 (파일은 chats 폴더 안에만)
    const r = s.putChats(c, [pc('../evil', ['x'])]);
    expect(r[0]!.chatId).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readdirSync(path.join(d, 'imports', 'chars', c, 'chats'))).toEqual([`${r[0]!.chatId}.json`]);
  });

  it('treats a character folder without a valid char.json as broken, not as a character', () => {
    const { d, s } = setup();
    const ok = s.createChar('ok', 1);
    const bad = s.createChar('bad', 2);
    const dir = (id: string) => path.join(d, 'imports', 'chars', id);
    fs.writeFileSync(path.join(dir(bad), 'char.json'), JSON.stringify({ name: 3, createdAt: 2 }));
    expect(s.brokenChars()).toEqual([bad]);
    expect(s.listChars().map((c) => [c.charId, !!c.broken])).toEqual([[ok, false], [bad, true]]);
    expect(s.getChar(bad)).toBeNull();
    fs.writeFileSync(path.join(dir(bad), 'char.json'), '{broken');
    expect(s.brokenChars()).toEqual([bad]);
    fs.writeFileSync(path.join(dir(bad), 'char.json'), JSON.stringify({ name: 'x' }));
    expect(s.brokenChars()).toEqual([bad]);
    fs.writeFileSync(path.join(dir(bad), 'char.json'), JSON.stringify({ name: 'x', createdAt: 2 }));
    expect(s.brokenChars()).toEqual([]);
  });

  it('lists broken characters (bad char.json, or an empty folder without one) last, so they can be deleted', () => {
    const { d, s } = setup();
    const bad = s.createChar('bad', 5);
    s.putChats(bad, [pc('a', ['1']), pc('b', ['2'])]);
    s.setImage(bad, PNG);
    const ok = s.createChar('ok', 9);
    fs.writeFileSync(path.join(d, 'imports', 'chars', bad, 'char.json'), '{broken');
    // 깨진 캐릭터끼리는 charId 순이다. bad 의 id 는 무작위라 'e…' 로 두면 bad 가 'f…' 일 때(약 1/16) 순서가 뒤집힌다. 'f…' 는 어떤 id 보다 뒤다.
    const empty = 'f'.repeat(32);
    fs.mkdirSync(path.join(d, 'imports', 'chars', empty));
    fs.mkdirSync(path.join(d, 'imports', 'chars', 'not-an-id'));
    expect(s.listChars()).toEqual([
      { charId: ok, name: 'ok', hasImage: false, chatCount: 0, createdAt: 9 },
      { charId: bad, name: '', broken: true, hasImage: true, chatCount: 2, createdAt: 0 },
      { charId: empty, name: '', broken: true, hasImage: false, chatCount: 0, createdAt: 0 },
    ]);
    const before = s.fingerprint();
    fs.rmSync(path.join(d, 'imports', 'chars', empty), { recursive: true });
    expect(s.fingerprint()).toBe(before); // 지문은 읽을 수 있는 캐릭터만 본다 (지금 그대로)
  });

  it('deleteChar can be retried after a partial delete and works on a broken char.json', () => {
    const { d, s } = setup();
    const c = s.createChar('c', 1);
    s.putChats(c, [pc('a', ['1'])]);
    s.setImage(c, PNG);
    const dir = path.join(d, 'imports', 'chars', c);
    // 중간에 멈춘 모습: 채팅·그림은 지워졌고 char.json 만 남음
    fs.rmSync(path.join(dir, 'chats'), { recursive: true });
    fs.rmSync(path.join(dir, 'image.png'));
    expect(s.charDirExists(c)).toBe(true);
    expect(s.deleteChar(c)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(s.deleteChar(c)).toBe(false);
    const b = s.createChar('b', 2);
    fs.writeFileSync(path.join(d, 'imports', 'chars', b, 'char.json'), '{broken');
    expect(s.getChar(b)).toBeNull();
    expect(s.deleteChar(b)).toBe(true);
    expect(s.charDirExists(b)).toBe(false);
    expect(s.charDirExists('../..')).toBe(false);
  });
});
