import { Worker } from 'node:worker_threads';
import { ExportError } from '../jobs.js';

// 내보내기 정규식 적용 (스펙 2.5 X7). 사용자·카드 패턴이라 서버 이벤트 루프에서 돌리지 않는다 — eval 워커 + 규칙별 시간 제한.
// 결과는 웹 리더(web/src/lib/hide-rules.ts → image-rules.ts)와 같아야 한다 (test/export-transform.test.ts 가 웹 모듈과 대조).
// transformTexts 는 워커 소스로 직렬화되므로 바깥 이름을 참조하면 안 된다 (자기완결).
// 커버리지 계측(istanbul)은 .toString() 직렬화를 깨뜨린다 — v8 커버리지나 계측 없음만 쓴다.

export type TRule =
  | { kind: 'hide'; name: string; pattern: string; flags: string }
  | { kind: 'image'; name: string; pattern: string; flags: string; images: string[] };

/** 숨김 규칙 다음 카드 그림 규칙 순서로 들어와야 한다. onRule(i) 는 i 번째 규칙을 시작할 때 불린다. */
export function transformTexts(texts: string[], rules: TRule[], onRule: (i: number) => void): string[] {
  const MAX = 200_000;
  const valid = (n: string) => n.length >= 1 && n.length <= 300 && !/[{}\n\r]/.test(n);
  const control = (s: string) => /[\u0000-\u001f\u007f]/.test(s);
  const expand = (t: string, whole: string, groups: string[], named: Record<string, string> | undefined): string =>
    t.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (_all: string, k: string) => {
      if (k === '$') return '$';
      if (k === '&') return whole;
      if (k.startsWith('<')) return named?.[k.slice(1, -1)] ?? '';
      return Number(k) === 0 ? '' : (groups[Number(k) - 1] ?? '');
    });
  const out = texts.slice();
  let phase = '';
  let skip: boolean[] = [];
  rules.forEach((r, i) => {
    onRule(i);
    if (r.kind !== phase) { // 웹과 같이: 단계(숨김/그림)마다 시작 시점 길이로 200,000자 초과 메시지를 건너뛴다
      phase = r.kind;
      skip = out.map((t) => t.length > MAX);
    }
    let rf = r.flags; // 그림 규칙은 웹처럼 플래그를 그대로 쓴다
    if (r.kind === 'hide') { // 웹 compileRules → checkRule 과 같은 검증 (이름·패턴 길이·제어 문자·플래그)
      const n = (r.name || 'n').trim();
      if (n.length < 1 || n.length > 40 || control(n)) return;
      if (r.pattern.length < 1 || r.pattern.length > 500 || control(r.pattern)) return;
      if (/[^gimsu]/.test(rf)) return;
      rf = [...'gimsu'].filter((c) => rf.includes(c)).join(''); // 웹 normalizeFlags: 중복 제거, gimsu 순서
    }
    let re: RegExp;
    try {
      const flags = rf.includes('g') ? rf : `${rf}g`;
      if (new RegExp(r.pattern, flags.replace('g', '')).test('')) return;
      re = new RegExp(r.pattern, flags);
    } catch {
      return;
    }
    for (let j = 0; j < out.length; j++) {
      if (skip[j]) continue;
      re.lastIndex = 0;
      if (r.kind === 'hide') {
        out[j] = out[j]!.replace(re, '');
        continue;
      }
      const images = r.images;
      out[j] = out[j]!.replace(re, (...args: unknown[]) => {
        const whole = args[0] as string;
        const last = args[args.length - 1];
        const named = last && typeof last === 'object' ? (last as Record<string, string>) : undefined;
        const end = named ? args.length - 3 : args.length - 2; // [..groups, offset, string, groups?]
        const groups = args.slice(1, end).map((g) => (typeof g === 'string' ? g : ''));
        const names = images.map((t) => expand(t, whole, groups, named).trim()).filter(valid);
        return names.length ? `\n${names.map((n) => `{{raw::${n}}}`).join('\n')}\n` : whole;
      });
    }
  });
  return out;
}

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const transformTexts = (${transformTexts.toString()});
parentPort.on('message', (d) => {
  try { parentPort.postMessage({ texts: transformTexts(d.texts, d.rules, (i) => parentPort.postMessage({ at: i })) }); }
  catch { parentPort.postMessage({ error: true }); }
});
`;

type Once = { texts: string[] } | { slowAt: number } | { error: true };

const STARTUP_MS = 10_000; // 워커가 첫 규칙을 시작하기까지 (규칙 시간 제한과 별개 — 느린 부팅을 규칙 탓으로 돌리지 않는다)

function runOnce(texts: string[], rules: TRule[], perRuleMs: number): Promise<Once> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    let at = -1;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: Once) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(v);
    };
    timer = setTimeout(() => finish({ error: true }), STARTUP_MS);
    w.on('message', (d: { at?: number; texts?: string[] }) => {
      if (typeof d.at === 'number') {
        at = d.at;
        clearTimeout(timer);
        timer = setTimeout(() => finish({ slowAt: at }), perRuleMs);
        return;
      }
      finish(d.texts ? { texts: d.texts } : { error: true });
    });
    w.on('error', () => finish({ error: true }));
    w.on('exit', () => finish({ error: true })); // 결과 없이 죽은 경우 (done 이면 무시된다)
    w.postMessage({ texts, rules });
  });
}

const MAX_SLOW_DROPS = 3; // 느린 규칙을 이만큼 빼도 계속 느리면 재시도를 멈춘다 (워커를 계속 띄우지 않는다)

/**
 * 규칙 하나가 perRuleMs 를 넘기면 그 규칙을 빼고 처음부터 다시 돌린다. 뺀 규칙 이름은 slowRules 로 (화면용, 로그 금지).
 * 3개를 뺐는데도 또 느리면 멈추고, 원문을 그대로 돌려주며 모든 규칙 이름을 slowRules 에 넣는다 (적용된 규칙이 없음을 사용자가 보게).
 */
export async function transformInWorker(texts: string[], rules: TRule[], perRuleMs = 5_000): Promise<{ texts: string[]; slowRules: string[] }> {
  if (texts.length === 0) return { texts, slowRules: [] };
  let active = rules.slice();
  const slowRules: string[] = [];
  while (active.length > 0) {
    const r = await runOnce(texts, active, perRuleMs);
    if ('texts' in r) return { texts: r.texts, slowRules };
    if ('error' in r) throw new ExportError('internal');
    slowRules.push(active[r.slowAt]!.name);
    if (slowRules.length >= MAX_SLOW_DROPS && active.length > 1) return { texts, slowRules: rules.map((x) => x.name) };
    active = active.filter((_, i) => i !== r.slowAt);
  }
  return { texts, slowRules };
}
