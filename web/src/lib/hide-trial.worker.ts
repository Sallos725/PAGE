// 정규식 시험 실행 Worker (스펙 §5.2.2). 오래 걸리는 패턴은 메인 스레드가 terminate() 로 끊는다.
import { countMatches } from './hide-rules';

type Req = { pattern: string; flags: string; texts: string[] };
const ctx = self as unknown as { addEventListener(t: 'message', f: (e: MessageEvent<Req>) => void): void; postMessage(m: unknown): void };

ctx.addEventListener('message', (e) => {
  try {
    ctx.postMessage({ ok: true, count: countMatches(e.data.texts, e.data.pattern, e.data.flags) });
  } catch {
    ctx.postMessage({ ok: false });
  }
});
