<script lang="ts">
  import { api } from '../api';
  import Library from '../library/Library.svelte';
  import SyncNow from '../library/SyncNow.svelte';
  import { hrefs } from '../route';

  const sources = api.sources();
  const status = api.status().catch(() => null);
  let reload = $state(0);
</script>

<main class="page library-page">
  <header class="library-aside" data-part="app-header">
    <div class="index">PERSONAL ARCHIVE &amp; GUTENBERG EXPERIENCE</div>
    <h1 class="library-title">서고</h1>
    <a class="appearance-link" href={hrefs.appearance}>테마·글꼴</a>
    <a class="appearance-link" href={hrefs.highlights}>형광펜</a>
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
    {:then list}
      {#if list.length}
        <SyncNow sources={list.map((s) => s.id)} lastSyncAt={Math.max(0, ...list.map((s) => s.lastSyncAt ?? 0)) || null} onDone={() => (reload += 1)} />
      {/if}
      {#key reload}
        {#if list.length === 1}
          <Library source={list[0]!.id} />
        {:else}
          {#each list as s, i (s.id)}
            <h2 class="source-name"><a href={hrefs.chars(s.id)}>{s.id}</a>{#if s.status !== 'ok'} <span class="badge" data-status={s.status}>{s.status === 'degraded' ? '검증되지 않은 버전' : '읽을 수 없음'}</span>{/if}</h2>
            <Library source={s.id} showDesk={i === 0} />
          {:else}
            <p class="status">소스가 없어요.</p>
          {/each}
        {/if}
      {/key}
    {:catch}
      <p class="status" role="alert">서버에 연결할 수 없어요.</p>
    {/await}
  </div>
</main>
