<script lang="ts">
  import Home from './lib/pages/Home.svelte';
  import Chars from './lib/pages/Chars.svelte';
  import Chats from './lib/pages/Chats.svelte';
  import Appearance from './lib/pages/Appearance.svelte';
  import Highlights from './lib/pages/Highlights.svelte';
  import Import from './lib/pages/Import.svelte';
  import Source from './lib/pages/Source.svelte';
  import Reader from './lib/reader/Reader.svelte';
  import { router } from './lib/router.svelte';
  import { safeMode } from './lib/theme-link';

  const r = $derived(router.route);
  const key = $derived(JSON.stringify(r));
  const safe = safeMode();
  // 쿼리를 뺀 같은 화면으로 다시 연다 (프리셋 다시 켜기). 해시가 바뀌면 router.route 가 바뀌어 href 도 갱신된다.
  const reopenHref = $derived((void r, `/${location.hash}`));
  const leaveSafe = (e: MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // 새 탭 열기 등은 브라우저에 맡긴다
    e.preventDefault();
    location.href = reopenHref;
  };
</script>

{#if safe}
  <p class="safe-banner" role="status" data-part="safe-banner">커스텀 테마를 끈 상태(안전 모드)예요. <a href={reopenHref} onclick={leaveSafe}>다시 켜기</a></p>
{/if}
{#key key}
  {#if r.name === 'home'}
    <Home />
  {:else if r.name === 'chars'}
    <Chars source={r.source} />
  {:else if r.name === 'chats'}
    <Chats source={r.source} char={r.char} />
  {:else if r.name === 'read'}
    <Reader source={r.source} char={r.char} chat={r.chat} />
  {:else if r.name === 'appearance'}
    <Appearance />
  {:else if r.name === 'highlights'}
    <Highlights />
  {:else if r.name === 'import'}
    <Import />
  {:else if r.name === 'source'}
    <Source />
  {:else}
    <main class="page"><p>없는 화면이에요. <a href="#/">처음으로</a></p></main>
  {/if}
{/key}
