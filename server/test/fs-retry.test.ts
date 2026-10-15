import { describe, expect, it, vi } from 'vitest';
import { __setRetryPlatformForTest, withRetry, withRetryAsync } from '../src/util/fs-retry.js';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('withRetry', () => {
  it('EPERM·EBUSY 는 다시 해 보고 성공하면 값을 돌려준다', () => {
    const fn = vi.fn().mockImplementationOnce(() => { throw err('EPERM'); }).mockImplementationOnce(() => { throw err('EBUSY'); }).mockReturnValue(7);
    expect(withRetry(fn, { platform: 'win32', sleep: () => {} })).toBe(7);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('EACCES·ENOTEMPTY 도 다시 한다', () => {
    const fn = vi.fn().mockImplementationOnce(() => { throw err('EACCES'); }).mockImplementationOnce(() => { throw err('ENOTEMPTY'); }).mockReturnValue('ok');
    expect(withRetry(fn, { platform: 'win32', sleep: () => {} })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('다른 오류는 바로 던진다', () => {
    const fn = vi.fn(() => { throw err('ENOENT'); });
    expect(() => withRetry(fn, { platform: 'win32', sleep: () => {} })).toThrow('ENOENT');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('횟수를 넘기면 마지막 오류를 던진다', () => {
    const fn = vi.fn(() => { throw err('EBUSY'); });
    expect(() => withRetry(fn, { platform: 'win32', tries: 4, sleep: () => {} })).toThrow('EBUSY');
    expect(fn).toHaveBeenCalledTimes(4);
  });
  it('기본은 6 번, 기다림은 25ms × 횟수', () => {
    const waits: number[] = [];
    const fn = vi.fn(() => { throw err('EPERM'); });
    expect(() => withRetry(fn, { platform: 'win32', sleep: (ms) => { waits.push(ms); } })).toThrow('EPERM');
    expect(fn).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([25, 50, 75, 100, 125]);
  });
  it('기본 sleep 으로도 실제로 기다렸다가 성공한다', () => {
    const fn = vi.fn().mockImplementationOnce(() => { throw err('EBUSY'); }).mockReturnValue(1);
    expect(withRetry(fn, { platform: 'win32', delayMs: 1 })).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetryAsync', () => {
  it('같은 규칙으로 다시 해 보고 값을 돌려준다', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockImplementationOnce(() => { throw err('EPERM'); }).mockRejectedValueOnce(err('EBUSY')).mockResolvedValue(9);
    await expect(withRetryAsync(fn, { platform: 'win32', sleep: async (ms) => { waits.push(ms); } })).resolves.toBe(9);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([25, 50]);
  });
  it('다른 오류는 바로, 횟수를 넘기면 마지막 오류를 던진다', async () => {
    const enoent = vi.fn(async () => { throw err('ENOENT'); });
    await expect(withRetryAsync(enoent, { platform: 'win32', sleep: async () => {} })).rejects.toThrow('ENOENT');
    expect(enoent).toHaveBeenCalledTimes(1);
    const busy = vi.fn(async () => { throw err('EBUSY'); });
    await expect(withRetryAsync(busy, { platform: 'win32', tries: 3, sleep: async () => {} })).rejects.toThrow('EBUSY');
    expect(busy).toHaveBeenCalledTimes(3);
  });
  it('기본 sleep(setTimeout) 으로도 성공한다', async () => {
    const fn = vi.fn().mockRejectedValueOnce(err('EACCES')).mockResolvedValue(2);
    await expect(withRetryAsync(fn, { platform: 'win32', delayMs: 1 })).resolves.toBe(2);
  });
});

describe('win32 에서만 다시 한다', () => {
  it('그 밖의 플랫폼은 EPERM 도 첫 오류를 바로 던진다 (동기·비동기)', async () => {
    const fn = vi.fn(() => { throw err('EPERM'); });
    expect(() => withRetry(fn, { platform: 'linux', sleep: () => {} })).toThrow('EPERM');
    expect(fn).toHaveBeenCalledTimes(1);
    const afn = vi.fn(async () => { throw err('EBUSY'); });
    await expect(withRetryAsync(afn, { platform: 'darwin', sleep: async () => {} })).rejects.toThrow('EBUSY');
    expect(afn).toHaveBeenCalledTimes(1);
  });
  it('기본값은 process.platform 이고, 테스트용 setter 로 바꿀 수 있다', () => {
    const once = () => vi.fn().mockImplementationOnce(() => { throw err('EPERM'); }).mockReturnValue(1);
    try {
      __setRetryPlatformForTest('win32');
      const a = once();
      expect(withRetry(a, { sleep: () => {} })).toBe(1);
      expect(a).toHaveBeenCalledTimes(2);
      __setRetryPlatformForTest('linux');
      const b = once();
      expect(() => withRetry(b, { sleep: () => {} })).toThrow('EPERM');
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      __setRetryPlatformForTest();
    }
  });
});
