<script lang="ts">
  import { spineRange } from '../spines';
  import type { ShelfChat } from '../types';
  import Spine from './Spine.svelte';
  // 선반: 줄바꿈되는 책등 + 줄마다 판자 (판자는 배경의 반복 줄 — CSS).
  // 책등 높이는 이 선반에 받은 chats 안에서의 상대 길이다 (서가 = 살아 있는 채팅, 지워진 채팅 칸 = 지워진 채팅끼리).
  let { source, char, chats, scale = 1, wrap = false }: { source: string; char: string; chats: ShelfChat[]; scale?: number; wrap?: boolean } = $props();
  const range = $derived(spineRange(chats));
</script>

<div class="shelf" data-part="shelf" class:wrap class:compact={scale < 1}>
  {#each chats as c (c.chatId)}
    <div class="slot"><Spine {source} {char} chat={c} {range} {scale} /></div>
  {:else}
    <p class="status">채팅이 없어요.</p>
  {/each}
</div>
