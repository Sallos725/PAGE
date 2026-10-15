<script lang="ts">
  import type { KeptItem } from '../library-view';
  import Spine from './Spine.svelte';
  // 여러 캐릭터가 섞인 선반 (보관함). 책등 높이 범위는 항목마다 그 캐릭터 기준으로 받는다.
  let { source, items, scale = 1 }: { source: string; items: KeptItem[]; scale?: number } = $props();
</script>

<div class="shelf" data-part="shelf" class:compact={scale < 1}>
  {#each items as it (`${it.char}\u0000${it.chat.chatId}`)}
    <div class="slot"><Spine {source} char={it.char} chat={it.chat} range={it.range} {scale} charName={it.charName} /></div>
  {/each}
</div>
