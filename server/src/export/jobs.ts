import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 내보내기 작업 (스펙 2.5 §2.1). 포맷을 모른다 — produce(tmpFile) 를 하나씩 실행하고 결과 파일을 보관한다.
// 결과물은 사적 콘텐츠다: 파일 이름·상태 파일·로그에 채팅 내용을 넣지 않는다 (상태에는 오류 코드만).

export type ExportExt = 'json' | 'epub' | 'pdf';
export type ExportWarnings = { missingImages: number; skippedImages: number; slowRules: string[] };
export type ExportState = 'queued' | 'running' | 'done' | 'failed';
export type ExportJob = {
  jobId: string; ext: ExportExt; state: ExportState; createdAt: number;
  size?: number; warnings?: ExportWarnings; error?: string;
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
const EXTS: ExportExt[] = ['json', 'epub', 'pdf'];

/** 다운로드 파일 이름: 날짜(UTC) + 작업 id 앞 8자. 채팅·캐릭터 이름은 넣지 않는다 (스펙 §3.5.6). */
export function downloadName(job: Pick<ExportJob, 'jobId' | 'ext' | 'createdAt'>): string {
  const d = new Date(job.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
  return `page-${d}-${job.jobId.slice(0, 8)}.${job.ext}`;
}

export class ExportManager {
  private readonly jobs = new Map<string, ExportJob>();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly tmp: string;

  constructor(private readonly opts: { dir: string; now: () => number; ttlMs?: number; maxPending?: number; onError?: (code: string) => void }) {
    this.tmp = path.join(opts.dir, '.tmp');
    fs.mkdirSync(opts.dir, { recursive: true });
    fs.rmSync(this.tmp, { recursive: true, force: true }); // 이전 실행이 남긴 만들다 만 파일
    fs.mkdirSync(this.tmp, { recursive: true });
    this.sweep();
  }

  private file(id: string, ext: ExportExt) { return path.join(this.opts.dir, `${id}.${ext}`); }
  private statusFile(id: string) { return path.join(this.opts.dir, `${id}.status.json`); }

  /** 대기 작업이 상한 이상이면 null. */
  start(ext: ExportExt, produce: Produce): ExportJob | null {
    this.sweep();
    if (this.pending >= (this.opts.maxPending ?? 5)) return null;
    const job: ExportJob = { jobId: randomBytes(16).toString('hex'), ext, state: 'queued', createdAt: this.opts.now() };
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
    job.state = 'running';
    const tmpFile = path.join(this.tmp, `${job.jobId}.${job.ext}`);
    try {
      const { warnings } = await produce(tmpFile);
      const out = this.file(job.jobId, job.ext);
      fs.renameSync(tmpFile, out);
      job.size = fs.statSync(out).size;
      job.warnings = warnings;
      job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = e instanceof ExportError ? e.code : 'internal';
      try {
        this.opts.onError?.(job.error); // 오류 코드만 — 메시지·내용은 넘기지 않는다
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
      try {
        fs.writeFileSync(this.statusFile(job.jobId), JSON.stringify(job));
      } catch {
        /* 상태 파일을 못 써도 큐는 계속 돈다 (메모리 상태는 남아 있다) */
      }
    }
  }

  get(id: string): ExportJob | null {
    if (!ID.test(id)) return null;
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

  /** 만든 지 TTL 이 지난 끝난 작업의 결과·상태 파일을 지운다. */
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
      for (const ext of EXTS) fs.rmSync(this.file(id, ext), { force: true });
      fs.rmSync(path.join(this.opts.dir, name), { force: true });
      this.jobs.delete(id);
      n++;
    }
    return n;
  }
}
