import fs from 'node:fs';
import path from 'node:path';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ExportManager } from '../export/jobs.js';
import type { ImportStore } from '../import/store.js';
import type { LibraryStore } from '../library/store.js';
import { IMPORTED_SOURCE } from '../source/import/adapter.js';
import { normalizeMessage } from '../source/normalize.js';
import type { SourceAdapter } from '../source/types.js';
import { CHAPTER_WINDOW } from '../library/chapters.js';
import { RULE_LIMITS, checkRule } from '../state/hide-rules.js';
import type { AppearanceStore } from '../state/appearance.js';
import { keptKey, type StateStore } from '../state/store.js';
import type { SyncPolicy, SyncReport, Syncer } from '../sync/syncer.js';
import { registerAppearanceRoutes } from './appearance-routes.js';
import { registerExportRoutes } from './export-routes.js';
import { hostAllowed } from './host-check.js';
import { registerImportRoutes } from './import-routes.js';
import { registerPortableRoutes, type PortableApiDeps } from './portable-routes.js';

export type AppDeps = {
  adapters: SourceAdapter[];
  store: LibraryStore;
  syncer: Syncer;
  policy: SyncPolicy;
  now: () => number;
  state: StateStore;
  /** 커스텀 테마·글꼴 서재. 없으면 /api/themes·/api/fonts 라우트를 만들지 않는다. */
  appearance?: AppearanceStore;
  /** 내보내기 작업 관리자. 없으면 /api/export 라우트를 만들지 않는다. */
  exportManager?: ExportManager;
  /** 가져온 채팅 저장소. 있으면 `imported` 어댑터와 함께 /api/import 라우트를 만든다. 없으면 만들지 않는다(404). */
  imports?: ImportStore;
  /** EPUB 내보내기 그림 용량 한도(바이트). 없으면 produceEpub 기본값(300MB). */
  exportImageBudgetBytes?: number;
  /** PDF 사이드카 주소. 없으면 format:'pdf' 는 400 pdf-unavailable. */
  pdfUrl?: string | null;
  /** 테스트에서만 쓴다: PDF 사이드카 호출 상한(ms). */
  pdfTimeoutMs?: number;
  /** 빌드된 SPA 디렉터리. 주어지면 정적 서빙 + CSP 를 켠다. */
  webDir?: string;
  /** pino 옵션 객체(loggerOptions) 또는 false. Fastify 의 로거 타입은 stream 필드를 모르므로 경계에서 한 번만 캐스팅한다. */
  logger?: object | boolean;
  /** Host 허용 목록. null·없음이면 검사하지 않는다 (스펙 §5.1). */
  allowedHosts?: string[] | null;
  /** 포터블 모드 — health 에 싣고 포터블 라우트를 켠다. */
  portable?: boolean;
  /** 원본 연결 API 의존성. portable 이 켜져 있을 때만 /api/portable 라우트를 만든다. */
  portableApi?: PortableApiDeps;
};

const MAX_LIMIT = 500;
const str = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength } as const);
const flag = { type: 'string', enum: ['0', '1'] } as const;
const intStr = { type: 'string', pattern: '^[0-9]{1,9}$' } as const;

export async function buildApp(deps: AppDeps) {
  const { store, syncer, policy } = deps;
  const adapters = new Map(deps.adapters.map((a) => [a.id, a]));
  const app = Fastify({ logger: (deps.logger ?? false) as FastifyServerOptions['logger'] });

  const allowedHosts = deps.allowedHosts ?? null;
  if (allowedHosts) {
    // 라우트·플러그인보다 먼저 붙인다 (정적 서빙 포함 모든 요청 대상)
    app.addHook('onRequest', async (req, reply) => {
      if (hostAllowed(req.headers.host, allowedHosts)) return;
      app.log.warn('request rejected: host not allowed'); // 헤더 값은 남기지 않는다
      return reply.code(421).send({ error: 'bad-host' });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'bad request' });
    app.log.error({ err: { type: (err as Error).name } }, 'request failed'); // 메시지/스택은 남기지 않는다
    return reply.code(500).send({ error: 'internal error' });
  });

  const adapterOr404 = (id: string) => adapters.get(id) ?? null;
  const enc = encodeURIComponent;
  const charImageUrl = (source: string, charId: string) =>
    (store.getCharImage(source, charId)?.hash ? `/api/char-image/${enc(source)}/${enc(charId)}` : null);
  const progressOf = (msgIdx: number | undefined, msgCount: number | null) =>
    (msgIdx === undefined || !msgCount ? null : Math.min(1, (msgIdx + 1) / msgCount));

  if (deps.exportManager) registerExportRoutes(app, { store, state: deps.state, adapters, exportManager: deps.exportManager, imageBudgetBytes: deps.exportImageBudgetBytes, pdfUrl: deps.pdfUrl ?? null, pdfTimeoutMs: deps.pdfTimeoutMs, now: deps.now });
  const importedAdapter = adapters.get(IMPORTED_SOURCE);
  if (deps.imports && importedAdapter) await registerImportRoutes(app, { imports: deps.imports, adapter: importedAdapter, syncer, store, state: deps.state, now: deps.now, exportManager: deps.exportManager });
  if (deps.appearance) await registerAppearanceRoutes(app, { appearance: deps.appearance, now: deps.now });
  if (deps.portable && deps.portableApi) await registerPortableRoutes(app, { ...deps.portableApi, adapters });

  // 화면용 가벼운 정보 — 어댑터 health(원본 파일 확인)를 거치지 않는다. 런처 probe·다시 켜기 대기는 /api/health 를 쓴다
  app.get('/api/app', async () => ({ app: 'page', portable: deps.portable === true }));
  app.get('/api/health', async () => ({ app: 'page', portable: deps.portable === true, sources: await Promise.all(deps.adapters.map((a) => a.health())) }));

  app.get('/api/sources', async () =>
    Promise.all(deps.adapters.map(async (a) => {
      const h = await a.health();
      const last = store.getState(a.id, 'last_report');
      return { id: a.id, kind: a.kind, status: h.status, reasons: h.reasons, lastSyncAt: last ? (JSON.parse(last) as SyncReport).finishedAt : null };
    })));

  app.get<{ Querystring: { source: string; includeDeleted?: string } }>(
    '/api/chars',
    { schema: { querystring: { type: 'object', required: ['source'], additionalProperties: false, properties: { source: str(64), includeDeleted: flag } } } },
    async (req, reply) => {
      if (!adapterOr404(req.query.source)) return reply.code(404).send({ error: 'unknown source' });
      const alias = deps.state.aliasMap(req.query.source, 'char');
      return store.listChars(req.query.source, req.query.includeDeleted === '1')
        .map((c) => ({ ...c, originalName: c.name, displayName: alias.get(c.charId) ?? c.name, imageUrl: charImageUrl(req.query.source, c.charId) }));
    });

  app.get<{ Querystring: { source: string; char: string; includeDeleted?: string } }>(
    '/api/chats',
    { schema: { querystring: { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str(), includeDeleted: flag } } } },
    async (req, reply) => {
      if (!adapterOr404(req.query.source)) return reply.code(404).send({ error: 'unknown source' });
      const alias = deps.state.aliasMap(req.query.source, 'chat', req.query.char);
      const read = deps.state.positionsForChar(req.query.source, req.query.char);
      const kept = deps.state.keptMap(req.query.source, req.query.char);
      return store.listChats(req.query.source, req.query.char, req.query.includeDeleted === '1')
        .map((c) => {
          const p = read.get(c.chatId);
          return { ...c, originalName: c.title, displayName: alias.get(c.chatId) ?? c.title, progress: progressOf(p?.position.msgIdx, c.msgCount), readAt: p?.updatedAt ?? null, keptAt: kept.get(keptKey(req.query.char, c.chatId)) ?? null };
        });
    });

  app.get<{ Params: { id: string }; Querystring: { source: string; char: string } }>(
    '/api/chat/:id/versions',
    { schema: { querystring: { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str() } } } },
    async (req, reply) => {
      const { source, char } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      if (!store.getChat(source, char, req.params.id)) return reply.code(404).send({ error: 'unknown chat' });
      return store.listVersions(source, char, req.params.id).map((v) => ({ versionId: v.versionId, createdAt: v.createdAt, reason: v.reason, msgCount: v.msgCount }));
    });

  app.get<{ Params: { id: string }; Querystring: { source: string; char: string; from?: string; limit?: string; version?: string } }>(
    '/api/chat/:id/messages',
    {
      schema: {
        querystring: {
          type: 'object', required: ['source', 'char'], additionalProperties: false,
          properties: { source: str(64), char: str(), from: intStr, limit: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' }, version: intStr },
        },
      },
    },
    async (req, reply) => {
      const { source, char } = req.query;
      const adapter = adapterOr404(source);
      if (!adapter) return reply.code(404).send({ error: 'unknown source' });
      const row = store.getChat(source, char, req.params.id);
      if (!row) return reply.code(404).send({ error: 'unknown chat' });
      const versionId = req.query.version !== undefined ? Number(req.query.version) : row.headVersion;
      const version = versionId == null ? null : store.getVersion(versionId);
      if (!version || version.source !== source || version.charId !== char || version.chatId !== req.params.id) {
        return reply.code(404).send({ error: 'unknown version' });
      }
      const hashes = store.getManifest(version.manifestHash);
      if (!hashes) return reply.code(500).send({ error: 'internal error' });
      const from = Math.min(Number(req.query.from ?? 0), hashes.length);
      const limit = Math.min(Number(req.query.limit ?? 100), MAX_LIMIT);
      const slice = hashes.slice(from, from + limit);
      const messages = store.getMsgJson(slice).map((json, i) => normalizeMessage(adapter.kind, JSON.parse(json), from + i));
      return { total: hashes.length, from, version: version.versionId, messages };
    });

  app.get<{ Params: { source: string; '*': string }; Headers: { 'if-none-match'?: string } }>('/api/asset/:source/*', async (req, reply) => {
    const { source } = req.params;
    const rest = req.params['*'];
    const slash = rest.indexOf('/');
    if (!adapterOr404(source) || slash < 1) return reply.code(404).send({ error: 'not found' });
    const hash = store.findAssetHash(source, rest.slice(0, slash), rest.slice(slash + 1));
    const info = hash ? store.assetInfo(hash) : null;
    if (!hash || !info) return reply.code(404).send({ error: 'not found' });
    const etag = `"${hash}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=3600');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(info.mime).send(fs.createReadStream(store.blobPath(hash)));
  });

  // ── 캐릭터 대표 이미지 (D27)
  app.get<{ Params: { source: string; char: string }; Headers: { 'if-none-match'?: string } }>('/api/char-image/:source/:char', async (req, reply) => {
    const { source, char } = req.params;
    if (!adapterOr404(source)) return reply.code(404).send({ error: 'not found' });
    const hash = store.getCharImage(source, char)?.hash ?? null;
    const info = hash ? store.assetInfo(hash) : null;
    if (!hash || !info) return reply.code(404).send({ error: 'not found' });
    const etag = `"${hash}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=3600');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(info.mime).send(fs.createReadStream(store.blobPath(hash)));
  });

  // ── 서고: 캐릭터 + 채팅 요약을 한 번에 (홈이 캐릭터마다 /api/chats 를 부르지 않게)
  app.get<{ Querystring: { source: string } }>(
    '/api/shelves',
    { schema: { querystring: { type: 'object', required: ['source'], additionalProperties: false, properties: { source: str(64) } } } },
    async (req, reply) => {
      const { source } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      const charAlias = deps.state.aliasMap(source, 'char');
      return store.listChars(source, true).map((c) => {
        const chatAlias = deps.state.aliasMap(source, 'chat', c.charId);
        const read = deps.state.positionsForChar(source, c.charId);
        const kept = deps.state.keptMap(source, c.charId);
        const chats = store.listChats(source, c.charId, true).map((h) => {
          const p = read.get(h.chatId);
          return {
            chatId: h.chatId, displayName: chatAlias.get(h.chatId) ?? h.title, msgCount: h.msgCount, lastError: h.lastError,
            lastDate: h.lastDate, progress: progressOf(p?.position.msgIdx, h.msgCount), readAt: p?.updatedAt ?? null,
            deleted: h.deleted, keptAt: kept.get(keptKey(c.charId, h.chatId)) ?? null,
          };
        });
        return {
          charId: c.charId, displayName: charAlias.get(c.charId) ?? c.name, originalName: c.name, deleted: c.deleted,
          chatCount: c.deleted ? chats.length : chats.filter((h) => !h.deleted).length, // 홈 선반에 보일 수 (3D §2)
          imageUrl: charImageUrl(source, c.charId),
          chats,
        };
      });
    });

  // ── 최근 읽기 (책상). 위치 갱신 시각 순. 원본에서 지워진 채팅은 표시와 함께 남기고, 비었거나 모르는 소스는 건너뛴다.
  app.get<{ Querystring: { limit?: string } }>(
    '/api/recent',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|10)$' } } } } },
    async (req) => {
      const limit = Number(req.query.limit ?? 3);
      const out: unknown[] = [];
      for (const r of deps.state.recentPositions(50)) {
        if (out.length >= limit) break;
        if (!adapters.has(r.source)) continue;
        const row = store.getChat(r.source, r.charId, r.chatId);
        if (!row || row.headVersion === null) continue;
        const msgCount = store.getVersion(row.headVersion)?.msgCount ?? 0;
        if (!msgCount) continue;
        out.push({
          source: r.source, charId: r.charId, chatId: r.chatId,
          title: deps.state.aliasMap(r.source, 'chat', r.charId).get(r.chatId) ?? row.title,
          charName: deps.state.aliasMap(r.source, 'char').get(r.charId) ?? store.getCharName(r.source, r.charId) ?? '',
          chapter: Math.floor(r.position.msgIdx / CHAPTER_WINDOW) + 1,
          progress: Math.min(1, (r.position.msgIdx + 1) / msgCount),
          updatedAt: r.updatedAt,
          imageUrl: charImageUrl(r.source, r.charId),
          deleted: row.deletedAt !== null,
        });
      }
      return out;
    });

  app.get('/api/library/status', async () => {
    const free = policy.freeSpace();
    const freePct = free.totalBytes > 0 ? (free.freeBytes / free.totalBytes) * 100 : 100;
    const warnings: string[] = [];
    if (freePct < policy.warnFreePct || free.freeBytes < policy.warnFreeBytes) warnings.push('low-free-space');
    if (free.freeBytes < policy.stopAssetsFreeBytes) warnings.push('new-assets-paused');
    const assets = store.assetTotals();
    const sources = await Promise.all(deps.adapters.map(async (a) => {
      const h = await a.health();
      const lastRaw = store.getState(a.id, 'last_report');
      const lastReport = lastRaw ? (JSON.parse(lastRaw) as SyncReport) : null;
      const w: string[] = [];
      if (h.status !== 'ok') w.push(`source-${h.status}`);
      if (lastReport?.held) w.push('mass-deletion-held');
      if (lastReport?.outcome === 'skipped') w.push('last-sync-skipped');
      return { id: a.id, status: h.status, ...store.stats(a.id), lastReport, warnings: w };
    }));
    return {
      library: { assetCount: assets.count, assetBytes: assets.bytes, dbBytes: store.dbBytes() },
      freeSpace: { ...free, freePct },
      warnings,
      sources,
    };
  });

  app.post<{ Querystring: { source: string; char?: string; chat?: string; force?: string; acceptMassDeletion?: string } }>(
    '/api/library/sync',
    { schema: { querystring: { type: 'object', required: ['source'], additionalProperties: false, properties: { source: str(64), char: str(), chat: str(), force: flag, acceptMassDeletion: flag } } } },
    async (req, reply) => {
      const adapter = adapterOr404(req.query.source);
      if (!adapter) return reply.code(404).send({ error: 'unknown source' });
      const { char, chat } = req.query;
      if ((char === undefined) !== (chat === undefined)) return reply.code(400).send({ error: 'char and chat must be given together' });
      if (char !== undefined && chat !== undefined) {
        return syncer.syncSource(adapter, { only: { charId: char, chatId: chat }, force: true });
      }
      return syncer.syncSource(adapter, { force: req.query.force === '1', acceptMassDeletion: req.query.acceptMassDeletion === '1' });
    });

  // ── 사용자 상태 (스펙 5.3). 위치는 채팅당 1개, 기기 간 공유(last-write-wins).
  const chatQs = { type: 'object', required: ['source', 'char', 'chat'], additionalProperties: false, properties: { source: str(64), char: str(), chat: str() } } as const;
  const posBody = {
    type: 'object', required: ['msgIdx', 'blockIdx', 'charOffset', 'anchorHash'], additionalProperties: false,
    properties: {
      msgIdx: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
      blockIdx: { type: 'integer', minimum: 0, maximum: 1_000_000 },
      charOffset: { type: 'integer', minimum: 0, maximum: 10_000_000 },
      anchorHash: { type: 'string', maxLength: 64 },
    },
  } as const;
  type ChatQs = { source: string; char: string; chat: string };

  app.get<{ Querystring: ChatQs }>('/api/state/position', { schema: { querystring: chatQs } }, async (req, reply) => {
    const { source, char, chat } = req.query;
    if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
    return deps.state.getPosition(source, char, chat) ?? { position: null, updatedAt: null };
  });

  app.put<{ Querystring: ChatQs; Body: { msgIdx: number; blockIdx: number; charOffset: number; anchorHash: string } }>(
    '/api/state/position', { schema: { querystring: chatQs, body: posBody } },
    async (req, reply) => {
      const { source, char, chat } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      if (!store.getChat(source, char, chat)) return reply.code(404).send({ error: 'unknown chat' });
      const updatedAt = deps.now();
      deps.state.putPosition(source, char, chat, req.body, updatedAt);
      return { position: req.body, updatedAt };
    });

  // ── 책갈피 · 하이라이트 (스펙 5.2/5.3). 하이라이트는 시작 < 끝, 책갈피는 끝이 없다.
  const bookmarkBody = {
    type: 'object', required: ['kind', 'start'], additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['bookmark', 'highlight'] },
      start: posBody,
      end: { anyOf: [posBody, { type: 'null' }] },
      note: { type: 'string', maxLength: 2000 },
      color: { type: 'string', enum: ['yellow', 'green', 'blue', 'pink'] },
      text: { type: 'string', maxLength: 2000 },
    },
  } as const;
  const MAX_BOOKMARKS_PER_CHAT = 5000;
  type Pos = { msgIdx: number; blockIdx: number; charOffset: number; anchorHash: string };
  const cmpPos = (a: Pos, b: Pos) => a.msgIdx - b.msgIdx || a.blockIdx - b.blockIdx || a.charOffset - b.charOffset;

  app.get<{ Querystring: ChatQs }>('/api/state/bookmarks', { schema: { querystring: chatQs } }, async (req, reply) => {
    const { source, char, chat } = req.query;
    if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
    return { bookmarks: deps.state.listBookmarks(source, char, chat) };
  });

  app.post<{ Querystring: ChatQs; Body: { kind: 'bookmark' | 'highlight'; start: Pos; end?: Pos | null; note?: string; color?: string; text?: string } }>(
    '/api/state/bookmarks', { schema: { querystring: chatQs, body: bookmarkBody } },
    async (req, reply) => {
      const { source, char, chat } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      if (!store.getChat(source, char, chat)) return reply.code(404).send({ error: 'unknown chat' });
      const { kind, start } = req.body;
      const end = req.body.end ?? null;
      if (kind === 'highlight' && (!end || cmpPos(end, start) <= 0)) return reply.code(400).send({ error: 'highlight needs an end after its start' });
      if (kind === 'bookmark' && end) return reply.code(400).send({ error: 'bookmark has no end' });
      if (deps.state.countBookmarks(source, char, chat) >= MAX_BOOKMARKS_PER_CHAT) return reply.code(400).send({ error: 'too many bookmarks' });
      const bookmark = deps.state.addBookmark(source, char, chat, {
        kind, start, end, note: req.body.note ?? '', color: req.body.color ?? (kind === 'highlight' ? 'yellow' : ''), text: req.body.text ?? '',
      }, deps.now());
      return reply.code(201).send({ bookmark });
    });

  app.delete<{ Params: { id: string }; Querystring: ChatQs }>('/api/state/bookmarks/:id', { schema: { querystring: chatQs } }, async (req, reply) => {
    const { source, char, chat } = req.query;
    if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
    return deps.state.deleteBookmark(source, char, chat, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
  });

  app.patch<{ Params: { id: string }; Querystring: ChatQs; Body: { text: string } }>(
    '/api/state/bookmarks/:id',
    { schema: { querystring: chatQs, body: { type: 'object', required: ['text'], additionalProperties: false, propertyNames: { enum: ['text'] }, properties: { text: { type: 'string', maxLength: 2000 } } } } },
    async (req, reply) => {
      const { source, char, chat } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      return deps.state.setBookmarkText(source, char, chat, req.params.id, req.body.text)
        ? { id: req.params.id, text: req.body.text }
        : reply.code(404).send({ error: 'not found' });
    });

  // ── 형광펜 모아 보기 (형광펜 스펙 §3). 표시 이름(별칭 우선)과 원본 삭제 여부를 붙인다.
  app.get<{ Querystring: { limit?: string } }>(
    '/api/state/highlights',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[0-9]{1,4}$' } } } } },
    async (req, reply) => {
      const limit = req.query.limit === undefined ? 2000 : Number(req.query.limit);
      if (limit < 1 || limit > 5000) return reply.code(400).send({ error: 'bad limit' });
      const { rows, hasMore } = deps.state.listAllHighlights(limit);
      const charAlias = new Map<string, Map<string, string>>();
      const chatAlias = new Map<string, Map<string, string>>();
      const out = [];
      for (const r of rows) {
        if (!adapterOr404(r.source)) continue;
        if (!charAlias.has(r.source)) charAlias.set(r.source, deps.state.aliasMap(r.source, 'char'));
        const ck = `${r.source}\u0000${r.charId}`;
        if (!chatAlias.has(ck)) chatAlias.set(ck, deps.state.aliasMap(r.source, 'chat', r.charId));
        const chatRow = store.getChat(r.source, r.charId, r.chatId);
        out.push({
          id: r.id, source: r.source, charId: r.charId, chatId: r.chatId,
          charName: charAlias.get(r.source)!.get(r.charId) ?? store.getCharName(r.source, r.charId) ?? '',
          chatTitle: chatAlias.get(ck)!.get(r.chatId) ?? chatRow?.title ?? '',
          deleted: chatRow ? chatRow.deletedAt !== null : true,
          start: r.start, end: r.end, text: r.text, color: r.color, createdAt: r.createdAt,
        });
      }
      return { highlights: out, hasMore };
    });


  // ── 표시 이름 (스펙 §5.1, D25). chat 이 있으면 채팅, 없으면 캐릭터. 빈 이름 = 별칭 삭제.
  const CONTROL = /[\u0000-\u001f\u007f]/;
  app.put<{ Querystring: { source: string; char: string; chat?: string }; Body: { name: string } }>(
    '/api/state/alias',
    {
      schema: {
        querystring: { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str(), chat: str() } },
        body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 400 } } },
      },
    },
    async (req, reply) => {
      const { source, char, chat } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      let original: string;
      if (chat !== undefined) {
        const row = store.getChat(source, char, chat);
        if (!row) return reply.code(404).send({ error: 'unknown chat' });
        original = row.title;
      } else {
        const meta = store.getCharMeta(source, char);
        if (!meta) return reply.code(404).send({ error: 'unknown char' });
        original = store.listChars(source, true).find((c) => c.charId === char)?.name ?? '';
      }
      const name = req.body.name.trim();
      if (name.length > 80 || CONTROL.test(name)) return reply.code(400).send({ error: 'invalid name' });
      const kind = chat !== undefined ? 'chat' : 'char';
      if (name === '') deps.state.deleteAlias(source, kind, char, chat ?? '');
      else deps.state.setAlias(source, kind, char, chat ?? '', name, deps.now());
      return { displayName: name || original, originalName: original };
    });

  // ── 숨김 규칙 (스펙 §5.2, D26). 오류 응답에는 코드만 (패턴 원문 금지).
  const srcQs = { type: 'object', required: ['source'], additionalProperties: false, properties: { source: str(64) } } as const;
  const ruleBody = {
    type: 'object', required: ['name', 'pattern', 'scope'], additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 200 },
      pattern: { type: 'string', maxLength: 2000 },
      flags: { type: 'string', maxLength: 16 },
      scope: { type: 'string', enum: ['global', 'char'] },
      char: str(),
      enabled: { type: 'boolean' },
      origin: { type: 'string', enum: ['manual', 'card'] },
    },
  } as const;
  const rulePatch = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: { name: { type: 'string', maxLength: 200 }, pattern: { type: 'string', maxLength: 2000 }, flags: { type: 'string', maxLength: 16 }, enabled: { type: 'boolean' } },
  } as const;
  type RuleBody = { name: string; pattern: string; flags?: string; scope: 'global' | 'char'; char?: string; enabled?: boolean; origin?: 'manual' | 'card' };
  type RulePatch = { name?: string; pattern?: string; flags?: string; enabled?: boolean };

  app.get<{ Querystring: { source: string; char: string } }>(
    '/api/state/hide-rules',
    { schema: { querystring: { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str() } } } },
    async (req, reply) => {
      if (!adapterOr404(req.query.source)) return reply.code(404).send({ error: 'unknown source' });
      return { rules: deps.state.listHideRules(req.query.source, req.query.char) };
    });

  app.post<{ Querystring: { source: string }; Body: RuleBody }>(
    '/api/state/hide-rules', { schema: { querystring: srcQs, body: ruleBody } },
    async (req, reply) => {
      const { source } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      const b = req.body;
      if (b.scope === 'char' && !b.char) return reply.code(400).send({ error: 'char is required for scope char' });
      if (b.scope === 'char' && !store.getCharMeta(source, b.char!)) return reply.code(404).send({ error: 'unknown char' });
      const check = checkRule(b.name, b.pattern, b.flags ?? '');
      if (!check.ok) return reply.code(400).send({ error: 'invalid rule', reason: check.error });
      if (deps.state.countHideRules(source) >= RULE_LIMITS.perSource) return reply.code(400).send({ error: 'too many rules' });
      const rule = deps.state.addHideRule(source, {
        scope: b.scope, charId: b.scope === 'char' ? b.char! : '', name: b.name.trim(), pattern: b.pattern, flags: check.flags,
        enabled: b.enabled ?? true, origin: b.origin ?? 'manual',
      }, deps.now());
      return reply.code(201).send({ rule });
    });

  app.put<{ Params: { id: string }; Querystring: { source: string }; Body: RulePatch }>(
    '/api/state/hide-rules/:id', { schema: { querystring: srcQs, body: rulePatch } },
    async (req, reply) => {
      const { source } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      const cur = deps.state.getHideRule(source, req.params.id);
      if (!cur) return reply.code(404).send({ error: 'not found' });
      const next = { name: req.body.name ?? cur.name, pattern: req.body.pattern ?? cur.pattern, flags: req.body.flags ?? cur.flags };
      const check = checkRule(next.name, next.pattern, next.flags);
      if (!check.ok) return reply.code(400).send({ error: 'invalid rule', reason: check.error });
      const patch = { name: next.name.trim(), pattern: next.pattern, flags: check.flags, ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}) };
      return { rule: deps.state.updateHideRule(source, req.params.id, patch, deps.now()) };
    });

  app.delete<{ Params: { id: string }; Querystring: { source: string } }>(
    '/api/state/hide-rules/:id', { schema: { querystring: srcQs } },
    async (req, reply) => {
      if (!adapterOr404(req.query.source)) return reply.code(404).send({ error: 'unknown source' });
      return deps.state.deleteHideRule(req.query.source, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
    });

  // ── 카드 정규식 후보 (스펙 §5.3, D28): 유효하고 아직 등록되지 않은 editdisplay 패턴.
  app.get<{ Querystring: { source: string; char: string } }>(
    '/api/state/hide-candidates',
    { schema: { querystring: { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str() } } } },
    async (req, reply) => {
      const { source, char } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      const meta = store.getCharMeta(source, char);
      if (!meta) return reply.code(404).send({ error: 'unknown char' });
      const scripts = Array.isArray(meta.displayScripts) ? (meta.displayScripts as { comment?: unknown; in?: unknown; flag?: unknown }[]) : [];
      const have = new Set(deps.state.listHideRules(source, char).map((r) => `${r.flags}\u0000${r.pattern}`));
      const candidates: { name: string; pattern: string; flags: string }[] = [];
      for (const s of scripts) {
        if (typeof s.in !== 'string' || typeof s.flag !== 'string') continue;
        const name = typeof s.comment === 'string' && s.comment.trim() ? s.comment.trim() : '이름 없는 정규식';
        const check = checkRule(name, s.in, s.flag);
        if (!check.ok) continue;
        const key = `${check.flags}\u0000${s.in}`;
        if (have.has(key)) continue;
        have.add(key);
        candidates.push({ name, pattern: s.in, flags: check.flags });
      }
      return { candidates };
    });

  // ── 보관 (스펙 3D E3). 라이브러리에 있는 채팅만 (지워진 채팅 포함).
  app.put<{ Querystring: ChatQs; Body: { kept: boolean } }>(
    '/api/state/kept',
    { schema: { querystring: chatQs, body: { type: 'object', required: ['kept'], additionalProperties: false, properties: { kept: { type: 'boolean' } } } } },
    async (req, reply) => {
      const { source, char, chat } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      if (!store.getChat(source, char, chat)) return reply.code(404).send({ error: 'unknown chat' });
      deps.state.setKept(source, char, chat, req.body.kept, deps.now());
      const keptAt = req.body.kept ? deps.state.keptMap(source, char).get(keptKey(char, chat)) ?? null : null;
      return { kept: req.body.kept, keptAt };
    });

  // ── 카드 그림 규칙 (스펙 3C §3.4, D31)
  const charQs = { type: 'object', required: ['source', 'char'], additionalProperties: false, properties: { source: str(64), char: str() } } as const;
  const rulesOf = (source: string, char: string) => {
    const meta = store.getCharMeta(source, char);
    return meta && Array.isArray(meta.imageRules) ? (meta.imageRules as { key: string; name: string; in: string; flag: string; images: string[] }[]) : null;
  };
  app.get<{ Querystring: { source: string; char: string } }>('/api/state/image-rules', { schema: { querystring: charQs } }, async (req, reply) => {
    const { source, char } = req.query;
    if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
    if (!store.getCharMeta(source, char)) return reply.code(404).send({ error: 'unknown char' });
    const off = deps.state.imageRulesOff(source, char);
    const slow = store.imageRulesSlow(source, char);
    return {
      rules: (rulesOf(source, char) ?? []).map((r) => ({
        key: r.key, name: r.name, pattern: r.in, flags: r.flag, images: r.images, enabled: !off.has(r.key), slow: slow.has(r.key),
      })),
    };
  });
  app.put<{ Params: { key: string }; Querystring: { source: string; char: string }; Body: { enabled: boolean } }>(
    '/api/state/image-rules/:key',
    {
      schema: {
        params: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: '^[0-9a-f]{16}$' } } },
        querystring: charQs,
        body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      const { source, char } = req.query;
      if (!adapterOr404(source)) return reply.code(404).send({ error: 'unknown source' });
      const rules = rulesOf(source, char);
      if (!rules || !rules.some((r) => r.key === req.params.key)) return reply.code(404).send({ error: 'unknown rule' });
      deps.state.setImageRuleEnabled(source, char, req.params.key, req.body.enabled, deps.now());
      return { key: req.params.key, enabled: req.body.enabled };
    });

  app.get('/api/state/settings', async () => ({ settings: deps.state.getSettings() }));

  app.put<{ Body: Record<string, unknown> }>(
    '/api/state/settings',
    { schema: { body: { type: 'object', maxProperties: 32, propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_.]{0,63}$' } } } },
    async (req, reply) => {
      for (const v of Object.values(req.body)) {
        if (JSON.stringify(v ?? null).length > 4096) return reply.code(400).send({ error: 'value too large' });
      }
      deps.state.putSettings(req.body, deps.now());
      return { settings: deps.state.getSettings() };
    });

  // ── SPA 정적 서빙 (스펙 R7: CSP `default-src 'self'; img-src 'self' data:`).
  if (deps.webDir) {
    await app.register(helmet, {
      // useDefaults:false — 기본값의 upgrade-insecure-requests 가 http(Tailscale/LAN) 접속을 깨뜨린다.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
      strictTransportSecurity: false,
      crossOriginEmbedderPolicy: false,
    });
    await app.register(fastifyStatic, {
      root: deps.webDir,
      setHeaders(res, filePath) {
        res.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable' // Vite 가 파일명에 해시를 넣는다
          : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
