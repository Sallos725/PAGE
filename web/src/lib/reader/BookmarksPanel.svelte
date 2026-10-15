<script lang="ts">
  import { cmpPos } from '../highlights';
  import type { Bookmark, ReadingPosition } from '../types';
  import HighlightList from './HighlightList.svelte';

  type Props = {
    items: Bookmark[];
    canAdd: boolean;
    current: { source: string; char: string; chat: string };
    onAdd: () => void;
    onJump: (p: ReadingPosition) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
  };
  let { items, canAdd, current, onAdd, onJump, onDelete, onClose }: Props = $props();
  const sorted = $derived([...items].sort((a, b) => cmpPos(a.start, b.start)));
  let tab = $state<'chat' | 'library'>('chat');
</script>

<div class="panel" data-part="panel" role="dialog" aria-label="책갈피와 하이라이트">
  <div class="panel-head">
    <strong>책갈피</strong>
    <button type="button" onclick={onClose}>닫기</button>
  </div>
  <div class="tabs" role="tablist" aria-label="보기">
    <button type="button" role="tab" id="bm-tab-chat" aria-controls="bm-tabpanel" aria-selected={tab === 'chat'} onclick={() => (tab = 'chat')}>이 채팅</button>
    <button type="button" role="tab" id="bm-tab-library" aria-controls="bm-tabpanel" aria-selected={tab === 'library'} onclick={() => (tab = 'library')}>서고 전체 형광펜</button>
  </div>
  <div id="bm-tabpanel" role="tabpanel" aria-labelledby={tab === 'chat' ? 'bm-tab-chat' : 'bm-tab-library'}>
  {#if tab === 'chat'}
    <button type="button" class="wide" disabled={!canAdd} onclick={onAdd}>현재 위치 책갈피</button>
    <ul class="list bm-list">
      {#each sorted as b (b.id)}
        <li class="bm" data-kind={b.kind} data-color={b.kind === 'highlight' ? b.color || 'yellow' : undefined}>
          <button type="button" class="jump" onclick={() => onJump(b.start)}>
            {b.kind === 'bookmark' ? '책갈피' : '하이라이트'} · 메시지 {b.start.msgIdx + 1}
            {#if b.text}<span class="bm-text">{b.text}</span>{/if}
          </button>
          <button type="button" class="del" aria-label="삭제" onclick={() => onDelete(b.id)}>삭제</button>
        </li>
      {:else}
        <li class="status">아직 없어요.</li>
      {/each}
    </ul>
  {:else}
    <HighlightList {current} {onJump} />
  {/if}
  </div>
</div>
