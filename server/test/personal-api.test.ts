import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore } from '../src/state/store.js';
import { baseSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const spec = baseSpec();
  spec.characters[0]!.customscript = [
    { comment: '상태창', in: '<st>[\\s\\S]*?</st>', out: 'OUT', type: 'editdisplay', ableFlag: true, flag: 'g' },
    { comment: '두번째', in: '\\[INFO[^\\]]*\\]', out: 'OUT', type: 'editdisplay' },
    { comment: '깨짐', in: '(', out: 'OUT', type: 'editdisplay' },
  ];
  const h = makeHarness({ spec });
  await h.sync();
  const state = new StateStore(h.dataDir);
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state });
  opened.push(app);
  return { h, app, state };
}
type App = Awaited<ReturnType<typeof setup>>['app'];
const j = (r: { body: string }) => JSON.parse(r.body);
const put = (app: App, url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const post = (app: App, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

describe('alias API', () => {
  it('renames a character and a chat; lists show displayName and originalName', async () => {
    const { app } = await setup();
    const r1 = await put(app, '/api/state/alias?source=main&char=c1', { name: '  앨리스  ' });
    expect(r1.statusCode).toBe(200);
    expect(j(r1)).toEqual({ displayName: '앨리스', originalName: 'Alice' });
    expect((await put(app, '/api/state/alias?source=main&char=c1&chat=a1', { name: '첫 권' })).statusCode).toBe(200);
    const chars = j(await app.inject('/api/chars?source=main')) as { charId: string; name: string; displayName: string; originalName: string }[];
    expect(chars.find((c) => c.charId === 'c1')).toMatchObject({ name: 'Alice', displayName: '앨리스', originalName: 'Alice' });
    expect(chars.find((c) => c.charId === 'c2')).toMatchObject({ displayName: 'Bob', originalName: 'Bob' });
    const chats = j(await app.inject('/api/chats?source=main&char=c1')) as { chatId: string; displayName: string; originalName: string }[];
    expect(chats.find((c) => c.chatId === 'a1')).toMatchObject({ displayName: '첫 권', originalName: 'chat-a1' });
    expect(chats.find((c) => c.chatId === 'a2')).toMatchObject({ displayName: 'chat-a2', originalName: 'chat-a2' });
  });

  it('an empty name removes the alias', async () => {
    const { app } = await setup();
    await put(app, '/api/state/alias?source=main&char=c1', { name: '앨리스' });
    expect(j(await put(app, '/api/state/alias?source=main&char=c1', { name: '   ' }))).toEqual({ displayName: 'Alice', originalName: 'Alice' });
    expect((j(await app.inject('/api/chars?source=main')) as { displayName: string }[])[0]!.displayName).toBe('Alice');
  });

  it('validates the name and the target', async () => {
    const { app } = await setup();
    expect((await put(app, '/api/state/alias?source=main&char=c1', { name: 'x'.repeat(81) })).statusCode).toBe(400);
    expect((await put(app, '/api/state/alias?source=main&char=c1', { name: 'a\u0001' })).statusCode).toBe(400);
    expect((await put(app, '/api/state/alias?source=main&char=nope', { name: 'x' })).statusCode).toBe(404);
    expect((await put(app, '/api/state/alias?source=main&char=c1&chat=nope', { name: 'x' })).statusCode).toBe(404);
    expect((await put(app, '/api/state/alias?source=zzz&char=c1', { name: 'x' })).statusCode).toBe(404);
  });
});

describe('hide rule API', () => {
  const RULE = { name: '상태창', pattern: '<st>[\\s\\S]*?</st>', flags: 'g', scope: 'char', char: 'c1' };

  it('creates, lists (global + this character), updates and deletes', async () => {
    const { app } = await setup();
    const c = await post(app, '/api/state/hide-rules?source=main', RULE);
    expect(c.statusCode).toBe(201);
    const rule = j(c).rule as { id: string };
    expect(j(c).rule).toMatchObject({ scope: 'char', charId: 'c1', enabled: true, origin: 'manual', flags: 'g' });
    await post(app, '/api/state/hide-rules?source=main', { name: 'OOC', pattern: '\\(OOC:[^)]*\\)', flags: '', scope: 'global' });
    await post(app, '/api/state/hide-rules?source=main', { ...RULE, char: 'c2', name: '남의 것' });
    const list = j(await app.inject('/api/state/hide-rules?source=main&char=c1')).rules as { name: string }[];
    expect(list.map((r) => r.name)).toEqual(['상태창', 'OOC']);
    const u = await put(app, `/api/state/hide-rules/${rule.id}?source=main`, { enabled: false, flags: 'ig' });
    expect(j(u).rule).toMatchObject({ enabled: false, flags: 'gi' });
    expect((await app.inject({ method: 'DELETE', url: `/api/state/hide-rules/${rule.id}?source=main` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/state/hide-rules/${rule.id}?source=main` })).statusCode).toBe(404);
  });

  it('rejects invalid rules with an error code only (never the pattern)', async () => {
    const { app } = await setup();
    const bad = await post(app, '/api/state/hide-rules?source=main', { ...RULE, pattern: '(' });
    expect(bad.statusCode).toBe(400);
    expect(j(bad)).toEqual({ error: 'invalid rule', reason: 'compile' });
    expect(j(await post(app, '/api/state/hide-rules?source=main', { ...RULE, pattern: 'a*' })).reason).toBe('empty-match');
    expect((await post(app, '/api/state/hide-rules?source=main', { ...RULE, char: undefined })).statusCode).toBe(400);
    expect((await post(app, '/api/state/hide-rules?source=main', { ...RULE, char: 'nope' })).statusCode).toBe(404);
    const ok = j(await post(app, '/api/state/hide-rules?source=main', RULE)).rule as { id: string };
    expect(j(await put(app, `/api/state/hide-rules/${ok.id}?source=main`, { pattern: '(' })).reason).toBe('compile');
    expect((await put(app, '/api/state/hide-rules/nope?source=main', { enabled: true })).statusCode).toBe(404);
  });

  it('caps the number of rules per source', async () => {
    const { app, state } = await setup();
    for (let i = 0; i < 200; i++) state.addHideRule('main', { scope: 'global', charId: '', name: `r${i}`, pattern: `x${i}`, flags: '', enabled: true, origin: 'manual' }, i);
    expect((await post(app, '/api/state/hide-rules?source=main', RULE)).statusCode).toBe(400);
  });
});

describe('hide candidates API', () => {
  it('offers valid card display scripts not yet registered', async () => {
    const { app } = await setup();
    const first = j(await app.inject('/api/state/hide-candidates?source=main&char=c1')).candidates;
    expect(first).toEqual([
      { name: '상태창', pattern: '<st>[\\s\\S]*?</st>', flags: 'g' },
      { name: '두번째', pattern: '\\[INFO[^\\]]*\\]', flags: 'g' },
    ]);
    await post(app, '/api/state/hide-rules?source=main', { name: '내 이름', pattern: '<st>[\\s\\S]*?</st>', flags: 'g', scope: 'char', char: 'c1', origin: 'card' });
    expect(j(await app.inject('/api/state/hide-candidates?source=main&char=c1')).candidates).toEqual([
      { name: '두번째', pattern: '\\[INFO[^\\]]*\\]', flags: 'g' },
    ]);
    expect(j(await app.inject('/api/state/hide-candidates?source=main&char=c2')).candidates).toEqual([]);
    expect((await app.inject('/api/state/hide-candidates?source=main&char=nope')).statusCode).toBe(404);
  });
});
