import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * 프라이버시 규칙(스펙 0장): 요청 본문·쿼리·URL 값, 에러 메시지/스택(내용이 섞일 수 있음)을 로그에 남기지 않는다.
 * 남기는 것: 메서드, 라우트 *패턴*, 상태 코드, 에러 타입.
 */
export function loggerOptions(level: string, stream?: { write(msg: string): void }) {
  return {
    level,
    ...(stream ? { stream } : {}),
    serializers: {
      req: (req: FastifyRequest) => ({ method: req.method, route: req.routeOptions?.url ?? '-' }),
      res: (res: FastifyReply) => ({ statusCode: res.statusCode }),
      err: (err: { type?: string; name?: string }) => ({ type: err.type ?? err.name ?? 'Error' }),
    },
  };
}
