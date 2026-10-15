import fs from 'node:fs';
import path from 'node:path';
import { PORTABLE_SOURCE, readSettings } from './portable/settings.js';
import type { SyncPolicy } from './sync/syncer.js';

export type SourceConfig = { id: string; dir: string };
export type Config = {
  sources: SourceConfig[];
  /** 가져온 채팅 원본(`imported`)을 쓰는가. PAGE_IMPORT=0 이면 끈다. */
  importEnabled: boolean;
  dataDir: string;
  bind: string;
  port: number;
  syncIntervalMs: number;
  debounceMs: number;
  warnFreePct: number;
  warnFreeBytes: number;
  stopAssetsFreeBytes: number;
  /** EPUB 내보내기 그림 용량 한도(변환 뒤 크기, X8). */
  exportImageBudgetBytes: number;
  /** PDF 사이드카(page-pdf) 주소. 없으면 PDF 내보내기는 꺼진다. */
  pdfUrl: string | null;
  /** 빌드된 SPA(web/dist). 없으면 API 만 서빙한다. */
  webDir?: string;
  /** 포터블 모드 (PAGE_PORTABLE=1, 스펙 §4.1). */
  portable: boolean;
  /** Host 헤더 허용 목록. null 이면 검사하지 않는다 (스펙 §5.1). */
  allowedHosts: string[] | null;
  /** 포터블 settings.json 을 읽지 못했다 (원본 없이 시작). */
  settingsBroken?: boolean;
};

const num = (env: NodeJS.ProcessEnv, key: string, def: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
};

const httpUrl = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const raw = (env[key] ?? '').trim();
  if (raw === '') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${key} must be an http(s) URL`); // 값은 에코하지 않는다 (자격 증명이 섞일 수 있다)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${key} must be an http(s) URL`);
  // 자격 증명·쿼리·해시는 받지 않는다 (사이드카 주소는 순수한 origin/경로여야 하고, 값은 에코하지 않는다)
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || raw.includes('?') || raw.includes('#') || raw.includes('@')) {
    throw new Error(`${key} must not contain credentials, a query or a fragment`);
  }
  return raw;
};

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
function parseHosts(raw: string | undefined): string[] | null {
  if ((raw ?? '').trim() === '') return null;
  const list = raw!.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) throw new Error('PAGE_ALLOWED_HOSTS entries must be host or host:port'); // " , " 처럼 항목이 없는 값
  if (!list.every((h) => HOST.test(h))) throw new Error('PAGE_ALLOWED_HOSTS entries must be host or host:port'); // 값은 에코하지 않는다
  // 루프백 이름은 포트와 상관없이 늘 허용한다. DNS rebinding 은 공격자 도메인 이름으로 Host 가 오므로 루프백 리터럴은 안전하고,
  // compose 헬스체크(127.0.0.1)·로컬 접속이 목록 때문에 깨지지 않게 한다.
  for (const h of LOOPBACK) if (!list.includes(h)) list.push(h);
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const dataDir = env.PAGE_DATA_DIR ?? '';
  if (!dataDir) throw new Error('PAGE_DATA_DIR is required');
  const portable = env.PAGE_PORTABLE === '1';
  const sources: SourceConfig[] = [];
  let settingsBroken = false;
  let importEnabled = true;
  if (portable) {
    // 포터블: 원본은 settings.json 에서만 읽는다 (PAGE_SOURCES·PAGE_IMPORT 는 무시)
    const r = readSettings(dataDir);
    settingsBroken = r.broken;
    if (r.settings.pocketrisu) sources.push({ id: PORTABLE_SOURCE, dir: r.settings.pocketrisu.dir });
  } else {
    const rawSources = (env.PAGE_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    importEnabled = env.PAGE_IMPORT !== '0';
    if (rawSources.length === 0 && !importEnabled) throw new Error('PAGE_SOURCES is required when PAGE_IMPORT=0 (name=path[,name=path])');
    for (const item of rawSources) {
      const eq = item.indexOf('=');
      if (eq < 1) throw new Error('PAGE_SOURCES entries must be name=path');
      const id = item.slice(0, eq);
      const dir = item.slice(eq + 1);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('invalid source name');
      if (id === 'imported') throw new Error('reserved source name'); // 가져온 채팅 원본이 쓰는 이름
      if (!path.isAbsolute(dir)) throw new Error('source path must be absolute');
      if (sources.some((s) => s.id === id)) throw new Error('duplicate source name');
      sources.push({ id, dir });
    }
  }
  if (env.PAGE_PRESERVE_ORPHANS === '1') throw new Error('PAGE_PRESERVE_ORPHANS=1 is not implemented yet (spec 3.4.6: reserved)');
  const port = env.PAGE_PORT === undefined || env.PAGE_PORT === '' ? 8787 : Number(env.PAGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PAGE_PORT must be a valid port');
  const allowedHosts = portable ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] : parseHosts(env.PAGE_ALLOWED_HOSTS);
  return {
    sources,
    importEnabled,
    dataDir,
    bind: portable ? '127.0.0.1' : env.PAGE_BIND || '127.0.0.1',
    port, // 8787 은 개발 기본값일 뿐이다. 운영 포트는 D13(단계 3)에서 정한다.
    syncIntervalMs: num(env, 'PAGE_SYNC_INTERVAL_MIN', 15) * 60_000,
    debounceMs: num(env, 'PAGE_VERSION_DEBOUNCE_MIN', 10) * 60_000, // D17 확정 (2026-10-15)
    warnFreePct: num(env, 'PAGE_WARN_FREE_PCT', 20),
    warnFreeBytes: num(env, 'PAGE_WARN_FREE_GB', 10) * 1e9,
    stopAssetsFreeBytes: num(env, 'PAGE_STOP_ASSETS_FREE_GB', 2) * 1e9,
    exportImageBudgetBytes: num(env, 'PAGE_EXPORT_IMAGE_BUDGET_MB', 300) * 1024 * 1024,
    pdfUrl: httpUrl(env, 'PAGE_PDF_URL'),
    webDir: env.PAGE_WEB_DIR ? path.resolve(env.PAGE_WEB_DIR) : undefined,
    portable,
    allowedHosts,
    ...(settingsBroken ? { settingsBroken: true } : {}),
  };
}

export function makePolicy(c: Config): SyncPolicy {
  return {
    debounceMs: c.debounceMs,
    massDeletionRatio: 0.5,
    warnFreePct: c.warnFreePct,
    warnFreeBytes: c.warnFreeBytes,
    stopAssetsFreeBytes: c.stopAssetsFreeBytes,
    freeSpace: () => {
      const s = fs.statfsSync(c.dataDir);
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    },
  };
}
