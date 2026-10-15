import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loggerOptions } from '../src/api/logging.js';

const env = (o: Record<string, string>) => ({ PAGE_DATA_DIR: '/data', PAGE_SOURCES: 'main=/sources/main', ...o });

describe('loadConfig', () => {
  it('parses sources and applies defaults (D13/D17 provisional values)', () => {
    const c = loadConfig(env({ PAGE_SOURCES: 'main=/sources/main,alt=/sources/alt' }));
    expect(c.sources).toEqual([{ id: 'main', dir: '/sources/main' }, { id: 'alt', dir: '/sources/alt' }]);
    expect(c).toMatchObject({
      dataDir: '/data', bind: '127.0.0.1', port: 8787,
      syncIntervalMs: 15 * 60_000, debounceMs: 10 * 60_000,
      warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9,
      exportImageBudgetBytes: 300 * 1024 * 1024,
    });
  });
  it('overrides via env', () => {
    const c = loadConfig(env({ PAGE_BIND: '0.0.0.0', PAGE_PORT: '9000', PAGE_SYNC_INTERVAL_MIN: '5', PAGE_VERSION_DEBOUNCE_MIN: '1', PAGE_WARN_FREE_PCT: '30', PAGE_WARN_FREE_GB: '5', PAGE_STOP_ASSETS_FREE_GB: '1', PAGE_EXPORT_IMAGE_BUDGET_MB: '50' }));
    expect(c).toMatchObject({ bind: '0.0.0.0', port: 9000, syncIntervalMs: 300_000, debounceMs: 60_000, warnFreePct: 30, warnFreeBytes: 5e9, stopAssetsFreeBytes: 1e9, exportImageBudgetBytes: 50 * 1024 * 1024 });
  });
  it('PAGE_PDF_URL is optional (empty -> null) and must be an http(s) URL', () => {
    expect(loadConfig(env({})).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: '' })).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: '  ' })).pdfUrl).toBeNull();
    expect(loadConfig(env({ PAGE_PDF_URL: 'http://page-pdf:8790' })).pdfUrl).toBe('http://page-pdf:8790');
    expect(loadConfig(env({ PAGE_PDF_URL: 'https://pdf.example/' })).pdfUrl).toBe('https://pdf.example/');
    for (const bad of ['page-pdf:8790', 'file:///etc/passwd', 'ftp://x', 'javascript:alert(1)', 'not a url', '//page-pdf']) {
      expect(() => loadConfig(env({ PAGE_PDF_URL: bad }))).toThrow(/PAGE_PDF_URL/);
    }
  });
  it('PAGE_PDF_URL rejects userinfo, query and hash, and never echoes the bad value', () => {
    for (const bad of ['http://hunter2:secret@page-pdf:8790', 'http://user@page-pdf:8790', 'http://page-pdf:8790/?q=tok123', 'http://page-pdf:8790/#zzhash', 'http://page-pdf:8790?x', 'http://page-pdf:8790#']) {
      let msg = '';
      try { loadConfig(env({ PAGE_PDF_URL: bad })); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/PAGE_PDF_URL/);
      for (const leak of ['secret', 'hunter2', 'tok123', 'zzhash', 'page-pdf', '8790']) expect(msg).not.toContain(leak);
    }
    let msg = '';
    try { loadConfig(env({ PAGE_PDF_URL: 'file:///etc/passwd' })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/PAGE_PDF_URL/);
    expect(msg).not.toContain('passwd');
  });
  it('PAGE_WEB_DIR is optional and resolved to an absolute path', () => {
    expect(loadConfig(env({})).webDir).toBeUndefined();
    expect(loadConfig(env({ PAGE_WEB_DIR: 'web/dist' })).webDir).toMatch(/^\/.+web\/dist$/);
  });
  it.each([
    [{ PAGE_SOURCES: '' }, /PAGE_SOURCES/],
    [{ PAGE_SOURCES: 'main' }, /name=path/],
    [{ PAGE_SOURCES: 'a=/x,a=/y' }, /duplicate/],
    [{ PAGE_SOURCES: 'bad name=/x' }, /source name/],
    [{ PAGE_SOURCES: 'a=relative/path' }, /absolute/],
    [{ PAGE_DATA_DIR: '' }, /PAGE_DATA_DIR/],
    [{ PAGE_PORT: 'abc' }, /PAGE_PORT/],
    [{ PAGE_PRESERVE_ORPHANS: '1' }, /not implemented/],
  ])('rejects bad config %j', (o, msg) => {
    expect(() => loadConfig(env(o))).toThrow(msg);
  });
});

describe('logger options', () => {
  it('serializes requests without url, query or body', () => {
    const o = loggerOptions('info');
    const req = o.serializers.req({ method: 'GET', url: '/api/chat/x/messages?source=main&char=SECRET', routeOptions: { url: '/api/chat/:id/messages' } } as never);
    expect(req).toEqual({ method: 'GET', route: '/api/chat/:id/messages' });
    expect(JSON.stringify(req)).not.toMatch(/SECRET|source=/);
    expect(o.serializers.res({ statusCode: 200 } as never)).toEqual({ statusCode: 200 });
    expect(o.serializers.err({ type: 'Error', message: 'has SECRET content', stack: 'trace SECRET' } as never)).toEqual({ type: 'Error' });
  });
});
