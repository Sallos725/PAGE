import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AM, PNG, baseSpec, writeSource } from './helpers/synthetic-source.js';

const serverDir = path.join(import.meta.dirname, '..');

describe('smoke-sync (synthetic source)', () => {
  // npm run build 와 같다. Windows 의 npm 은 npm.cmd 라 shell 없이 못 띄우므로 node 로 tsc 를 직접 돌린다.
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(serverDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: serverDir, stdio: 'pipe' });
  }, 120_000);

  it('syncs, skips the second run by fingerprint, and every check passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-smoke-'));
    const spec = baseSpec();
    spec.characters[0]!.chats[0]!.message[0]!.data = `x {{raw::${AM(1)}}}`;
    spec.manifests = [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p.png', 'png']] }];
    spec.assets = { 'assets/p.png': PNG(1) };
    writeSource(path.join(root, 'src'), spec);
    const out = execFileSync(process.execPath, ['--no-warnings', path.join(serverDir, 'dist/tools/smoke-sync.js')], {
      env: { ...process.env, SMOKE_SOURCE_DIR: path.join(root, 'src'), SMOKE_DATA_DIR: path.join(root, 'data') },
      encoding: 'utf8',
    });
    const kv = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=') as [string, string]));
    expect(kv['first.outcome']).toBe('synced');
    expect(kv['first.errors']).toBe('0');
    expect(kv['first.chats.created']).toBe('3');
    expect(kv['second.outcome']).toBe('unchanged');
    expect(kv['library.chats']).toBe('3');
    expect(kv['check.message_window_bad']).toBe('0');
    expect(kv['check.head_asset_rows']).toBe('1');
    expect(kv['check.head_asset_files_bad']).toBe('0');
    expect(kv['health.status']).toBe('ok');
    // 출력에 합성 내용이 섞이지 않는다
    expect(out).not.toMatch(/Alice|Bob|u1|__am__/);
  });
});
