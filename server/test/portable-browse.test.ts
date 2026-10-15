import { describe, expect, it, vi } from 'vitest';
import { BROWSE_SCRIPT, makeBrowser } from '../src/portable/browse.js';

describe('makeBrowser', () => {
  it('Windows 가 아니면 browse-unavailable (실행 안 함)', async () => {
    const run = vi.fn();
    expect(await makeBrowser({ platform: 'linux', run })()).toEqual({ error: 'browse-unavailable' });
    expect(run).not.toHaveBeenCalled();
  });
  it('고른 경로 / 취소 / 실패', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'C:\\Users\\합성\\PocketRisu\r\n' })
      .mockResolvedValueOnce({ code: 0, stdout: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '' });
    const browse = makeBrowser({ platform: 'win32', run });
    expect(await browse()).toEqual({ path: 'C:\\Users\\합성\\PocketRisu' });
    expect(await browse()).toEqual({ cancelled: true });
    expect(await browse()).toEqual({ error: 'browse-failed' });
  });
  it('고정 스크립트를 -EncodedCommand 로만 넘긴다 (사용자 입력 없음)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    await makeBrowser({ platform: 'win32', run })();
    const [cmd, args, timeout] = run.mock.calls[0]!;
    expect(cmd).toBe('powershell.exe');
    expect(args).toHaveLength(5);
    expect(timeout).toBe(300000);
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toBe(BROWSE_SCRIPT);
    expect(BROWSE_SCRIPT).toContain('OpenStandardOutput');
    expect(BROWSE_SCRIPT).toContain('$owner.Show()');
    expect(BROWSE_SCRIPT).not.toContain('OutputEncoding');
    expect(BROWSE_SCRIPT).toContain('CenterScreen');
    expect(BROWSE_SCRIPT).toContain('-AssemblyName System.Drawing');
    expect(BROWSE_SCRIPT).not.toContain('-32000');
  });
  it('한 번에 하나 — 진행 중이면 busy', async () => {
    let done!: (v: { code: number; stdout: string }) => void;
    const run = vi.fn(() => new Promise<{ code: number; stdout: string }>((r) => { done = r; }));
    const browse = makeBrowser({ platform: 'win32', run });
    const first = browse();
    expect(await browse()).toEqual({ error: 'busy' });
    done({ code: 0, stdout: '' });
    expect(await first).toEqual({ cancelled: true });
    expect(await (run.mockResolvedValueOnce({ code: 0, stdout: '' }), browse())).toEqual({ cancelled: true });
  });
});
