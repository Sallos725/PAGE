// 포터블 설정 (스펙 §4.1). 원본 경로는 JSON 으로 둬서 쉼표·= 가 든 Windows 경로도 안전하다.
import fs from 'node:fs';
import path from 'node:path';
import { withRetry } from '../util/fs-retry.js';

export type PortableSettings = { version: 1; pocketrisu: { dir: string } | null };
/** 포터블에서 연결한 PocketRisu 원본의 source id (W9). */
export const PORTABLE_SOURCE = 'pocketrisu';
/** 서버가 "다시 켜 줘" 하며 끝날 때의 종료 코드. launch 가 받으면 다시 띄운다. */
export const RESTART_CODE = 75;

const FILE = 'settings.json';
const empty = (): PortableSettings => ({ version: 1, pocketrisu: null });

export function readSettings(dataDir: string): { settings: PortableSettings; broken: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, FILE), 'utf8');
  } catch (e) {
    // 파일이 없을 때만 정상. 읽기 실패(권한·디렉터리 등)는 깨진 것으로 본다
    return { settings: empty(), broken: (e as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
  try {
    // 메모장이 붙이는 BOM 은 벗긴다
    const v = JSON.parse(raw.replace(/^\uFEFF/, '')) as { version?: unknown; pocketrisu?: unknown };
    if (!v || v.version !== 1) return { settings: empty(), broken: true };
    if (v.pocketrisu === null || v.pocketrisu === undefined) return { settings: empty(), broken: false };
    const dir = (v.pocketrisu as { dir?: unknown }).dir;
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || /^(?:\\\\|\/\/)/.test(dir)) return { settings: empty(), broken: true };
    return { settings: { version: 1, pocketrisu: { dir } }, broken: false };
  } catch {
    return { settings: empty(), broken: true };
  }
}

export function writeSettings(dataDir: string, s: PortableSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  withRetry(() => fs.renameSync(tmp, file)); // Windows: 백신·OneDrive 의 순간 잠금
}
