import type { SourceAdapter } from '../source/types.js';
import type { Syncer } from './syncer.js';

/** 스펙 3.4.4 ①② : 시작 시 + 주기. 소스 하나의 실패가 다른 소스를 막지 않는다. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly o: { syncer: Syncer; adapters: SourceAdapter[]; intervalMs: number; onError: (sourceId: string) => void }) {}

  async tick(): Promise<void> {
    for (const a of this.o.adapters) {
      try {
        await this.o.syncer.syncSource(a);
      } catch {
        this.o.onError(a.id); // 내용 없는 식별자만 전달
      }
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
