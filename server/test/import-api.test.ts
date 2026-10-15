import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { ExportManager } from '../src/export/jobs.js';
import { loggerOptions } from '../src/api/logging.js';
import { ImportStore } from '../src/import/store.js';
import { ImportAdapter } from '../src/source/import/adapter.js';
import { StateStore } from '../src/state/store.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (opened.length) await opened.pop()!.close(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SECRET = 'ZQ합성비밀문장ZQ';
const exp = (id: string, msgs: string[], type = 'risuChat') => {
  const message = msgs.map((m, i) => ({ role: i % 2 ? 'char' : 'user', data: m }));
  const c = { id, name: '합성', lastDate: 1, message };
  return type === 'risuChat' ? { type, ver: 2, data: c } : { type, ver: 2, data: [c] };
};
async function setup(opts: { withImports?: boolean; withExports?: boolean } = {}) {
  const h = makeHarness();
  await h.sync();
  const imports = new ImportStore(h.dataDir);
  const importAdapter = new ImportAdapter(imports);
  const state = new StateStore(h.dataDir);
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const exportManager = opts.withExports ? new ExportManager({ dir: path.join(h.dataDir, 'exports'), now: h.clock.now }) : undefined;
  const app = await buildApp({
    adapters: [h.adapter, importAdapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state,
    ...(opts.withImports === false ? {} : { imports }), ...(exportManager ? { exportManager } : {}), logger: loggerOptions('info', stream),
  });
  opened.push(app);
  return { h, app, imports, state, logs, exportManager };
}
type App = Awaited<ReturnType<typeof setup>>['app'];
const j = (r: { body: string }) => JSON.parse(r.body);
const newChar = async (app: App, name = '합성 캐릭터') => (j(await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name } })) as { charId: string }).charId;
const upload = (app: App, charId: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/import/chars/${charId}/chats`, payload: payload as object });
const putImage = (app: App, charId: string, body: Buffer) => app.inject({ method: 'PUT', url: `/api/import/chars/${charId}/image`, headers: { 'content-type': 'application/octet-stream' }, payload: body });
const chatsOf = async (app: App, charId: string) => j(await app.inject(`/api/chats?source=imported&char=${charId}`)) as { chatId: string }[];
const pos = { msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: 'a' };

describe('import characters', () => {
  it('creates, lists, renames; rejects bad bodies', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: '합성 캐릭터' } });
    expect(r.statusCode).toBe(201);
    const { charId } = j(r) as { charId: string };
    expect(charId).toMatch(/^[0-9a-f]{32}$/);
    expect(j(await app.inject('/api/import/chars'))).toEqual({ chars: [{ charId, name: '합성 캐릭터', hasImage: false, chatCount: 0 }] });
    expect(j(await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: '  ' } }))).toEqual({ error: 'bad-name' });
    expect((await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: 'x', extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: 'x'.repeat(61) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/import/chars/${charId}`, payload: { name: '새 이름' } })).statusCode).toBe(200);
    expect(j(await app.inject('/api/import/chars')).chars[0].name).toBe('새 이름');
    expect((await app.inject({ method: 'PUT', url: `/api/import/chars/${'0'.repeat(32)}`, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/import/chars/not-an-id', payload: { name: 'x' } })).statusCode).toBe(400);
  });

  it('is visible as the imported source and library character after a sync', async () => {
    const { app } = await setup();
    const charId = await newChar(app, '합성 캐릭터');
    await upload(app, charId, exp('a', ['1']));
    const chars = j(await app.inject('/api/chars?source=imported')) as { charId: string; displayName: string }[];
    expect(chars.map((c) => c.charId)).toEqual([charId]);
    expect(chars[0]!.displayName).toBe('합성 캐릭터');
    expect(j(await app.inject('/api/sources')).map((s: { id: string }) => s.id)).toEqual(['main', 'imported']);
  });

  it('image: set (200), bad bytes 400, over 10MB 413, then remove', async () => {
    const { app, imports } = await setup();
    const charId = await newChar(app);
    expect((await putImage(app, charId, PNG)).statusCode).toBe(200);
    expect(imports.imageFile(charId)?.ext).toBe('png');
    expect(j(await app.inject('/api/import/chars')).chars[0].hasImage).toBe(true);
    const list = j(await app.inject('/api/chars?source=imported')) as { imageUrl: string | null }[];
    expect(list[0]!.imageUrl).toMatch(/^\/api\/char-image\/imported\//);
    const bad = await putImage(app, charId, Buffer.from('not an image....'));
    expect(bad.statusCode).toBe(400);
    expect(j(bad)).toEqual({ error: 'bad-image' });
    expect((await putImage(app, charId, Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await putImage(app, '0'.repeat(32), PNG)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/image` })).statusCode).toBe(204);
    expect(imports.imageFile(charId)).toBeNull();
    expect(j(await app.inject('/api/chars?source=imported'))[0].imageUrl).toBeNull();
  });

  it('replacing or removing the image drops the old blob when nothing else uses it', async () => {
    const { app, h } = await setup();
    const charId = await newChar(app);
    await putImage(app, charId, PNG);
    const first = h.store.getCharImage('imported', charId)!.hash!;
    expect(fs.existsSync(h.store.blobPath(first))).toBe(true);
    await putImage(app, charId, Buffer.concat([PNG, Buffer.from([9])]));
    const second = h.store.getCharImage('imported', charId)!.hash!;
    expect(second).not.toBe(first);
    expect(fs.existsSync(h.store.blobPath(first))).toBe(false);
    await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/image` });
    expect(h.store.getCharImage('imported', charId)).toBeNull();
    expect(fs.existsSync(h.store.blobPath(second))).toBe(false);
  });
});

describe('import chats', () => {
  it('uploads (synced before the response), updates with a new version, reports unchanged, rejects bad input', async () => {
    const { app, h } = await setup();
    const charId = await newChar(app);
    const r = await upload(app, charId, exp('a', ['1', '2']));
    expect(r.statusCode).toBe(200);
    expect(j(r)).toEqual({ results: [{ chatId: 'a', title: '합성', messages: 2, status: 'new' }] });
    expect((await chatsOf(app, charId)).map((c) => c.chatId)).toEqual(['a']);
    const u = await upload(app, charId, exp('a', ['1', '2', '3']));
    expect(j(u).results[0].status).toBe('updated');
    expect(h.store.listVersions('imported', charId, 'a')).toHaveLength(2);
    expect(j(await upload(app, charId, exp('a', ['1', '2', '3']))).results[0].status).toBe('unchanged');
    const all = await upload(app, charId, exp('b', ['x'], 'risuAllChats'));
    expect(j(all).results[0]).toMatchObject({ chatId: 'b', status: 'new' });
    expect((await chatsOf(app, charId)).map((c) => c.chatId).sort()).toEqual(['a', 'b']);
    const bad = await upload(app, charId, { type: 'risuChat', ver: 1, data: {} });
    expect(bad.statusCode).toBe(400);
    expect(j(bad)).toEqual({ error: 'unsupported-format' });
    expect((await upload(app, '0'.repeat(32), exp('a', ['1']))).statusCode).toBe(404);
  });

  it('rejects more than 500 chats per file', async () => {
    const { app } = await setup();
    const charId = await newChar(app);
    const data = Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, name: 'n', message: [] }));
    const r = await upload(app, charId, { type: 'risuAllChats', ver: 2, data });
    expect(r.statusCode).toBe(400);
    expect(j(r)).toEqual({ error: 'too-many-chats' });
  });

  it('deletes a chat completely: library, bookmarks, file; the last chat takes the character with it', async () => {
    const { app, h, imports, state } = await setup();
    const charId = await newChar(app);
    await upload(app, charId, { type: 'risuAllChats', ver: 2, data: [{ id: 'a', name: '하나', message: [{ role: 'user', data: SECRET }] }, { id: 'b', name: '둘', message: [{ role: 'user', data: 'b' }] }] });
    const bm = await app.inject({ method: 'POST', url: `/api/state/bookmarks?source=imported&char=${charId}&chat=a`, payload: { kind: 'bookmark', start: pos } });
    expect(bm.statusCode).toBe(201);
    state.setKept('imported', charId, 'a', true, 1);

    const d = await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` });
    expect(d.statusCode).toBe(204);
    expect((await chatsOf(app, charId)).map((c) => c.chatId)).toEqual(['b']);
    expect(h.store.getChat('imported', charId, 'a')).toBeNull();
    expect(imports.listChatFiles(charId).map((f) => f.chatId)).toEqual(['b']);
    expect(state.countBookmarks('imported', charId, 'a')).toBe(0);
    expect(state.keptMap('imported', charId).size).toBe(0);
    // 지운 뒤 동기화가 다시 들여오지 않는다
    await h.syncer.syncSource(new ImportAdapter(imports), { force: true });
    expect(h.store.getChat('imported', charId, 'a')).toBeNull();
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` })).statusCode).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/b` })).statusCode).toBe(204);
    expect(imports.getChar(charId)).toBeNull();
    expect(fs.existsSync(path.join(imports.root, charId))).toBe(false);
    expect(h.store.listChars('imported', true)).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${'0'.repeat(32)}/chats/a` })).statusCode).toBe(404);
  });

  it('leaves the deleted text in none of library.db, state.db or their -wal files after the response', async () => {
    const { app, h, state } = await setup();
    const NOTE = 'ZQ합성책갈피문장QZ';
    const charId = await newChar(app, '합성 캐릭터 이름 ZQN');
    await upload(app, charId, { type: 'risuAllChats', ver: 2, data: [{ id: 'a', name: 'ZQ합성제목QZ', message: [{ role: 'user', data: SECRET }] }, { id: 'b', name: 'ZQ합성제목2QZ', message: [] }] });
    expect((await app.inject({ method: 'POST', url: `/api/state/bookmarks?source=imported&char=${charId}&chat=a`, payload: { kind: 'highlight', start: pos, end: { ...pos, charOffset: 3 }, text: NOTE } })).statusCode).toBe(201);
    const all = (f: string) => [f, `${f}-wal`].map((p) => (fs.existsSync(p) ? fs.readFileSync(p).toString('latin1') : '')).join('\n');
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
    const lib = path.join(h.dataDir, 'library', 'library.db');
    const st = path.join(h.dataDir, 'state', 'state.db');
    expect(all(lib)).toContain(enc('ZQ합성제목QZ'));
    expect(all(st)).toContain(enc(NOTE));

    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` })).statusCode).toBe(204);
    expect(all(lib)).not.toContain(enc('ZQ합성제목QZ'));
    expect(all(st)).not.toContain(enc(NOTE));
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(204);
    expect(all(lib)).not.toContain(enc('ZQ합성제목2QZ'));
    expect(all(lib)).not.toContain(enc('합성 캐릭터 이름 ZQN'));
    expect(state.countBookmarks('imported', charId, 'a')).toBe(0);
  });

  it('deletes a character with its chats, image and state', async () => {
    const { app, h, imports, state } = await setup();
    const charId = await newChar(app);
    await putImage(app, charId, PNG);
    await upload(app, charId, { type: 'risuAllChats', ver: 2, data: [{ id: 'a', name: '하나', message: [{ role: 'user', data: SECRET }] }, { id: 'b', name: '둘', message: [] }] });
    await app.inject({ method: 'POST', url: `/api/state/bookmarks?source=imported&char=${charId}&chat=b`, payload: { kind: 'bookmark', start: pos } });
    state.setAlias('imported', 'char', charId, '', '별칭', 1);
    const hash = h.store.getCharImage('imported', charId)!.hash!;

    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(204);
    expect(imports.listChars()).toEqual([]);
    expect(fs.existsSync(path.join(imports.root, charId))).toBe(false);
    expect(h.store.listChars('imported', true)).toEqual([]);
    expect(h.store.getCharImage('imported', charId)).toBeNull();
    expect(fs.existsSync(h.store.blobPath(hash))).toBe(false);
    expect(state.countBookmarks('imported', charId, 'b')).toBe(0);
    expect(state.aliasMap('imported', 'char').size).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(404);
    await h.syncer.syncSource(new ImportAdapter(imports), { force: true });
    expect(h.store.listChars('imported', true)).toEqual([]);
  });
});

describe('import API robustness', () => {
  it('syncs only the uploaded character: another character with a broken char.json does not block it', async () => {
    const { app, imports, h } = await setup();
    const a = await newChar(app, 'A');
    const b = await newChar(app, 'B');
    await upload(app, b, exp('b1', ['b']));
    fs.writeFileSync(path.join(imports.root, b, 'char.json'), '{broken');
    const r = await upload(app, a, exp('a1', ['1']));
    expect(r.statusCode).toBe(200);
    expect(j(r)).toEqual({ results: [{ chatId: 'a1', title: '합성', messages: 1, status: 'new' }] }); // sync 필드 없음 = 반영됨
    expect((await chatsOf(app, a)).map((c) => c.chatId)).toEqual(['a1']);
    expect(h.store.getChat('imported', b, 'b1')?.deletedAt).toBeNull(); // 이 캐릭터만 읽었으니 다른 캐릭터는 그대로
  });

  it('answers sync: pending (still 200, files saved) when the library could not take the chat yet', async () => {
    const { app, h, imports } = await setup();
    const charId = await newChar(app);
    const orig = h.store.ensureChat.bind(h.store);
    h.store.ensureChat = () => { throw new Error('boom'); };
    const r = await upload(app, charId, exp('a', ['1']));
    expect(r.statusCode).toBe(200);
    expect(j(r)).toMatchObject({ sync: 'pending', results: [{ chatId: 'a', status: 'new' }] });
    expect(imports.listChatFiles(charId).map((f) => f.chatId)).toEqual(['a']);
    h.store.ensureChat = orig;
    expect(j(await upload(app, charId, exp('a', ['1', '2'])))).not.toHaveProperty('sync');
  });

  it('deletes a character whose char.json is broken: the folder goes away and the next sync is complete', async () => {
    const { app, h, imports } = await setup();
    const charId = await newChar(app);
    await upload(app, charId, exp('a', ['1']));
    const other = await newChar(app, '멀쩡한 캐릭터');
    fs.writeFileSync(path.join(imports.root, charId, 'char.json'), '{broken');
    expect((await h.syncer.syncSource(new ImportAdapter(imports), { force: true })).outcome).toBe('skipped');
    // 목록에 broken 으로 보인다 (맨 뒤, 이름 없음) — 화면에서 지울 수 있게
    expect(j(await app.inject('/api/import/chars'))).toEqual({ chars: [
      { charId: other, name: '멀쩡한 캐릭터', hasImage: false, chatCount: 0 },
      { charId, name: '', broken: true, hasImage: false, chatCount: 1 },
    ] });
    expect((await upload(app, charId, exp('b', ['1']))).statusCode).toBe(404); // 올리기·이름 바꾸기는 안 된다
    expect((await app.inject({ method: 'PUT', url: `/api/import/chars/${charId}`, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(204);
    expect(j(await app.inject('/api/import/chars')).chars.map((c: { charId: string }) => c.charId)).toEqual([other]);
    expect(fs.existsSync(path.join(imports.root, charId))).toBe(false);
    expect(h.store.getChat('imported', charId, 'a')).toBeNull();
    expect((await h.syncer.syncSource(new ImportAdapter(imports), { force: true })).outcome).toBe('synced');
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(404);
  });
});

describe('import deletes the exports made from it', () => {
  const exportOf = async (app: App, charId: string, chatId: string, format = 'json') => {
    const r = await app.inject({ method: 'POST', url: `/api/export?source=imported&char=${charId}&chat=${chatId}`, payload: { format } });
    expect(r.statusCode).toBe(202);
    return (j(r) as { jobId: string }).jobId;
  };
  const exportFiles = (h: { dataDir: string }, jobId: string) =>
    fs.readdirSync(path.join(h.dataDir, 'exports')).filter((f) => f.startsWith(jobId));

  it('deleting a chat removes its finished export (404, no files) and keeps the other chat\'s', async () => {
    const { app, h, exportManager } = await setup({ withExports: true });
    const charId = await newChar(app);
    await upload(app, charId, { type: 'risuAllChats', ver: 2, data: [{ id: 'a', name: '하나', message: [{ role: 'user', data: SECRET }] }, { id: 'b', name: '둘', message: [{ role: 'user', data: 'b' }] }] });
    const ja = await exportOf(app, charId, 'a');
    const jb = await exportOf(app, charId, 'b');
    await exportManager!.idle();
    expect(j(await app.inject(`/api/export/${ja}`)).state).toBe('done');
    expect(exportFiles(h, ja).length).toBe(2);
    const status = fs.readFileSync(path.join(h.dataDir, 'exports', `${ja}.status.json`), 'utf8');
    expect(status).not.toContain('하나');
    expect(status).not.toContain('합성 캐릭터');

    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` })).statusCode).toBe(204);
    expect((await app.inject(`/api/export/${ja}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/export/${ja}/download`)).statusCode).toBe(404);
    expect(exportFiles(h, ja)).toEqual([]);
    expect(j(await app.inject(`/api/export/${jb}`)).state).toBe('done');
  });

  it('deleting a character removes the exports of all its chats, including one still waiting', async () => {
    const { app, h, exportManager } = await setup({ withExports: true });
    const charId = await newChar(app);
    const other = await newChar(app, '다른 캐릭터');
    await upload(app, charId, { type: 'risuAllChats', ver: 2, data: [{ id: 'a', name: '하나', message: [{ role: 'user', data: SECRET }] }, { id: 'b', name: '둘', message: [{ role: 'user', data: 'b' }] }] });
    await upload(app, other, exp('o', ['o']));
    const ja = await exportOf(app, charId, 'a');
    await exportManager!.idle();
    const jb = await exportOf(app, charId, 'b', 'epub'); // 아직 대기·실행 중
    const jo = await exportOf(app, other, 'o');
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/export/${jb}`)).statusCode).toBe(404);
    await exportManager!.idle();
    for (const id of [ja, jb]) {
      expect((await app.inject(`/api/export/${id}`)).statusCode).toBe(404);
      expect(exportFiles(h, id)).toEqual([]);
    }
    expect(j(await app.inject(`/api/export/${jo}`)).state).toBe('done');
  });

  it('deleting a character still finishes state, exports, files and the checkpoint when its image blob cannot be removed', async () => {
    const { app, h, imports, state, exportManager } = await setup({ withExports: true });
    const charId = await newChar(app);
    await putImage(app, charId, PNG);
    await upload(app, charId, exp('a', [SECRET]));
    await app.inject({ method: 'POST', url: `/api/state/bookmarks?source=imported&char=${charId}&chat=a`, payload: { kind: 'bookmark', start: pos } });
    const ja = await exportOf(app, charId, 'a');
    await exportManager!.idle();
    const blob = h.store.blobPath(h.store.getCharImage('imported', charId)!.hash!);
    const real = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === blob) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real(p, o);
    }) as typeof fs.rmSync);
    const checkpoint = vi.spyOn(state, 'checkpoint');

    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}` })).statusCode).toBe(204);
    expect(state.countBookmarks('imported', charId, 'a')).toBe(0);
    expect((await app.inject(`/api/export/${ja}`)).statusCode).toBe(404);
    expect(exportFiles(h, ja)).toEqual([]);
    expect(fs.existsSync(path.join(imports.root, charId))).toBe(false);
    expect(checkpoint).toHaveBeenCalled();
    expect(h.store.listChars('imported', true)).toEqual([]);
  });

  it('deleting the last chat (which takes the character) removes its export too', async () => {
    const { app, h, exportManager } = await setup({ withExports: true });
    const charId = await newChar(app);
    await upload(app, charId, exp('a', ['1']));
    const ja = await exportOf(app, charId, 'a');
    await exportManager!.idle();
    expect((await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` })).statusCode).toBe(204);
    expect((await app.inject(`/api/export/${ja}`)).statusCode).toBe(404);
    expect(exportFiles(h, ja)).toEqual([]);
  });
});

describe('import API switches and logs', () => {
  it('is not mounted without imports', async () => {
    const { app } = await setup({ withImports: false });
    expect((await app.inject('/api/import/chars')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/import/chars', payload: { name: 'x' } })).statusCode).toBe(404);
  });

  it('keeps chat content and names out of responses to errors and out of logs', async () => {
    const { app, logs } = await setup();
    const charId = await newChar(app, '로그에없어야할이름');
    const bad = await upload(app, charId, { type: 'risuChat', ver: 1, data: { message: [{ data: SECRET }] } });
    expect(bad.body).not.toContain(SECRET);
    await upload(app, charId, exp('a', [SECRET]));
    await app.inject({ method: 'DELETE', url: `/api/import/chars/${charId}/chats/a` });
    const out = logs.join('\n');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('로그에없어야할이름');
  });
});
