// 고른 폴더 → PocketRisu save 폴더 판별 (스펙 §4.2). 읽기만 하고 아무것도 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export type DetectResult =
  | { ok: true; kind: 'pocketrisu'; saveDir: string }
  | { ok: false; reason: 'not-absolute' | 'unc' | 'not-found' | 'unreadable' };

// 파일이면 'file', 없거나 파일이 아니면 'no', 권한 오류(EACCES·EPERM)면 'unreadable'
function probe(f: string): 'file' | 'no' | 'unreadable' {
  try {
    return fs.statSync(f).isFile() ? 'file' : 'no';
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'no'; // 그 밖(ENOENT·ENOTDIR·EINVAL 등)은 없는 것으로
  }
}

export function detectSource(input: string): DetectResult {
  const raw = input.trim().replace(/^"(.*)"$/, '$1').trim();
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: 'unc' }; // 네트워크 공유 위 SQLite 는 위험 (구분자가 섞여도)
  if (!raw || !path.isAbsolute(raw)) return { ok: false, reason: 'not-absolute' };
  const dir = path.resolve(raw);
  let unreadable = false;
  for (const saveDir of [path.join(dir, 'save'), dir]) {
    const r = probe(path.join(saveDir, 'risuai.db'));
    if (r === 'file') return { ok: true, kind: 'pocketrisu', saveDir };
    if (r === 'unreadable') unreadable = true;
  }
  return { ok: false, reason: unreadable ? 'unreadable' : 'not-found' };
}
