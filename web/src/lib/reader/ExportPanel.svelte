<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ApiError, api } from '../api';
  import { defaultEpubOptions, exportErrorText, imageModeOnFormatChange, pollExport, statusText, toggleId, warningLines } from '../export-options';
  import type { EpubOptions, ExportFormat, ExportStatus, HideRule, ImageRule } from '../types';

  type Props = {
    source: string; char: string; chat: string;
    hideRules: HideRule[]; imageRules: ImageRule[]; hideUser: boolean;
    version?: number;
    onClose: () => void;
  };
  let { source, char, chat, version, hideRules, imageRules, hideUser, onClose }: Props = $props();

  let format = $state<ExportFormat>('epub');
  // 패널을 연 순간의 리더 상태가 기본값이다 (스펙 2.5 §3) — 처음 값만 쓰는 게 의도다
  // svelte-ignore state_referenced_locally
  let opts = $state<EpubOptions>(defaultEpubOptions(hideRules, imageRules, hideUser));
  let busy = $state(false);
  let status = $state<ExportStatus | null>(null);
  let error = $state<string | null>(null);
  let alive = true;
  onDestroy(() => { alive = false; });

  // 서버가 PDF 를 만들 수 있을 때만 PDF 선택지를 보인다. 목록을 못 받으면 PDF 없이 본다.
  let formats = $state<ExportFormat[]>(['json', 'epub']);
  // 포터블 판에는 PDF 사이드카가 없다 — PDF 자리에 안내를 낸다. 못 받으면 안내 없이.
  let portable = $state(false);
  onMount(async () => {
    try {
      const r = await api.exportFormats();
      if (alive) formats = r.formats;
    } catch { /* 기본 목록 그대로 */ }
  });
  onMount(async () => {
    try {
      const h = await api.app();
      if (alive) portable = h.portable === true;
    } catch { /* 안내 없이 */ }
  });

  // 사용자가 그림 크기를 직접 골랐는지 — 형식을 오갈 때 기본값을 되돌려도 되는지 가른다
  let imageModeChosen = false;
  function pickFormat(f: ExportFormat) {
    format = f;
    opts.imageMode = imageModeOnFormatChange(f, opts.imageMode, imageModeChosen);
    clearResult();
  }

  // 형식·옵션이 바뀌면 이전 결과(상태·다운로드 링크)는 낡은 것이다
  function clearResult() { status = null; error = null; }

  async function run() {
    busy = true;
    status = null;
    error = null;
    let phase: 'start' | 'poll' = 'start';
    try {
      const base = version === undefined ? {} : { version };
      const body = format === 'json' ? { format, ...base } : { format, ...base, options: $state.snapshot(opts) };
      const { jobId } = await api.startExport(source, char, chat, body);
      if (!alive) return;
      phase = 'poll';
      await pollExport(() => api.exportStatus(jobId), {
        onStatus: (s) => { status = s; },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        alive: () => alive,
      });
    } catch (e) {
      if (!alive) return;
      status = null;
      error = exportErrorText(e instanceof ApiError ? e.status : null, phase);
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<div class="panel export-panel" data-part="panel" role="dialog" aria-label="내보내기">
  <div class="panel-head">
    <strong>내보내기</strong>
    <button type="button" onclick={onClose}>닫기</button>
  </div>
  <fieldset class="list" disabled={busy}>
    <legend class="sub-head">형식</legend>
    <label class="rule-on"><input type="radio" name="export-format" value="epub" checked={format === 'epub'} onchange={() => pickFormat('epub')} /> 책 (EPUB)</label>
    {#if formats.includes('pdf')}
      <label class="rule-on"><input type="radio" name="export-format" value="pdf" checked={format === 'pdf'} onchange={() => pickFormat('pdf')} /> PDF (A5)</label>
    {:else if portable}
      <p class="status">PDF 는 Docker 판에서 만들 수 있어요.</p>
    {/if}
    <label class="rule-on"><input type="radio" name="export-format" value="json" checked={format === 'json'} onchange={() => pickFormat('json')} /> RisuAI 가져오기용 (JSON)</label>
  </fieldset>

  {#if format === 'json'}
    <p class="hint">원문 그대로예요. 정규식·그림 옵션은 없고, 가져오면 RisuAI 에 새 채팅으로 추가돼요. 채팅 폴더 정보는 빠져요.</p>
  {:else}
    <fieldset class="list" disabled={busy} onchange={clearResult}>
      <legend class="sub-head">넣을 것</legend>
      <label class="rule-on"><input type="checkbox" bind:checked={opts.includeUser} /> 내 메시지</label>
      <label class="rule-on"><input type="checkbox" bind:checked={opts.cover} /> 표지 그림</label>
      <label class="rule-on"><input type="checkbox" bind:checked={opts.cardImages} /> 본문 카드 그림</label>
      <label class="rule-on"><input type="checkbox" bind:checked={opts.chatImages} /> 채팅 속 그림</label>
    </fieldset>
    <fieldset class="list" disabled={busy} onchange={clearResult}>
      <legend class="sub-head">그림 크기</legend>
      {#if format !== 'pdf'}
        <label class="rule-on"><input type="radio" name="export-image-mode" value="small" bind:group={opts.imageMode} onchange={() => (imageModeChosen = true)} /> 줄이기 (애플 북스 등 최신 앱)</label>
      {/if}
      <label class="rule-on"><input type="radio" name="export-image-mode" value="compat" bind:group={opts.imageMode} onchange={() => (imageModeChosen = true)} /> {format === 'pdf' ? '호환 우선 (JPEG)' : '호환 우선 (킨들 등 전자잉크 기기에 최적화)'}</label>
      <label class="rule-on"><input type="radio" name="export-image-mode" value="original" bind:group={opts.imageMode} onchange={() => (imageModeChosen = true)} /> 원본</label>
    </fieldset>
    {#if opts.imageMode === 'compat' && format === 'pdf'}
      <p class="hint">그림을 JPEG 로 바꿔 넣어요. 투명한 부분은 흰색으로 채워져요.</p>
    {:else if opts.imageMode === 'compat'}
      <p class="hint">킨들 등 전자잉크 기기에 최적화된 형식이에요. 투명한 부분은 흰색으로 채워져요.</p>
    {:else if opts.imageMode === 'original'}
      <p class="hint">그림을 그대로 넣어요. 그림이 많으면 용량 한도에 걸려 일부가 빠질 수 있어요.</p>
    {/if}
    {#if hideRules.length || imageRules.length}
      <fieldset class="list" disabled={busy} onchange={clearResult}>
        <legend class="sub-head">적용할 정규식</legend>
        {#each hideRules as r (r.id)}
          <label class="rule-on"><input type="checkbox" checked={opts.hideRuleIds.includes(r.id)} onchange={(e) => (opts.hideRuleIds = toggleId(opts.hideRuleIds, r.id, e.currentTarget.checked))} /> 숨김: {r.name || '이름 없는 규칙'}</label>
        {/each}
        {#each imageRules as r (r.key)}
          <label class="rule-on"><input type="checkbox" disabled={r.slow} checked={opts.imageRuleKeys.includes(r.key)} onchange={(e) => (opts.imageRuleKeys = toggleId(opts.imageRuleKeys, r.key, e.currentTarget.checked))} /> 카드 그림: {r.name || '이름 없는 규칙'}{r.slow ? ' (느려서 꺼둠)' : ''}</label>
        {/each}
      </fieldset>
    {/if}
  {/if}

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <p class="meta" role="status">{status ? statusText(status) : ''}</p>
  {#if status}
    {#each warningLines(status.warnings) as line (line)}<p class="meta">{line}</p>{/each}
    {#if status.state === 'done'}<a class="wide" href={api.exportDownloadUrl(status.jobId)} download>다운로드</a>{/if}
  {/if}
  <button type="button" class="wide" disabled={busy} onclick={() => void run()}>만들기</button>
</div>
