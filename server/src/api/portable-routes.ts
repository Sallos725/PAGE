// 원본 연결 (스펙 §4.2). 포터블에서만 등록된다. 설정을 쓰면 응답을 보낸 뒤 서버를 다시 켠다(종료 코드 75 → launch 가 다시 띄움).
import type { FastifyInstance } from 'fastify';
import type { BrowseResult } from '../portable/browse.js';
import { detectSource } from '../portable/detect.js';
import { PORTABLE_SOURCE, readSettings, writeSettings } from '../portable/settings.js';
import type { SourceAdapter } from '../source/types.js';

export type PortableApiDeps = {
  dataDir: string;
  platform: NodeJS.Platform;
  browse: () => Promise<BrowseResult>;
  /** 응답을 다 보낸 뒤 부른다. 실제로는 app.close → process.exit(75). */
  restart: () => void;
};

const pathBody = {
  type: 'object', required: ['path'], additionalProperties: false,
  properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
} as const;

export async function registerPortableRoutes(app: FastifyInstance, deps: PortableApiDeps & { adapters: Map<string, SourceAdapter> }) {
  // JSON 본문만 받는다: text/plain 파서를 빼서 교차 출처 단순 요청(폼·text/plain)은 415 로 막힌다
  await app.register(async (scope) => {
    scope.removeContentTypeParser('text/plain');
    // 응답이 나갈 틈을 준 뒤 다시 켠다
    const later = () => { setTimeout(() => deps.restart(), 50); };

    scope.get('/api/portable/source', async () => {
      const s = readSettings(deps.dataDir).settings;
      const a = deps.adapters.get(PORTABLE_SOURCE);
      return {
        connected: s.pocketrisu ? { dir: s.pocketrisu.dir, health: a ? await a.health() : null } : null,
        platform: deps.platform,
      };
    });

    scope.post<{ Body: { path: string } }>('/api/portable/source/check', { schema: { body: pathBody } }, async (req) => detectSource(req.body.path));

    scope.put<{ Body: { path: string } }>('/api/portable/source', { schema: { body: pathBody } }, async (req, reply) => {
      const r = detectSource(req.body.path);
      if (!r.ok) return reply.code(400).send({ error: r.reason });
      writeSettings(deps.dataDir, { version: 1, pocketrisu: { dir: r.saveDir } });
      later();
      return reply.code(202).send({ restarting: true });
    });

    scope.delete('/api/portable/source', async (_req, reply) => {
      writeSettings(deps.dataDir, { version: 1, pocketrisu: null });
      later();
      return reply.code(202).send({ restarting: true });
    });

    scope.post('/api/portable/browse', { schema: { body: { type: 'object', maxProperties: 0 } } }, async (_req, reply) => {
      const r = await deps.browse();
      if ('error' in r) return reply.code(r.error === 'browse-unavailable' ? 501 : r.error === 'busy' ? 409 : 500).send({ error: r.error });
      return r;
    });
  });
}
