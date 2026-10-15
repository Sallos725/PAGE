// Windows 폴더 선택 창 (스펙 §4.2). 스크립트는 고정 — 사용자 입력은 명령에 넣지 않는다. 결과 경로는 판별을 거친 뒤에야 저장된다.
import { spawn } from 'node:child_process';

export const BROWSE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '# 숨김 실행(SW_HIDE)이 첫 ShowWindow 에 먹어 창이 안 보일 수 있다. 보이지 않는(1x1·투명) 소유 폼을 화면 가운데에 먼저 Show/Activate 로 소비한 뒤 대화상자를 연다. 대화상자 위치는 소유 창 기준이라 화면 밖에 두지 않는다.',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.ShowInTaskbar = $false',
  '$owner.Opacity = 0',
  '$owner.TopMost = $true',
  '$owner.Show()',
  '$owner.Activate()',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$d.Description = 'PocketRisu 폴더를 골라 주세요'",
  '$d.ShowNewFolderButton = $false',
  '# 콘솔 인코딩에 기대지 않고 UTF-8 바이트를 직접 쓴다.',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $b = [Text.Encoding]::UTF8.GetBytes($d.SelectedPath); $s = [Console]::OpenStandardOutput(); $s.Write($b, 0, $b.Length); $s.Flush() }',
  '$owner.Close()',
  '$owner.Dispose()',
].join('\n');

export type RunResult = { code: number | null; stdout: string };
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;
export type BrowseResult = { path: string } | { cancelled: true } | { error: 'browse-unavailable' | 'busy' | 'browse-failed' };

// stdin 을 닫아 두어야 PowerShell 이 입력을 기다리며 멈추지 않는다. 실패 여부만 쓴다 — timeout·spawn 오류는 code 1.
const MAX_STDOUT = 64 * 1024;
const defaultRun: Runner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    resolve({ code: 1, stdout: '' });
    return;
  }
  const timer = setTimeout(() => { child.kill(); finish(1); }, timeoutMs);
  child.stdout!.on('data', (c: Buffer) => {
    if (size >= MAX_STDOUT) return; // 넘는 부분은 버린다
    const part = c.subarray(0, MAX_STDOUT - size);
    chunks.push(part);
    size += part.length;
  });
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(code));
});

export function makeBrowser(o: { platform: NodeJS.Platform; run?: Runner; timeoutMs?: number }): () => Promise<BrowseResult> {
  const run = o.run ?? defaultRun;
  let busy = false;
  return async () => {
    if (o.platform !== 'win32') return { error: 'browse-unavailable' };
    if (busy) return { error: 'busy' };
    busy = true;
    try {
      const encoded = Buffer.from(BROWSE_SCRIPT, 'utf16le').toString('base64');
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], o.timeoutMs ?? 5 * 60_000);
      if (r.code !== 0) return { error: 'browse-failed' };
      const picked = r.stdout.trim();
      return picked ? { path: picked } : { cancelled: true };
    } catch {
      return { error: 'browse-failed' };
    } finally {
      busy = false;
    }
  };
}
