import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeShutdown } from '../src/portable/shutdown.js';

afterEach(() => { vi.useRealTimers(); });
const flush = () => new Promise((r) => setImmediate(r));

describe('makeShutdown', () => {
  it('닫은 뒤 exit(code)', async () => {
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    makeShutdown({ close, exit, timeoutMs: 5000 })(75);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
  });
  it('close 가 거절돼도 exit(code)', async () => {
    const exit = vi.fn();
    makeShutdown({ close: async () => { throw new Error('x'); }, exit, timeoutMs: 5000 })(75);
    await flush();
    expect(exit).toHaveBeenCalledWith(75);
  });
  it('close 가 동기로 던져도 exit(code)', async () => {
    const exit = vi.fn();
    makeShutdown({ close: () => { throw new Error('x'); }, exit, timeoutMs: 5000 })(0);
    await flush();
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('오래 걸리면 timeoutMs 뒤 exit(code)', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    makeShutdown({ close: () => new Promise<void>(() => {}), exit, timeoutMs: 5000 })(75);
    await vi.advanceTimersByTimeAsync(4999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
  });
  it('두 번 불러도 한 번만 닫고 한 번만 exit', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    const shutdown = makeShutdown({ close, exit, timeoutMs: 5000 });
    shutdown(75);
    shutdown(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
  });
});
