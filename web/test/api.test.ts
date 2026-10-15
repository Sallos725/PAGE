import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

function stub(res: Response) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => res.clone()); // 호출마다 새 본문
  vi.stubGlobal('fetch', f);
  return f;
}

describe('api client', () => {
  it('builds list URLs with encoded query params', async () => {
    const f = stub(ok([]));
    await api.chars('main');
    await api.chats('main', 'c 1');
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/chars?source=main', '/api/chats?source=main&char=c+1']);
  });

  it('messages: encodes the chat id in the path and omits undefined params', async () => {
    const f = stub(ok({ total: 0, from: 0, version: 1, messages: [] }));
    await api.messages('main', 'c1', 'a/b', { from: 40, limit: 40 });
    expect(f.mock.calls[0]![0]).toBe('/api/chat/a%2Fb/messages?source=main&char=c1&from=40&limit=40');
    await api.messages('main', 'c1', 'a1', { from: 0, limit: 40, version: 7 });
    expect(f.mock.calls[1]![0]).toBe('/api/chat/a1/messages?source=main&char=c1&from=0&limit=40&version=7');
  });

  it('throws ApiError with the status on non-2xx', async () => {
    stub(ok({ error: 'x' }, 404));
    await expect(api.sources()).rejects.toMatchObject({ name: 'ApiError', status: 404 });
    expect(new ApiError(500).message).toBe('HTTP 500');
  });

  it('app: 가벼운 /api/app', async () => {
    const f = stub(ok({ app: 'page', portable: true }));
    expect(await api.app()).toEqual({ app: 'page', portable: true });
    expect(f.mock.calls[0]![0]).toBe('/api/app');
  });

  it('syncChat POSTs without a body', async () => {
    const f = stub(ok({ outcome: 'synced' }));
    await api.syncChat('main', 'c1', 'a1');
    expect(f).toHaveBeenCalledWith('/api/library/sync?source=main&char=c1&chat=a1', { method: 'POST' });
  });

  it('getPosition returns null when the server has none', async () => {
    stub(ok({ position: null, updatedAt: null }));
    expect(await api.getPosition('main', 'c1', 'a1')).toBeNull();
    const pos = { msgIdx: 1, blockIdx: 0, charOffset: 0, anchorHash: 'a' };
    stub(ok({ position: pos, updatedAt: 5 }));
    expect(await api.getPosition('main', 'c1', 'a1')).toEqual({ position: pos, updatedAt: 5 });
  });

  it('putPosition sends JSON and supports keepalive (page hide)', async () => {
    const f = stub(ok({ position: {}, updatedAt: 1 }));
    const pos = { msgIdx: 1, blockIdx: 2, charOffset: 3, anchorHash: 'h' };
    await api.putPosition('main', 'c1', 'a1', pos, { keepalive: true });
    expect(f).toHaveBeenCalledWith('/api/state/position?source=main&char=c1&chat=a1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pos), keepalive: true,
    });
  });

  it('settings: GET returns the map, PUT sends only the given keys', async () => {
    stub(ok({ settings: { 'reader.mode': 'book' } }));
    expect(await api.getSettings()).toEqual({ 'reader.mode': 'book' });
    const f = stub(ok({ settings: {} }));
    await api.putSettings({ 'reader.mode': 'scroll' });
    expect(f).toHaveBeenCalledWith('/api/state/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'reader.mode': 'scroll' }),
    });
  });

  it('bookmarks: list, add (POST JSON) and delete (204 or already gone)', async () => {
    const pos = { msgIdx: 1, blockIdx: 0, charOffset: 0, anchorHash: 'h' };
    stub(ok({ bookmarks: [] }));
    expect(await api.listBookmarks('main', 'c1', 'a1')).toEqual([]);
    const f = stub(ok({ bookmark: { id: 'x', kind: 'bookmark', start: pos, end: null, note: '', color: '', createdAt: 1 } }, 201));
    expect((await api.addBookmark('main', 'c1', 'a1', { kind: 'bookmark', start: pos })).id).toBe('x');
    expect(f).toHaveBeenCalledWith('/api/state/bookmarks?source=main&char=c1&chat=a1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bookmark', start: pos }),
    });
    const d = stub(new Response(null, { status: 204 }));
    await api.deleteBookmark('main', 'c1', 'a/1', 'x y');
    expect(d).toHaveBeenCalledWith('/api/state/bookmarks/x%20y?source=main&char=c1&chat=a%2F1', { method: 'DELETE' });
    stub(new Response(null, { status: 404 }));
    await expect(api.deleteBookmark('main', 'c1', 'a1', 'x')).resolves.toBeUndefined(); // 이미 지워졌으면 성공으로 본다
    stub(ok({ error: 'x' }, 500));
    await expect(api.deleteBookmark('main', 'c1', 'a1', 'x')).rejects.toMatchObject({ status: 500 });
  });

  it('assetUrl encodes every segment and never goes off-origin', () => {
    expect(api.assetUrl('main', 'c1', 'Alice.__am__.chat.x y')).toBe('/api/asset/main/c1/Alice.__am__.chat.x%20y');
    expect(api.assetUrl('main', 'c1', '../../etc')).toBe('/api/asset/main/c1/..%2F..%2Fetc');
  });
  it('alias: PUT JSON name; chat is optional', async () => {
    const f = stub(ok({ displayName: '새 이름', originalName: 'A' }));
    expect(await api.setAlias('main', 'c 1', undefined, '새 이름')).toEqual({ displayName: '새 이름', originalName: 'A' });
    expect(f).toHaveBeenCalledWith('/api/state/alias?source=main&char=c+1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '새 이름' }),
    });
    const g = stub(ok({ displayName: 'B', originalName: 'B' }));
    await api.setAlias('main', 'c1', 'x/y', '');
    expect(g.mock.calls[0]![0]).toBe('/api/state/alias?source=main&char=c1&chat=x%2Fy');
  });

  it('hide rules: list, add (char only for scope char), update, delete (404 = gone), candidates', async () => {
    stub(ok({ rules: [] }));
    expect(await api.hideRules('main', 'c1')).toEqual([]);
    const a = stub(ok({ rule: { id: 'r1' } }, 201));
    expect((await api.addHideRule('main', 'c1', { name: 'n', pattern: 'x', flags: 'g', scope: 'char' })).id).toBe('r1');
    expect(a).toHaveBeenCalledWith('/api/state/hide-rules?source=main', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n', pattern: 'x', flags: 'g', scope: 'char', char: 'c1', enabled: true, origin: 'manual' }),
    });
    const g = stub(ok({ rule: { id: 'r2' } }, 201));
    await api.addHideRule('main', 'c1', { name: 'n', pattern: 'x', flags: '', scope: 'global', origin: 'card' });
    expect(JSON.parse(g.mock.calls[0]![1]!.body as string)).toEqual({ name: 'n', pattern: 'x', flags: '', scope: 'global', enabled: true, origin: 'card' });
    const u = stub(ok({ rule: { id: 'r 1', enabled: false } }));
    await api.updateHideRule('main', 'r 1', { enabled: false });
    expect(u).toHaveBeenCalledWith('/api/state/hide-rules/r%201?source=main', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    const d = stub(new Response(null, { status: 404 }));
    await api.deleteHideRule('main', 'r1');
    expect(d).toHaveBeenCalledWith('/api/state/hide-rules/r1?source=main', { method: 'DELETE' });
    stub(new Response(null, { status: 500 }));
    await expect(api.deleteHideRule('main', 'r1')).rejects.toMatchObject({ status: 500 });
    stub(ok({ candidates: [{ name: 'n', pattern: 'x', flags: 'g' }] }));
    expect(await api.hideCandidates('main', 'c1')).toEqual([{ name: 'n', pattern: 'x', flags: 'g' }]);
  });
  it('shelves and recent', async () => {
    const f = stub(ok([]));
    expect(await api.shelves('my src')).toEqual([]);
    expect(f.mock.calls[0]![0]).toBe('/api/shelves?source=my+src');
    const g = stub(ok([]));
    await api.recent(5);
    expect(g.mock.calls[0]![0]).toBe('/api/recent?limit=5');
  });
  it('image rules: list and toggle', async () => {
    const f = stub(ok({ rules: [] }));
    expect(await api.imageRules('main', 'c 1')).toEqual([]);
    expect(f.mock.calls[0]![0]).toBe('/api/state/image-rules?source=main&char=c+1');
    const g = stub(ok({ key: '0123456789abcdef', enabled: false }));
    await api.setImageRule('main', 'c1', '0123456789abcdef', false);
    expect(g).toHaveBeenCalledWith('/api/state/image-rules/0123456789abcdef?source=main&char=c1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
  });
});

describe('3D API client', () => {
  it('lists with includeDeleted, sets keep, syncs now with force', async () => {
    const f = stub(ok([]));
    await api.chars('main', { includeDeleted: true });
    await api.chats('main', 'c1', { includeDeleted: true });
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/chars?source=main&includeDeleted=1', '/api/chats?source=main&char=c1&includeDeleted=1']);
    const g = stub(ok({ kept: true, keptAt: 5 }));
    expect(await api.setKept('main', 'c1', 'a 1', true)).toEqual({ kept: true, keptAt: 5 });
    expect(g.mock.calls[0]![0]).toBe('/api/state/kept?source=main&char=c1&chat=a+1');
    expect(g.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: '{"kept":true}' });
    const s = stub(ok({ outcome: 'synced', finishedAt: 1, chats: { created: 0, appended: 0, edited: 0, tombstoned: 0 } }));
    await api.syncNow('main');
    expect(s.mock.calls[0]![0]).toBe('/api/library/sync?source=main&force=1');
    expect(s.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });
});

describe('export API client', () => {
  it('starts an export with a JSON body on the chat query, polls status, builds the download URL', async () => {
    const f = stub(ok({ jobId: 'a'.repeat(32) }, 202));
    expect(await api.startExport('main', 'c1', 'x y', { format: 'json' })).toEqual({ jobId: 'a'.repeat(32) });
    expect(f.mock.calls[0]![0]).toBe('/api/export?source=main&char=c1&chat=x+y');
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{"format":"json"}' });
    const g = stub(ok({ jobId: 'j', state: 'done', format: 'json' }));
    expect((await api.exportStatus('j')).state).toBe('done');
    expect(g.mock.calls[0]![0]).toBe('/api/export/j');
    expect(api.exportDownloadUrl('j')).toBe('/api/export/j/download');
  });

  it('lists the export formats the server can make', async () => {
    const f = stub(ok({ formats: ['json', 'epub', 'pdf'] }));
    expect(await api.exportFormats()).toEqual({ formats: ['json', 'epub', 'pdf'] });
    expect(f.mock.calls[0]![0]).toBe('/api/export/formats');
  });

  it('ApiError carries the server error code when the body has one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'family-taken' }), { status: 409 })));
    await expect(api.fonts()).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'family-taken' });
  });

  it('addFont posts the raw file with the family in the query', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ font: { id: 'x' } }), { status: 201 }));
    vi.stubGlobal('fetch', f);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    await api.addFont('나눔 명조', blob);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/fonts?family=${encodeURIComponent('나눔 명조').replace(/%20/g, '+')}`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob });
  });
});

describe('import API client', () => {
  it('sends the file text as-is as JSON and returns the results', async () => {
    const f = stub(ok({ results: [{ chatId: 'a', title: 't', messages: 1, status: 'new' }] }));
    const text = '{"type":"risuChat",  "ver":2,"data":{"id":"a"}}';
    const r = await api.importChats('c 1'.padEnd(32, 'x'), text);
    expect(r).toEqual({ results: [{ chatId: 'a', title: 't', messages: 1, status: 'new' }] });
    const init = f.mock.calls[0]![1]!;
    expect(f.mock.calls[0]![0]).toBe(`/api/import/chars/${encodeURIComponent('c 1'.padEnd(32, 'x'))}/chats`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(text);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('surfaces error codes and treats a missing chat on delete as done', async () => {
    stub(ok({ error: 'unsupported-format' }, 400));
    await expect(api.importChats('x', '{}')).rejects.toMatchObject({ status: 400, code: 'unsupported-format' });
    stub(new Response(null, { status: 404 }));
    await expect(api.deleteImportChat('x', 'y')).resolves.toBeUndefined();
    stub(new Response(null, { status: 204 }));
    await expect(api.deleteImportChar('x')).resolves.toBeUndefined();
  });
});
