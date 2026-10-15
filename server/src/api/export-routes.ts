import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { downloadName, type ExportManager, type Produce } from '../export/jobs.js';
import { DEFAULT_EPUB_OPTIONS, produceEpub, type EpubOptions } from '../export/epub/produce.js';
import { producePdf } from '../export/pdf/produce.js';
import { produceJson } from '../export/json.js';
import { chatVersion } from '../export/source.js';
import type { LibraryStore } from '../library/store.js';
import type { SourceAdapter } from '../source/types.js';
import type { StateStore } from '../state/store.js';

// 내보내기 (스펙 2.5 §2.4). 작업 id 만 오가고, 결과물은 다운로드로만 나간다.
export type ExportRouteDeps = {
  store: LibraryStore;
  state: StateStore;
  adapters: Map<string, SourceAdapter>;
  exportManager: ExportManager;
  imageBudgetBytes?: number;
  /** PDF 사이드카 주소. null 이면 PDF 내보내기는 꺼진다. */
  pdfUrl?: string | null;
  /** 테스트에서만 쓴다. */
  pdfTimeoutMs?: number;
  now: () => number;
};

const str = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength } as const);
const chatQs = { type: 'object', required: ['source', 'char', 'chat'], additionalProperties: false, properties: { source: str(64), char: str(), chat: str() } } as const;
const jobParams = { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string', pattern: '^[0-9a-f]{32}$' } } } as const;
const MIME = { json: 'application/json; charset=utf-8', epub: 'application/epub+zip', pdf: 'application/pdf' } as const;

// Fastify 기본 Ajv 는 removeAdditional 이라 additionalProperties:false 만으로는 모르는 키를 조용히 지운다.
// propertyNames 는 지우지 않고 거절한다 (모르는 옵션은 400).
const EPUB_OPTION_KEYS = ['includeUser', 'cover', 'cardImages', 'chatImages', 'hideRuleIds', 'imageRuleKeys', 'imageMode'] as const;
const epubOptions = {
  type: 'object', propertyNames: { enum: EPUB_OPTION_KEYS },
  properties: {
    includeUser: { type: 'boolean' }, cover: { type: 'boolean' }, cardImages: { type: 'boolean' }, chatImages: { type: 'boolean' },
    hideRuleIds: { type: 'array', maxItems: 200, items: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } },
    imageRuleKeys: { type: 'array', maxItems: 50, items: { type: 'string', pattern: '^[0-9a-f]{16}$' } },
    imageMode: { type: 'string', enum: ['small', 'compat', 'original'] },
  },
} as const;

type PostBody = { format: 'json' | 'epub' | 'pdf'; version?: number; options?: Partial<EpubOptions> };

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps) {
  const { store, adapters, exportManager, pdfUrl } = deps;

  // 만들 수 있는 형식 (웹이 선택지를 정한다). pdf 는 사이드카가 설정된 때만.
  app.get('/api/export/formats', async () => ({ formats: ['json', 'epub', ...(pdfUrl ? ['pdf'] : [])] }));

  app.post<{ Querystring: { source: string; char: string; chat: string }; Body: PostBody }>(
    '/api/export',
    {
      schema: {
        querystring: chatQs,
        body: {
          type: 'object', required: ['format'], additionalProperties: false,
          properties: { format: { type: 'string', enum: ['json', 'epub', 'pdf'] }, version: { type: 'integer', minimum: 1 }, options: epubOptions },
        },
      },
    },
    async (req, reply) => {
      const { format, options } = req.body;
      if (format === 'json' && options !== undefined) return reply.code(400).send({ error: 'bad request' }); // JSON 은 원문 그대로 (X5)
      if (format === 'pdf') {
        if (!pdfUrl) return reply.code(400).send({ error: 'pdf-unavailable' });
        if (options?.imageMode === 'small') return reply.code(400).send({ error: 'bad-image-mode' }); // PDF 는 compat·original 만 (P5)
      }
      const { source, char, chat } = req.query;
      if (!adapters.has(source)) return reply.code(404).send({ error: 'unknown source' });
      const cv = chatVersion(store, source, char, chat, req.body.version);
      if (!cv) return reply.code(404).send({ error: 'unknown chat' });
      const epubCtx = () => ({
        store, state: deps.state, kind: adapters.get(source)!.kind, source, charId: char, cv, now: deps.now, imageBudgetBytes: deps.imageBudgetBytes,
        title: deps.state.aliasMap(source, 'chat', char).get(chat) ?? store.getChat(source, char, chat)!.title,
        author: deps.state.aliasMap(source, 'char').get(char) ?? store.getCharName(source, char) ?? '',
      });
      const produce: Produce = format === 'json'
        ? (tmp) => produceJson(store, cv, tmp)
        : format === 'epub'
          ? (tmp) => produceEpub(epubCtx(), { ...DEFAULT_EPUB_OPTIONS, ...options }, tmp)
          : (tmp) => producePdf({ ...epubCtx(), pdfUrl: pdfUrl!, pdfTimeoutMs: deps.pdfTimeoutMs }, { ...DEFAULT_EPUB_OPTIONS, imageMode: 'compat', ...options }, tmp);
      const job = exportManager.start(format, produce);
      if (!job) return reply.code(429).send({ error: 'too many exports' });
      return reply.code(202).send({ jobId: job.jobId });
    });

  app.get<{ Params: { jobId: string } }>('/api/export/:jobId', { schema: { params: jobParams } }, async (req, reply) => {
    const job = exportManager.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return { jobId: job.jobId, state: job.state, format: job.ext, size: job.size, warnings: job.warnings, error: job.error };
  });

  app.get<{ Params: { jobId: string } }>('/api/export/:jobId/download', { schema: { params: jobParams } }, async (req, reply) => {
    const job = exportManager.get(req.params.jobId);
    const file = job ? exportManager.filePath(job.jobId) : null;
    if (!job || !file) return reply.code(404).send({ error: 'not found' });
    // 파일을 먼저 열어 둔다: 확인과 전송 사이에 지워져도 첨부 헤더가 붙은 500 이 아니라 404 가 나간다.
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    const { size } = await fh.stat();
    return reply
      .header('Content-Disposition', `attachment; filename="${downloadName(job)}"`)
      .header('Cache-Control', 'no-store')
      .header('Content-Length', size)
      .type(MIME[job.ext])
      .send(fh.createReadStream());
  });
}
