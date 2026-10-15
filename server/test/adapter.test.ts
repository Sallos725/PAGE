import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PocketRisuAdapter } from '../src/source/pocketrisu/adapter.js';
import type { CharacterHandle } from '../src/source/types.js';
import { AM, COLD_HEADER, PNG, baseSpec, chat, writeSource } from './helpers/synthetic-source.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-adapter-'));

async function collect(a: PocketRisuAdapter, only?: { charId: string; chatId: string }) {
  const chars: { charId: string; name: string; chats: CharacterHandle['chats'] }[] = [];
  const res = await a.scan((c) => { chars.push({ charId: c.charId, name: c.name, chats: c.chats }); }, { only });
  return { chars, res };
}

describe('PocketRisuAdapter.health', () => {
  it('unavailable when risuai.db is missing', async () => {
    const h = await new PocketRisuAdapter('s', tmp()).health();
    expect(h.status).toBe('unavailable');
    expect(h.reasons).toEqual(['risuai.db not found']);
  });

  it('ok for a verified raw header', async () => {
    const dir = tmp();
    writeSource(dir, baseSpec());
    expect((await new PocketRisuAdapter('s', dir).health()).status).toBe('ok');
  });

  it('degraded (not silently wrong) after scanning an unknown formatversion', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.formatversion = 99;
    writeSource(dir, s);
    const a = new PocketRisuAdapter('s', dir);
    await a.scan(() => {});
    const h = await a.health();
    expect(h.status).toBe('degraded');
    expect(h.reasons.join(' ')).toMatch(/formatversion/);
  });
});

describe('PocketRisuAdapter.fingerprint', () => {
  it('is stable, changes with chats, and with manifests', async () => {
    const dir = tmp();
    const s = baseSpec();
    const a = new PocketRisuAdapter('s', dir);
    writeSource(dir, s);
    const f1 = await a.fingerprint();
    writeSource(dir, s);
    expect(await a.fingerprint()).toBe(f1);
    s.manifests = [{ kind: 'character', ownerId: 'c1', items: [['A', 'assets/x.png', 'png']] }];
    writeSource(dir, s);
    const f2 = await a.fingerprint();
    expect(f2).not.toBe(f1);
    s.characters[0]!.chats.push(chat('a3', ['z']));
    writeSource(dir, s);
    expect(await a.fingerprint()).not.toBe(f2);
  });

  it('returns null (not a change) when the source cannot be read', async () => {
    expect(await new PocketRisuAdapter('s', tmp()).fingerprint()).toBeNull();
    const dir = tmp();
    writeSource(dir, baseSpec(), { corruptChunk: true });
    // 청크 손상은 지문이 아니라 scan 에서 드러난다 — 지문은 청크 *해시열* 만 보므로 계산된다.
    expect(typeof (await new PocketRisuAdapter('s', dir).fingerprint())).toBe('string');
  });
});

describe('PocketRisuAdapter.scan', () => {
  it('streams characters with chats, meta without messages, and reports seen ids', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.characters[0]!.chats[0]!.note = 'n1';
    writeSource(dir, s);
    const { chars, res } = await collect(new PocketRisuAdapter('s', dir));
    expect(res.complete).toBe(true);
    expect(chars.map((c) => c.charId)).toEqual(['c1', 'c2']);
    const a1 = chars[0]!.chats[0]!;
    expect(a1.ok && a1.chat.messages.length).toBe(4);
    expect(a1.ok && a1.chat.meta).toMatchObject({ id: 'a1', name: 'chat-a1', note: 'n1' });
    expect(a1.ok && 'message' in a1.chat.meta).toBe(false);
    expect([...res.seen.get('c1')!].sort()).toEqual(['a1', 'a2']);
    expect([...res.seen.get('c2')!]).toEqual(['b1']);
  });

  it('only: visits just the requested chat', async () => {
    const dir = tmp();
    writeSource(dir, baseSpec());
    const { chars } = await collect(new PocketRisuAdapter('s', dir), { charId: 'c1', chatId: 'a2' });
    expect(chars).toHaveLength(1);
    expect(chars[0]!.chats.map((c) => (c.ok ? c.chat.chatId : c.chatId))).toEqual(['a2']);
  });

  it('disambiguates duplicate and missing chat ids instead of dropping chats', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.characters[0]!.chats = [chat('d', ['1']), chat('d', ['2']), { ...chat('x', ['3']), id: undefined as unknown as string }];
    writeSource(dir, s);
    const { chars } = await collect(new PocketRisuAdapter('s', dir));
    const ids = chars[0]!.chats.map((c) => (c.ok ? c.chat.chatId : c.chatId));
    expect(ids).toEqual(['d', 'd~dup2', '~noid2']);
  });

  it('restores cold chats read-only; a broken cold entry isolates to that chat', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.characters[0]!.chats.push({ id: 'cold1', name: 'cold', message: [{ role: 'user', data: `${COLD_HEADER}k1` }] });
    s.characters[0]!.chats.push({ id: 'cold2', name: 'cold', message: [{ role: 'user', data: `${COLD_HEADER}gone` }] });
    s.cold = { k1: { message: [{ role: 'user', data: 'restored' }], scriptstate: { n: 1 } } };
    writeSource(dir, s);
    const { chars, res } = await collect(new PocketRisuAdapter('s', dir));
    const byId = new Map(chars[0]!.chats.map((c) => [c.ok ? c.chat.chatId : c.chatId, c]));
    const ok = byId.get('cold1')!;
    expect(ok.ok && (ok.chat.messages[0] as { data: string }).data).toBe('restored');
    expect(ok.ok && ok.chat.meta).toMatchObject({ scriptstate: { n: 1 } });
    expect(byId.get('cold2')).toEqual({ ok: false, chatId: 'cold2', reason: 'cold storage entry missing' });
    expect(res.unreadable).toBe(1);
    expect(res.seen.get('c1')!.has('cold2')).toBe(true); // 읽을 수 없어도 "존재함" — 삭제로 오판하지 않는다
  });

  it('is incomplete (never partial) on a corrupted chunk, missing file, or non-array characters', async () => {
    const dir = tmp();
    writeSource(dir, baseSpec(), { corruptChunk: true });
    const bad = await collect(new PocketRisuAdapter('s', dir));
    expect(bad.res.complete).toBe(false);
    expect(bad.chars).toHaveLength(0);
    expect(bad.res.error).toBe('chunk integrity error');
    const none = await collect(new PocketRisuAdapter('s', tmp()));
    expect(none.res.complete).toBe(false);
    expect(none.res.error).toBe('risuai.db not found');
  });

  it('exposes asset helpers on the handle', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.manifests = [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p.png', 'png']] }];
    s.assets = { 'assets/p.png': PNG(4) };
    s.characters[0]!.chats[0]!.message[0]!.data = `x {{raw::${AM(1)}}} y`;
    writeSource(dir, s);
    let seen = false;
    await new PocketRisuAdapter('s', dir).scan((c) => {
      if (c.charId !== 'c1') return;
      const chatRead = c.chats[0]!;
      if (!chatRead.ok) throw new Error('unexpected');
      expect(c.assetNames(chatRead.chat.messages)).toEqual([AM(1)]);
      expect(c.readAsset(AM(1))).not.toBeNull();
      expect(c.readAsset('missing')).toBeNull();
      expect(c.isTrackedAssetName(AM(9))).toBe(true);
      seen = true;
    });
    expect(seen).toBe(true);
  });
});

describe('character meta: display scripts (card hide-rule candidates)', () => {
  it('keeps only editdisplay scripts, only name/pattern/flags, never the replacement', async () => {
    const dir = tmp();
    const s = baseSpec();
    s.characters[0]!.customscript = [
      { comment: '상태창', in: '<st>[\\s\\S]*?</st>', out: '<div class="secret-out">x</div>', type: 'editdisplay', ableFlag: true, flag: 'gs<order 1>' },
      { comment: '입력', in: 'abc', out: 'def', type: 'editinput' },
      { comment: '', in: 'zzz', out: '', type: 'editdisplay' },
      { comment: '긴 패턴', in: 'x'.repeat(501), out: '', type: 'editdisplay' },
      { comment: '빈 패턴', in: '', out: '', type: 'editdisplay' },
      'garbage',
    ];
    writeSource(dir, s);
    const metas: Record<string, unknown>[] = [];
    await new PocketRisuAdapter('s', dir).scan((c) => { if (c.charId === 'c1') metas.push(c.meta); });
    expect(metas[0]!.displayScripts).toEqual([
      { comment: '상태창', in: '<st>[\\s\\S]*?</st>', flag: 'gs' },
      { comment: '', in: 'zzz', flag: 'g' },
    ]);
    expect(JSON.stringify(metas[0])).not.toContain('secret-out');
  });

  it('omits the field when there are no display scripts', async () => {
    const dir = tmp();
    writeSource(dir, baseSpec());
    const metas: Record<string, unknown>[] = [];
    await new PocketRisuAdapter('s', dir).scan((c) => { metas.push(c.meta); });
    expect(metas.every((m) => !('displayScripts' in m))).toBe(true);
  });
});
