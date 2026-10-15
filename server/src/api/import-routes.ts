// 가져온 채팅 API (임포트 스펙 §6). 오류는 짧은 코드만, 로그에 이름·내용을 남기지 않는다.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ExportManager } from '../export/jobs.js';
import { IMPORT_LIMITS, parseRisuExport } from '../import/format.js';
import type { ImportStore } from '../import/store.js';
import type { LibraryStore } from '../library/store.js';
import { IMPORTED_SOURCE } from '../source/import/adapter.js';
import type { SourceAdapter } from '../source/types.js';
import type { StateStore } from '../state/store.js';
import type { Syncer } from '../sync/syncer.js';

export type ImportDeps = {
  imports: ImportStore; adapter: SourceAdapter; syncer: Syncer; store: LibraryStore; state: StateStore; now: () => number;
  /** 내보내기 작업 관리자. 있으면 완전히 지울 때 그 채팅으로 만든 결과물(대기·진행 중 포함)도 지운다. */
  exportManager?: ExportManager;
};

const charParams = { type: 'object', required: ['charId'], properties: { charId: { type: 'string', pattern: '^[0-9a-f]{32}$' } } } as const;
const chatParams = {
  type: 'object', required: ['charId', 'chatId'],
  properties: { charId: { type: 'string', pattern: '^[0-9a-f]{32}$' }, chatId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
} as const;
// Fastify 기본 Ajv 는 additionalProperties:false 만으로는 모르는 키를 조용히 지운다 — propertyNames 로 400 을 낸다.
const nameBody = {
  type: 'object', required: ['name'], additionalProperties: false, propertyNames: { enum: ['name'] },
  properties: { name: { type: 'string', minLength: 1, maxLength: IMPORT_LIMITS.nameMax } },
} as const;
const ERROR_STATUS: Record<string, number> = { 'bad-name': 400, 'bad-image': 400, 'too-large': 413, 'not-found': 404 };

export async function registerImportRoutes(app: FastifyInstance, deps: ImportDeps) {
  const { imports, syncer, store, state, adapter, exportManager } = deps;
  /** 그 캐릭터만 동기화한다 (다른 캐릭터의 문제가 이 요청을 막지 않게). */
  const sync = (charId: string) => syncer.syncSource(adapter, { force: true, onlyChar: charId });
  const fail = (reply: FastifyReply, e: unknown) => {
    const code = e instanceof Error ? e.message : '';
    const status = ERROR_STATUS[code];
    if (!status) throw e; // 알 수 없는 오류는 공통 핸들러가 500 (내용 없음)
    return reply.code(status).send({ error: code });
  };

  /** 완전히 지우기: 라이브러리 → state → 내보내기 결과물 → 파일 순서 (스펙 §5). 원본 큐 안에서 한 번에 (동기화와 겹치지 않는다). */
  const purgeChat = (charId: string, chatId: string) => {
    store.purgeChat(IMPORTED_SOURCE, charId, chatId);
    state.purgeChatState(IMPORTED_SOURCE, charId, chatId);
    exportManager?.purgeOwned((o) => o.source === IMPORTED_SOURCE && o.charId === charId && o.chatId === chatId);
    imports.deleteChat(charId, chatId);
  };
  const purgeChar = (charId: string) => {
    store.purgeChar(IMPORTED_SOURCE, charId);
    state.purgeCharState(IMPORTED_SOURCE, charId);
    exportManager?.purgeOwned((o) => o.source === IMPORTED_SOURCE && o.charId === charId);
    imports.deleteChar(charId);
  };
  /** 지운 글자가 -wal 에 남지 않게 두 DB 를 체크포인트한다 (요청 하나에 한 번, 지우기 블록 끝에서). */
  const checkpoint = () => { store.checkpoint(); state.checkpoint(); };

  app.get('/api/import/chars', async () => ({
    // 깨진 캐릭터(char.json 을 못 읽음)도 내보낸다 — 화면은 지우기만 보여 준다
    chars: imports.listChars().map((c) => ({ charId: c.charId, name: c.name, ...(c.broken ? { broken: true } : {}), hasImage: c.hasImage, chatCount: c.chatCount })),
  }));

  app.post<{ Body: { name: string } }>('/api/import/chars', { schema: { body: nameBody } }, async (req, reply) => {
    try {
      const charId = imports.createChar(req.body.name, deps.now());
      await sync(charId);
      return reply.code(201).send({ charId });
    } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { charId: string }; Body: { name: string } }>(
    '/api/import/chars/:charId', { schema: { params: charParams, body: nameBody } },
    async (req, reply) => {
      try {
        if (!imports.renameChar(req.params.charId, req.body.name)) return reply.code(404).send({ error: 'not-found' });
        await sync(req.params.charId);
        return { ok: true };
      } catch (e) { return fail(reply, e); }
    });

  // 그림만 원시 바이트를 받는다: 파서와 10MB 상한을 이 범위 안에만 둔다.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: IMPORT_LIMITS.imageBytes }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { charId: string }; Body: unknown }>(
      '/api/import/chars/:charId/image',
      { bodyLimit: IMPORT_LIMITS.imageBytes, schema: { params: charParams } },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'bad-image' });
        try {
          const old = store.getCharImage(IMPORTED_SOURCE, req.params.charId)?.hash ?? null;
          imports.setImage(req.params.charId, req.body);
          await sync(req.params.charId);
          dropOldImage(req.params.charId, old);
          return { ok: true };
        } catch (e) { return fail(reply, e); }
      });
  });

  /** 그림을 바꾸거나 지운 뒤 옛 그림 blob 을 (다른 데서 안 쓰면) 지운다. */
  const dropOldImage = (charId: string, old: string | null) => {
    if (!old) return;
    if (store.getCharImage(IMPORTED_SOURCE, charId)?.hash === old) return;
    store.dropUnusedAssets(new Set([old]));
  };

  app.delete<{ Params: { charId: string } }>('/api/import/chars/:charId/image', { schema: { params: charParams } }, async (req, reply) => {
    const { charId } = req.params;
    if (!imports.getChar(charId)) return reply.code(404).send({ error: 'not-found' });
    const old = store.getCharImage(IMPORTED_SOURCE, charId)?.hash ?? null;
    imports.removeImage(charId);
    await sync(charId);
    dropOldImage(charId, old);
    return reply.code(204).send();
  });

  app.post<{ Params: { charId: string }; Body: unknown }>(
    '/api/import/chars/:charId/chats',
    { bodyLimit: IMPORT_LIMITS.fileBytes, schema: { params: charParams } },
    async (req, reply) => {
      if (!imports.getChar(req.params.charId)) return reply.code(404).send({ error: 'not-found' });
      const parsed = parseRisuExport(req.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      try {
        const results = imports.putChats(req.params.charId, parsed.chats);
        const report = await sync(req.params.charId); // 응답은 동기화가 끝난 뒤 — 바로 서고에서 보인다
        // 올린 파일은 저장됐다. 서고 반영이 건너뛰어졌거나 오류가 있으면 알린다 (다음 동기화가 이어서 한다).
        const pending = report.outcome === 'skipped' || report.errors > 0;
        return pending ? { results, sync: 'pending' as const } : { results };
      } catch (e) { return fail(reply, e); }
    });

  app.delete<{ Params: { charId: string; chatId: string } }>(
    '/api/import/chars/:charId/chats/:chatId', { schema: { params: chatParams } },
    async (req, reply) => {
      const { charId, chatId } = req.params;
      const found = await syncer.exclusive(IMPORTED_SOURCE, () => {
        if (!imports.charDirExists(charId)) return false;
        const has = imports.listChatFiles(charId).some((f) => f.chatId === chatId) || store.getChat(IMPORTED_SOURCE, charId, chatId) !== null;
        if (!has) return false;
        purgeChat(charId, chatId);
        // 마지막 채팅을 지우면 캐릭터도 함께 지운다 (사용자 결정 — 스펙 I4)
        if (imports.listChatFiles(charId).length === 0) purgeChar(charId);
        checkpoint();
        return true;
      });
      return found ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' });
    });

  app.delete<{ Params: { charId: string } }>('/api/import/chars/:charId', { schema: { params: charParams } }, async (req, reply) => {
    const { charId } = req.params;
    const found = await syncer.exclusive(IMPORTED_SOURCE, () => {
      if (!imports.charDirExists(charId)) return false; // char.json 이 깨졌어도 폴더가 있으면 지운다
      purgeChar(charId); // 라이브러리(채팅 전부 한 번에) → 캐릭터 단위 state → 파일(char.json 마지막)
      checkpoint();
      return true;
    });
    return found ? reply.code(204).send() : reply.code(404).send({ error: 'not-found' });
  });
}
