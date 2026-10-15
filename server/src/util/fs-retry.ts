// Windows 는 백신·색인기·OneDrive 가 방금 쓴 파일을 잠깐 잡으면 rename/rm 이 EPERM·EBUSY 등으로 실패한다. 짧게 다시 해 본다.
// (graceful-fs 가 win32 rename 을 재시도하는 것과 같은 이유). 다른 OS 에서는 이 오류가 진짜 권한 문제라 첫 오류를 바로 던진다.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const sab = new Int32Array(new SharedArrayBuffer(4));
const block = (ms: number) => { Atomics.wait(sab, 0, 0, ms); };

let defaultPlatform: NodeJS.Platform = process.platform;
/** 테스트 전용: 기본 플랫폼을 바꾼다 (인자 없이 부르면 process.platform 으로 되돌린다). */
export function __setRetryPlatformForTest(p?: NodeJS.Platform): void { defaultPlatform = p ?? process.platform; }

type Opts<S> = { tries?: number; delayMs?: number; sleep?: S; platform?: NodeJS.Platform };
const retryable = (e: unknown, platform: NodeJS.Platform) => {
  if (platform !== 'win32') return false;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
};

/** win32 에서만: 기본 6 번, i 번째 실패 뒤 delayMs(25) × i 만큼 기다린다. 다시 할 오류가 아니거나 횟수를 넘기면 마지막 오류를 던진다. */
export function withRetry<T>(fn: () => T, o: Opts<(ms: number) => void> = {}): T {
  const tries = o.tries ?? 6;
  const sleep = o.sleep ?? block;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries || !retryable(e, o.platform ?? defaultPlatform)) throw e;
      sleep((o.delayMs ?? 25) * i);
    }
  }
}

/** withRetry 와 같은 규칙. 이벤트 루프를 막지 않고 setTimeout 으로 기다린다. */
export async function withRetryAsync<T>(fn: () => T | Promise<T>, o: Opts<(ms: number) => Promise<void>> = {}): Promise<T> {
  const tries = o.tries ?? 6;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !retryable(e, o.platform ?? defaultPlatform)) throw e;
      await sleep((o.delayMs ?? 25) * i);
    }
  }
}
