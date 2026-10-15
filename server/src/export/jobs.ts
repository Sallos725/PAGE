import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRetry, withRetryAsync } from '../util/fs-retry.js';

// 내보내기 작업 (스펙 2.5 §2.1). 포맷을 모른다 — produce(tmpFile) 를 하나씩 실행하고 결과 파일을 보관한다.
// 결과물은 사적 콘텐츠다: 파일 이름·상태 파일·로그에 채팅 내용을 넣지 않는다 (상태에는 오류 코드만).

export type ExportExt = 'json' | 'epub' | 'pdf';
export type ExportWarnings = { missingImages: number; skippedImages: number; slowRules: string[] };
export type ExportState = 'queued' | 'running' | 'done' | 'failed';
/** 작업을 만든 채팅 (id 만 — 제목·이름 같은 내용은 넣지 않는다). 채팅을 완전히 지울 때 결과물도 함께 지우는 데 쓴다. */
export type ExportOwner = { source: string; charId: string; chatId: string };
export type ExportJob = {
  jobId: string; ext: ExportExt; state: ExportState; createdAt: number;
  size?: number; warnings?: ExportWarnings; error?: string; owner?: ExportOwner;
};
export type Produce = (tmpFile: string) => Promise<{ warnings: ExportWarnings }>;

export class ExportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExportError';
  }
}
export const noWarnings = (): ExportWarnings => ({ missingImages: 0, skippedImages: 0, slowRules: [] });

const ID = /^[0-9a-f]{32}$/;
const STATUS = /^([0-9a-f]{32})\.status\.json$/;
const RESULT = /^([0-9a-f]{32})\.(?:json|epub|pdf)$/;
const EXTS: ExportExt[] = ['json', 'epub', 'pdf'];
const isOwner = (o: unknown): o is ExportOwner => {
  const v = o as Partial<ExportOwner> | null;
  return !!v && typeof v === 'object' && typeof v.source === 'string' && typeof v.charId === 'string' && typeof v.chatId === 'string';
};

/** 다운로드 파일 이름: 날짜(UTC) + 작업 id 앞 8자. 채팅·캐릭터 이름은 넣지 않는다 (스펙 §3.5.6). */
export function downloadName(job: Pick<ExportJob, 'jobId' | 'ext' | 'createdAt'>): string {
  const d = new Date(job.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
  return `page-${d}-${job.jobId.slice(0, 8)}.${job.ext}`;
}

export class ExportManager {
  private readonly jobs = new Map<string, ExportJob>();
  /** 대기·실행 중에 지워진 작업. run() 이 결과를 남기지 않고 정리한다. */
  private readonly cancelled = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly tmp: string;

  constructor(private readonly opts: { dir: string; now: () => number; ttlMs?: number; maxPending?: number; onError?: (code: string) => void }) {
    this.tmp = path.join(opts.dir, '.tmp');
    fs.mkdirSync(opts.dir, { recursive: true });
    withRetry(() => fs.rmSync(this.tmp, { recursive: true, force: true })); // 이전 실행이 남긴 만들다 만 파일
    fs.mkdirSync(this.tmp, { recursive: true });
    this.sweep();
  }

  private file(id: string, ext: ExportExt) { return path.join(this.opts.dir, `${id}.${ext}`); }
  private statusFile(id: string) { return path.join(this.opts.dir, `${id}.status.json`); }

  /** 대기 작업이 상한 이상이면 null. */
  start(ext: ExportExt, produce: Produce, owner?: ExportOwner): ExportJob | null {
    this.sweep();
    if (this.pending >= (this.opts.maxPending ?? 5)) return null;
    const job: ExportJob = { jobId: randomBytes(16).toString('hex'), ext, state: 'queued', createdAt: this.opts.now() };
    if (owner) job.owner = { source: owner.source, charId: owner.charId, chatId: owner.chatId };
    this.jobs.set(job.jobId, job);
    this.pending++;
    this.chain = this.chain.then(() => this.run(job, produce)).catch(() => {});
    return { ...job };
  }

  /** 지금까지 넣은 작업이 모두 끝나면 풀린다 (테스트용). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async run(job: ExportJob, produce: Produce): Promise<void> {
    const tmpFile = path.join(this.tmp, `${job.jobId}.${job.ext}`);
    if (this.cancelled.has(job.jobId)) { // 대기 중에 지워졌다: 만들지 않는다
      this.cancelled.delete(job.jobId);
      this.pending--;
      return;
    }
    job.state = 'running';
    try {
      const { warnings } = await produce(tmpFile);
      if (this.cancelled.has(job.jobId)) throw new ExportError('deleted'); // 실행 중에 지워졌다: 결과를 남기지 않는다
      const out = this.file(job.jobId, job.ext);
      await withRetryAsync(() => fs.renameSync(tmpFile, out)); // Windows: 백신·OneDrive 의 순간 잠금
      // rename 을 기다리는 사이(await)에 지워졌으면 결과를 남기지 않는다
      if (this.cancelled.has(job.jobId)) { withRetry(() => fs.rmSync(out, { force: true })); throw new ExportError('deleted'); }
      job.size = fs.statSync(out).size;
      job.warnings = warnings;
      job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = e instanceof ExportError ? e.code : 'internal';
      try {
        if (!this.cancelled.has(job.jobId)) this.opts.onError?.(job.error); // 오류 코드만 — 메시지·내용은 넘기지 않는다
      } catch {
        /* 콜백이 던져도 큐는 계속 */
      }
      try {
        fs.rmSync(tmpFile, { force: true, recursive: true });
      } catch {
        /* 지우지 못해도 큐는 계속 */
      }
    } finally {
      this.pending--;
      if (this.cancelled.delete(job.jobId)) {
        this.jobs.delete(job.jobId); // 지워진 작업은 상태도 남기지 않는다
      } else {
        try {
          fs.writeFileSync(this.statusFile(job.jobId), JSON.stringify(job));
        } catch {
          /* 상태 파일을 못 써도 큐는 계속 돈다 (메모리 상태는 남아 있다) */
        }
      }
    }
  }

  /**
   * owner 가 조건에 맞는 작업을 지운다 (채팅을 완전히 지울 때). 끝난 작업은 결과·상태 파일을 지우고,
   * 대기·실행 중인 작업은 취소해 결과를 남기지 않는다. 메모리에 없는 작업(재시작 뒤)은 상태 파일의 owner 로 판정한다.
   * owner 가 없는 (옛) 작업은 건드리지 않는다. 지운 작업 수를 돌려준다.
   */
  purgeOwned(match: (owner: ExportOwner) => boolean): number {
    let n = 0;
    const remove = (id: string) => {
      for (const ext of EXTS) withRetry(() => fs.rmSync(this.file(id, ext), { force: true }));
      withRetry(() => fs.rmSync(this.statusFile(id), { force: true }));
    };
    for (const [id, job] of [...this.jobs]) {
      if (!job.owner || !match(job.owner)) continue;
      if (job.state === 'queued' || job.state === 'running') this.cancelled.add(id);
      else remove(id);
      this.jobs.delete(id);
      n++;
    }
    for (const name of fs.readdirSync(this.opts.dir)) {
      const m = STATUS.exec(name);
      if (!m || this.jobs.has(m[1]!) || this.cancelled.has(m[1]!)) continue;
      let owner: unknown;
      try {
        owner = (JSON.parse(fs.readFileSync(path.join(this.opts.dir, name), 'utf8')) as { owner?: unknown } | null)?.owner;
      } catch {
        continue; // 깨진 상태 파일은 sweep 이 TTL 에 맞춰 지운다
      }
      if (!isOwner(owner) || !match(owner)) continue;
      remove(m[1]!);
      n++;
    }
    this.dropOrphans();
    return n;
  }

  get(id: string): ExportJob | null {
    if (!ID.test(id) || this.cancelled.has(id)) return null;
    let j: ExportJob | null = this.jobs.get(id) ?? null;
    if (!j) {
      try {
        j = JSON.parse(fs.readFileSync(this.statusFile(id), 'utf8')) as ExportJob; // 재시작 뒤
      } catch {
        return null;
      }
      if (!j || !EXTS.includes(j.ext) || typeof j.createdAt !== 'number') return null; // 검증 안 된 ext 로 경로를 만들지 않는다
    }
    // TTL 이 지난 결과는 sweep 전이라도 내주지 않는다
    if (j.createdAt <= this.opts.now() - (this.opts.ttlMs ?? 24 * 3600_000)) return null;
    return { ...j, jobId: id };
  }

  /** 끝난 작업의 결과 파일. 없거나 안 끝났으면 null. */
  filePath(id: string): string | null {
    const j = this.get(id);
    if (!j || j.state !== 'done') return null;
    const f = this.file(id, j.ext);
    return fs.existsSync(f) ? f : null;
  }

  /** 만든 지 TTL 이 지난 끝난 작업의 결과·상태 파일과, 상태 파일 없는 고아 결과 파일을 지운다. */
  sweep(): number {
    const cut = this.opts.now() - (this.opts.ttlMs ?? 24 * 3600_000);
    let n = 0;
    for (const name of fs.readdirSync(this.opts.dir)) {
      const m = STATUS.exec(name);
      if (!m) continue;
      const id = m[1]!;
      let job: ExportJob | null = null;
      try {
        job = JSON.parse(fs.readFileSync(path.join(this.opts.dir, name), 'utf8')) as ExportJob;
      } catch {
        /* 깨진 상태 파일도 지운다 */
      }
      if (job && job.createdAt > cut) continue;
      for (const ext of EXTS) withRetry(() => fs.rmSync(this.file(id, ext), { force: true }));
      withRetry(() => fs.rmSync(path.join(this.opts.dir, name), { force: true }));
      this.jobs.delete(id);
      n++;
    }
    this.dropOrphans();
    return n;
  }

  /**
   * 상태 파일도 없고 메모리에도 없는 결과 파일을 지운다 (지운 작업의 결과 파일을 끝내 못 지웠을 때 등 — 사적 콘텐츠라 남기지 않는다).
   * 메모리에 있는 작업(실행 중, rename 직후 상태 파일을 쓰기 전)의 결과는 건드리지 않는다. 지우기는 다음 기회에 다시 하므로 실패해도 던지지 않는다.
   */
  private dropOrphans() {
    for (const name of fs.readdirSync(this.opts.dir)) {
      const m = RESULT.exec(name);
      if (!m || this.jobs.has(m[1]!) || fs.existsSync(this.statusFile(m[1]!))) continue;
      try { withRetry(() => fs.rmSync(path.join(this.opts.dir, name), { force: true })); } catch { /* 다음 sweep 이 다시 한다 */ }
    }
  }
}
