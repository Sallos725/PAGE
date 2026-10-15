<script lang="ts">
  import { hrefs } from '../route';
  import type { RecentItem } from '../types';
  import CharImage from './CharImage.svelte';
  // 이어 읽기 책상 (스펙 6.2): 첫 권 크게, 나머지는 줄.
  let { items }: { items: RecentItem[] } = $props();
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  function bar(node: HTMLElement, p: number) {
    const apply = (v: number) => { node.style.width = pct(v); };
    apply(p);
    return { update: apply };
  }
  const first = $derived(items[0] ?? null);
  const rest = $derived(items.slice(1));
</script>

<section class="desk" data-part="desk" aria-labelledby="desk-title">
  <div class="section-head"><h2 id="desk-title">이어 읽기</h2><span class="index">01 / DESK</span></div>
  {#if !first}
    <p class="status">아직 펼친 책이 없어요.</p>
  {:else}
    <a class="desk-main" href={hrefs.read(first.source, first.charId, first.chatId)}>
      <span class="cover"><CharImage src={first.imageUrl} name={first.charName} size={72} /><span class="cover-title">{first.title}</span></span>
      <span class="desk-info">
        <span class="desk-title">{first.title}</span>
        <span class="meta">{first.charName} · {first.chapter}장{first.deleted ? ' · 원본에서 지워짐' : ''}</span>
        <span class="progress-line" aria-hidden="true"><span class="fill" use:bar={first.progress}></span></span>
        <span class="index">{pct(first.progress)}</span>
        <span class="cta">이어서 읽기</span>
      </span>
    </a>
    {#each rest as r (r.source + r.charId + r.chatId)}
      <a class="desk-row" href={hrefs.read(r.source, r.charId, r.chatId)}>
        <span class="desk-row-title">{r.title} <span class="meta">· {r.charName}{r.deleted ? ' · 원본에서 지워짐' : ''}</span></span>
        <span class="index">{pct(r.progress)}</span>
      </a>
    {/each}
  {/if}
</section>
