<script lang="ts">
  import { api } from '../api';
  import { syncSummary, type SyncReportLite } from '../sync-summary';

  // 지금 동기화 (스펙 3D E4). 소스마다 차례로, 디바운스 무시. 결과는 개수로만.
  let { sources, lastSyncAt, onDone }: { sources: string[]; lastSyncAt: number | null; onDone: () => void } = $props();
  let busy = $state(false);
  let message = $state<string | null>(null);
  let last = $state<number | null>(null);
  const shown = $derived(last ?? lastSyncAt);
  const time = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  async function run() {
    busy = true;
    message = null;
    const reports: SyncReportLite[] = [];
    let failed = 0;
    for (const s of sources) {
      try { reports.push(await api.syncNow(s)); } catch { failed += 1; } // 한 소스가 실패해도 나머지는 계속
    }
    try {
      message = syncSummary(reports, failed);
      if (reports.length) {
        last = Math.max(...reports.map((r) => r.finishedAt));
        onDone();
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="sync-now">
  <button type="button" disabled={busy} onclick={() => void run()}>{busy ? '동기화 중…' : '지금 동기화'}</button>
  {#if shown}<span class="meta">마지막 동기화 {time(shown)}</span>{/if}
  <p class="meta" role="status">{message ?? ''}</p>
</div>
