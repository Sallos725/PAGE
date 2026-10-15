// 커스텀 테마·글꼴 서재 API (스펙 §4). 오류는 짧은 코드만, 로그에 CSS·이름을 남기지 않는다.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { FONT_LIMITS, THEME_BASES, THEME_LIMITS, composeThemeFile, themeFileName, type ThemeFile } from '../shared/theme-file.js';
import { FONT_MIME, fontsCss, type AppearanceStore, type Theme, type ThemeMeta } from '../state/appearance.js';

export type AppearanceDeps = { appearance: AppearanceStore; now: () => number };

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{32}$' } } } as const;
const themeProps = {
  name: { type: 'string', minLength: 1, maxLength: THEME_LIMITS.nameMax },
  base: { type: 'string', enum: [...THEME_BASES] },
  css: { type: 'string', maxLength: THEME_LIMITS.cssBytes },
} as const;
// Fastify 기본 Ajv 는 removeAdditional 이라 additionalProperties:false 만으로는 모르는 키를 조용히 지운다.
// propertyNames 로 모르는 키는 지우지 않고 400 으로 거절한다.
const themeKeys = { enum: ['name', 'base', 'css'] } as const;
export const ERROR_STATUS: Record<string, number> = {
  'bad-name': 400, 'too-large': 413, 'too-many': 409, 'bad-family': 400, 'bad-font': 400, 'family-taken': 409, 'library-full': 409,
};
const meta = (t: Theme): ThemeMeta => ({ id: t.id, name: t.name, base: t.base, updatedAt: t.updatedAt });
const CSS_TYPE = 'text/css; charset=utf-8';
// encodeURIComponent 가 남기는 '()* 도 RFC 8187 attr-char 가 아니므로 % 인코딩한다.
const rfc8187 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const IMMUTABLE = 'public, max-age=31536000, immutable';
// JSON 이스케이프로 CSS 256KB 가 커질 수 있어 테마 쓰기 경로만 본문 상한을 넉넉히 둔다.
const THEME_BODY_LIMIT = 2 * 1024 * 1024;

export async function registerAppearanceRoutes(app: FastifyInstance, deps: AppearanceDeps) {
  const a = deps.appearance;

  app.get('/api/themes', async () => ({ themes: a.listThemes() }));

  app.get<{ Params: { id: string } }>('/api/themes/:id', { schema: { params: idParams } }, async (req, reply) => {
    const t = a.getTheme(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not-found' });
    return { ...meta(t), css: t.css };
  });

  app.post<{ Body: ThemeFile }>(
    '/api/themes',
    { bodyLimit: THEME_BODY_LIMIT, schema: { body: { type: 'object', required: ['name', 'base', 'css'], additionalProperties: false, propertyNames: themeKeys, properties: themeProps } } },
    async (req, reply) => {
      const r = a.createTheme(req.body, deps.now());
      if (typeof r === 'string') return reply.code(ERROR_STATUS[r]!).send({ error: r });
      return reply.code(201).send({ theme: meta(r) });
    });

  app.put<{ Params: { id: string }; Body: Partial<ThemeFile> }>(
    '/api/themes/:id',
    { bodyLimit: THEME_BODY_LIMIT, schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, propertyNames: themeKeys, properties: themeProps } } },
    async (req, reply) => {
      const r = a.updateTheme(req.params.id, req.body, deps.now());
      if (r === null) return reply.code(404).send({ error: 'not-found' });
      if (typeof r === 'string') return reply.code(ERROR_STATUS[r]!).send({ error: r });
      return { theme: meta(r) };
    });

  app.delete<{ Params: { id: string } }>('/api/themes/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (!a.deleteTheme(req.params.id)) return reply.code(404).send({ error: 'not-found' });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>(
    '/api/themes/:id/theme.css',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { v: { type: 'string', pattern: '^[0-9]{1,15}$' } } } } },
    async (req, reply) => {
      const t = a.getTheme(req.params.id);
      if (!t) return reply.code(404).send({ error: 'not-found' });
      return reply.type(CSS_TYPE).header('x-content-type-options', 'nosniff')
        .header('cache-control', req.query.v === String(t.updatedAt) ? IMMUTABLE : 'no-cache').send(t.css);
    });

  app.get<{ Params: { id: string } }>('/api/themes/:id/download', { schema: { params: idParams } }, async (req, reply) => {
    const t = a.getTheme(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not-found' });
    return reply.type(CSS_TYPE).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="theme.css"; filename*=UTF-8''${rfc8187(themeFileName(t.name))}`)
      .send(composeThemeFile({ name: t.name, base: t.base, css: t.css }));
  });

  app.get('/api/fonts', async () => ({ fonts: a.listFonts() }));

  app.get<{ Headers: { 'if-none-match'?: string } }>('/api/fonts.css', async (req, reply) => {
    const css = fontsCss(a.listFonts());
    const etag = `"${createHash('sha1').update(css).digest('hex').slice(0, 16)}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache').header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(CSS_TYPE).send(css);
  });

  app.get<{ Params: { id: string } }>('/api/fonts/:id', { schema: { params: idParams } }, async (req, reply) => {
    const f = a.getFont(req.params.id);
    if (!f) return reply.code(404).send({ error: 'not-found' });
    // 파일을 먼저 열어 둔다: DB 행만 남고 파일이 없으면 immutable 헤더가 붙은 500 이 아니라 404 가 나간다.
    // fh.createReadStream 은 autoClose 라 스트림이 끝나거나 오류·중단될 때 fh 도 닫힌다.
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(a.fontFile(f), 'r');
    } catch {
      return reply.code(404).send({ error: 'not-found' });
    }
    const { size } = await fh.stat();
    return reply.header('content-length', size).type(FONT_MIME[f.format])
      .header('cache-control', IMMUTABLE).header('x-content-type-options', 'nosniff')
      .send(fh.createReadStream());
  });

  // 업로드만 원시 바이트를 받는다: 파서와 10MB 상한을 이 범위 안에만 둔다.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FONT_LIMITS.fileBytes }, (_req, body, done) => done(null, body));
    scope.post<{ Querystring: { family: string }; Body: unknown }>(
      '/api/fonts',
      {
        bodyLimit: FONT_LIMITS.fileBytes,
        schema: { querystring: { type: 'object', required: ['family'], additionalProperties: false, properties: { family: { type: 'string', minLength: 1, maxLength: FONT_LIMITS.familyMax } } } },
      },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'bad-font' });
        const r = a.addFont(req.query.family, req.body, deps.now());
        if (typeof r === 'string') return reply.code(ERROR_STATUS[r]!).send({ error: r });
        return reply.code(201).send({ font: r });
      });
  });

  app.patch<{ Params: { id: string }; Body: { family: string } }>(
    '/api/fonts/:id',
    { schema: { params: idParams, body: { type: 'object', required: ['family'], additionalProperties: false, propertyNames: { enum: ['family'] }, properties: { family: { type: 'string', minLength: 1, maxLength: FONT_LIMITS.familyMax } } } } },
    async (req, reply) => {
      const r = a.renameFont(req.params.id, req.body.family);
      if (r === null) return reply.code(404).send({ error: 'not-found' });
      if (typeof r === 'string') return reply.code(ERROR_STATUS[r]!).send({ error: r });
      return { font: r };
    });

  app.delete<{ Params: { id: string } }>('/api/fonts/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (!a.deleteFont(req.params.id)) return reply.code(404).send({ error: 'not-found' });
    return reply.code(204).send();
  });
}
