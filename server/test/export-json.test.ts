import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { produceJson, risuChatJson } from '../src/export/json.js';
import { chatVersion } from '../src/export/source.js';
import { msg } from '../src/tools/synthetic-source.js';
import { baseSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

describe('risuChat JSON', () => {
  it('wraps the version meta and raw messages; drops folderId; empty folders', () => {
    const out = JSON.parse(risuChatJson(JSON.stringify({ id: 'x', name: '합성', note: 'n', folderId: 'f1' }), ['{"data":"a","role":"user"}', '{"data":"b","role":"char","time":5}']));
    expect(out).toEqual({
      type: 'risuChat', ver: 2,
      data: { id: 'x', name: '합성', note: 'n', message: [{ data: 'a', role: 'user' }, { data: 'b', role: 'char', time: 5 }] },
      folders: [],
    });
  });

  it('handles an empty meta and keeps escapes/unicode in raw messages intact', () => {
    const raw = ['{"data":"줄\\n바꿈 \\"따옴표\\"","role":"char"}', '{"data":"b","role":"user"}'];
    const out = JSON.parse(risuChatJson('{}', raw));
    expect(out.data.message).toHaveLength(2);
    expect(out.data.message[0]).toEqual({ data: '줄\n바꿈 "따옴표"', role: 'char' });
    expect(risuChatJson('{"message":[1],"folderId":"f"}', [])).toBe('{"type":"risuChat","ver":2,"data":{"message":[]},"folders":[]}');
  });

  it('exports the head version by default and an older version on request', async () => {
    const s = baseSpec();
    s.characters[0]!.chats[0]!.folderId = 'f1';
    s.characters[0]!.chats[0]!.note = '합성 노트';
    const h = makeHarness({ spec: s });
    await h.sync();
    h.clock.advance(60_000);
    h.rewrite((sp) => { sp.characters[0]!.chats[0]!.message.push(msg('user', 'u3')); });
    await h.sync({ force: true });

    const head = chatVersion(h.store, 'main', 'c1', 'a1')!;
    expect(head.hashes).toHaveLength(5);
    const versions = h.store.listVersions('main', 'c1', 'a1');
    const first = chatVersion(h.store, 'main', 'c1', 'a1', versions[0]!.versionId)!;
    expect(first.hashes).toHaveLength(4);

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-j-')), 'out.json');
    expect(await produceJson(h.store, first, tmp)).toEqual({ warnings: { missingImages: 0, skippedImages: 0, slowRules: [] } });
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(out.type).toBe('risuChat');
    expect(out.data.note).toBe('합성 노트');
    expect(out.data).not.toHaveProperty('folderId');
    expect(out.data.message.map((m: { data: string }) => m.data)).toEqual(['u1', 'm1', 'u2', 'm2']);
  });

  it('returns null for unknown chats and versions of another chat', async () => {
    const h = makeHarness();
    await h.sync();
    expect(chatVersion(h.store, 'main', 'c1', 'nope')).toBeNull();
    const other = h.store.listVersions('main', 'c2', 'b1')[0]!.versionId;
    expect(chatVersion(h.store, 'main', 'c1', 'a1', other)).toBeNull();
    expect(chatVersion(h.store, 'main', 'c1', 'a1', 999_999)).toBeNull();
  });

  it('passes lastDate and raw message fields (chatId, time) through untouched', async () => {
    const s = baseSpec();
    const c = s.characters[0]!.chats[0]!;
    c.lastDate = 1234;
    c.message[0] = msg('user', 'u1', { chatId: 'k1', time: 5 });
    const h = makeHarness({ spec: s });
    await h.sync();

    const head = chatVersion(h.store, 'main', 'c1', 'a1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-j-')), 'out.json');
    await produceJson(h.store, head, tmp);
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(out.data.lastDate).toBe(1234);
    expect(out.data.message[0]).toMatchObject({ chatId: 'k1', time: 5 });
  });

  it('can still export a chat that was deleted in the source', async () => {
    const h = makeHarness();
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats = s.characters[0]!.chats.slice(1); });
    h.clock.advance(60_000);
    await h.sync({ force: true, acceptMassDeletion: true });

    expect(h.store.getChat('main', 'c1', 'a1')!.deletedAt).not.toBeNull();
    const cv = chatVersion(h.store, 'main', 'c1', 'a1');
    expect(cv).not.toBeNull();
    expect(cv!.hashes).toHaveLength(4);
  });
});
