import { Worker } from 'node:worker_threads';

// 카드 그림 규칙 → 그림 이름 (스펙 3C §3.2·§3.3). computeRuleNames 는 바깥 변수를 쓰지 않는 자기완결 함수다:
// 소스 문자열 그대로 eval 워커로 보내 시간 제한을 걸고 돌린다 (카드 패턴은 신뢰할 수 없는 정규식).
// 웹의 web/src/lib/image-rules.ts 와 같은 규칙이다 — 바꾸면 둘 다 바꾼다.
export type RuleInput = { key: string; name: string; in: string; flag: string; images: string[] };

export function computeRuleNames(chats: string[][], rules: RuleInput[]): string[][] {
  const MAX_MESSAGE = 200_000;
  const valid = (n: string) => n.length >= 1 && n.length <= 300 && !/[{}\n\r]/.test(n);
  const expand = (t: string, m: RegExpMatchArray) =>
    t.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (_all, k: string) => {
      if (k === '$') return '$';
      if (k === '&') return m[0];
      if (k.startsWith('<')) return m.groups?.[k.slice(1, -1)] ?? '';
      return Number(k) === 0 ? '' : (m[Number(k)] ?? ''); // $0 은 빈 문자열 (웹과 같다)
    });
  const compiled: { re: RegExp; images: string[] }[] = [];
  for (const r of rules) {
    try {
      const flags = r.flag.includes('g') ? r.flag : `${r.flag}g`;
      if (new RegExp(r.in, flags.replace('g', '')).test('')) continue; // 빈 문자열에 걸리는 패턴
      compiled.push({ re: new RegExp(r.in, flags), images: r.images });
    } catch {
      /* 깨진 패턴은 건너뛴다 */
    }
  }
  return chats.map((texts) => {
    const out: string[] = [];
    for (const t of texts) {
      if (typeof t !== 'string' || t.length > MAX_MESSAGE) continue;
      for (const c of compiled) {
        for (const m of t.matchAll(c.re)) {
          if (!m[0]) continue;
          for (const tpl of c.images) {
            const n = expand(tpl, m).trim();
            if (valid(n)) out.push(n);
          }
        }
      }
    }
    return out;
  });
}

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const computeRuleNames = (${computeRuleNames.toString()});
parentPort.on('message', (d) => { try { parentPort.postMessage({ names: computeRuleNames(d.chats, d.rules) }); } catch { parentPort.postMessage({ error: true }); } });
`;

/** 워커에서 계산. 시간 안에 끝나지 않으면 워커를 죽이고 { slow: true }. */
export function ruleNamesInWorker(chats: string[][], rules: RuleInput[], timeoutMs: number): Promise<{ names: string[][] } | { slow: true }> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    let done = false;
    const finish = (v: { names: string[][] } | { slow: true }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => finish({ slow: true }), timeoutMs);
    w.on('message', (d: { names?: string[][] }) => finish(d.names ? { names: d.names } : { names: chats.map(() => []) }));
    w.on('error', () => finish({ names: chats.map(() => []) }));
    w.postMessage({ chats, rules });
  });
}
