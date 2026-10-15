<script lang="ts">
  import { api } from '../api';
  import { hrefs } from '../route';
  import type { RecentItem, Shelf as ShelfT } from '../types';
  import CharImage from './CharImage.svelte';
  import Desk from './Desk.svelte';
  import Shelf from './Shelf.svelte';
  import { keptItems, splitShelves } from '../library-view';
  import MixedShelf from './MixedShelf.svelte';

  // 서고 (스펙 6.2): 위 책상, 아래 캐릭터별 서가. showDesk=false 면 서가만 (소스가 여럿일 때 두 번째부터).
  let { source, showDesk = true }: { source: string; showDesk?: boolean } = $props();
  let shelves = $state<ShelfT[] | null>(null);
  let recent = $state<RecentItem[]>([]);
  let failed = $state(false);
  const view = $derived(shelves ? splitShelves(shelves) : null);
  const kept = $derived(shelves ? keptItems(shelves) : []);
  // svelte-ignore state_referenced_locally
  void Promise.all([api.shelves(source), showDesk ? api.recent(3) : Promise.resolve([] as RecentItem[])])
    .then(([s, r]) => { shelves = s; recent = r; })
    .catch(() => { failed = true; });
</script>

<div class="library">
  {#if showDesk}<Desk items={recent} />{/if}
  {#if kept.length}
    <section class="kept-shelf" data-part="kept-shelf" aria-labelledby={`kept-${source}`}>
      <div class="section-head"><h2 id={`kept-${source}`}>보관함</h2><span class="index">KEPT · {kept.length}권</span></div>
      <MixedShelf {source} items={kept} scale={0.75} />
    </section>
  {/if}
  <section class="stacks" aria-labelledby={`stacks-${source}`}>
    <div class="section-head"><h2 id={`stacks-${source}`}>서가</h2><span class="index">02 / STACKS{view ? ` · 캐릭터 ${view.live.length}` : ''}</span></div>
    {#if failed}
      <p class="status" role="alert">불러오지 못했어요.</p>
    {:else if !view}
      <p class="status">불러오는 중…</p>
    {:else}
      {#each view.live as s (s.charId)}
        <div class="shelf-block">
          <a class="shelf-label" data-part="shelf-label" href={hrefs.chats(source, s.charId)}>
            <CharImage src={s.imageUrl} name={s.displayName} />
            <span class="shelf-name">{s.displayName || '(이름 없음)'}</span>
            <span class="meta">채팅 {s.chatCount}권 ›</span>
          </a>
          <Shelf {source} char={s.charId} chats={s.chats} scale={0.75} />
        </div>
      {:else}
        <p class="status">캐릭터가 없어요.</p>
      {/each}
    {/if}
  </section>
  {#if view && view.gone.length}
    <section class="gone-stacks" aria-labelledby={`gone-${source}`}>
      <div class="section-head"><h2 id={`gone-${source}`}>원본에서 지워진 캐릭터</h2><span class="index">{view.gone.length}명</span></div>
      <p class="hint">RisuAI 에서는 지워졌지만 PAGE 사본은 그대로 읽을 수 있어요.</p>
      {#each view.gone as s (s.charId)}
        <div class="shelf-block">
          <a class="shelf-label" data-part="shelf-label" href={hrefs.chats(source, s.charId)}>
            <CharImage src={s.imageUrl} name={s.displayName} />
            <span class="shelf-name">{s.displayName || '(이름 없음)'}</span>
            <span class="meta">채팅 {s.chatCount}권 ›</span>
          </a>
          <Shelf {source} char={s.charId} chats={s.chats} scale={0.75} />
        </div>
      {/each}
    </section>
  {/if}
</div>
