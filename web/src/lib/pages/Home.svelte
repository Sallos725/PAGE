<script lang="ts">
  import { api } from '../api';
  import Library from '../library/Library.svelte';
  import SyncNow from '../library/SyncNow.svelte';
  import { hrefs } from '../route';
  import { IMPORTED, sourceLabel } from '../sources';
  import type { SourceInfo } from '../types';

  // 가져온 채팅 원본은 캐릭터가 하나라도 있을 때만 목록에 낸다 (임포트를 안 쓰면 화면이 예전 그대로다).
  // hasImport: 서버에 가져오기가 켜져 있는가(PAGE_IMPORT=0 이면 링크도 안 낸다).
  // importError: imported 하나뿐인데 캐릭터 조회가 실패했다 — 안내 대신 오류 문구.
  async function loadSources(): Promise<{ list: SourceInfo[]; importOnly: boolean; hasImport: boolean; importError: boolean }> {
    const all = await api.sources();
    const hasImport = all.some((s) => s.id === IMPORTED);
    if (!hasImport) return { list: all, importOnly: false, hasImport, importError: false };
    let has = false;
    let importError = false;
    try { has = (await api.chars(IMPORTED)).length > 0; } catch { importError = true; }
    const list = has ? all : all.filter((s) => s.id !== IMPORTED);
    return { list, importOnly: list.length === 0 && !importError, hasImport, importError: importError && list.length === 0 };
  }
  const sources = loadSources();
  const status = api.status().catch(() => null);
  // 포터블이면 원본 연결 링크를 낸다. 못 받으면 링크 없이.
  const appInfo = api.app().catch(() => null);
  let reload = $state(0);
</script>

<main class="page library-page">
  <header class="library-aside" data-part="app-header">
    <div class="index">PERSONAL ARCHIVE &amp; GUTENBERG EXPERIENCE</div>
    <h1 class="library-title">서고</h1>
    <a class="appearance-link" href={hrefs.appearance}>테마·글꼴</a>
    <a class="appearance-link" href={hrefs.highlights}>형광펜</a>
    {#await sources then { hasImport }}
      {#if hasImport}<a class="appearance-link" href={hrefs.import}>가져오기</a>{/if}
    {/await}
    {#await appInfo then h}
      {#if h?.portable}<a class="appearance-link" href={hrefs.source}>원본 연결</a>{/if}
    {/await}
    {#await status then s}
      {#if s && s.warnings.length}
        <p class="notice" role="status">
          {#if s.warnings.includes('low-free-space')}저장 공간이 부족해요. {/if}
          {#if s.warnings.includes('new-assets-paused')}새 이미지 복사를 잠시 멈췄어요.{/if}
        </p>
      {/if}
    {/await}
  </header>
  <div class="library-main">
    {#await sources}
      <p class="status">불러오는 중…</p>
    {:then { list, importOnly, importError }}
      {#if importError}
        <p class="status" role="alert">가져온 채팅을 불러오지 못했어요.</p>
      {/if}
      {#if importOnly}
        <p class="status">RisuAI 에서 채팅을 내보내(.json) <a href={hrefs.import}>가져오기</a>로 올려 보세요.</p>
      {/if}
      {#if list.length}
        <SyncNow sources={list.map((s) => s.id)} lastSyncAt={Math.max(0, ...list.map((s) => s.lastSyncAt ?? 0)) || null} onDone={() => (reload += 1)} />
      {/if}
      {#key reload}
        {#if list.length === 1}
          <Library source={list[0]!.id} />
        {:else}
          {#each list as s, i (s.id)}
            <h2 class="source-name"><a href={hrefs.chars(s.id)}>{sourceLabel(s.id)}</a>{#if s.status !== 'ok'} <span class="badge" data-status={s.status}>{s.status === 'degraded' ? '검증되지 않은 버전' : '읽을 수 없음'}</span>{/if}</h2>
            <Library source={s.id} showDesk={i === 0} />
          {:else}
            {#if !importOnly && !importError}<p class="status">소스가 없어요.</p>{/if}
          {/each}
        {/if}
      {/key}
    {:catch}
      <p class="status" role="alert">서버에 연결할 수 없어요.</p>
    {/await}
  </div>
</main>
