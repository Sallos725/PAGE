// 저장 전에 Worker 에서 패턴을 불러온 메시지들에 돌려 본다. 시간 상한을 넘기면 Worker 를 죽이고 'slow'.
export type TrialWorker = { onmessage: ((e: MessageEvent) => void) | null; postMessage(data: unknown): void; terminate(): void };
export type TrialResult = { ok: true; count: number } | { ok: false; error: 'slow' | 'compile' };

export const TRIAL_TIMEOUT_MS = 300;

const defaultWorker = (): TrialWorker =>
  new Worker(new URL('./hide-trial.worker.ts', import.meta.url), { type: 'module' }) as unknown as TrialWorker;

export function trialRun(
  pattern: string, flags: string, texts: string[], timeoutMs = TRIAL_TIMEOUT_MS, make: () => TrialWorker = defaultWorker,
): Promise<TrialResult> {
  return new Promise((resolve) => {
    const w = make();
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, error: 'slow' }); }, timeoutMs);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      const d = e.data as { ok: boolean; count?: number };
      resolve(d.ok && typeof d.count === 'number' ? { ok: true, count: d.count } : { ok: false, error: 'compile' });
    };
    w.postMessage({ pattern, flags, texts });
  });
}
