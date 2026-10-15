<script lang="ts">
  import { api } from '../api';
  import { hrefs } from '../route';
  import { groupHighlights } from '../snippets';
  import type { LibraryHighlight, ReadingPosition } from '../types';

  // current 가 있으면(리더 안) 같은 채팅 항목은 onJump 로 그 자리로, 다른 채팅은 그 채팅의 읽기 위치를 저장하고 연다 (스펙 H5).
  let { current = null, onJump }: { current?: { source: string; char: string; chat: string } | null; onJump?: (p: ReadingPosition) => void } = $props();

  const load = api.libraryHighlights();
  let busy = $state(false); // 누르는 동안 연타 방지

  async function open(h: LibraryHighlight) {
    if (busy) return;
    busy = true;
    try {
      if (current && onJump && h.source === current.source && h.charId === current.char && h.chatId === current.chat) { onJump(h.start); return; }
      try { await api.putPosition(h.source, h.charId, h.chatId, h.start); } catch { /* 위치 저장이 안 돼도 채팅은 연다 */ }
      location.hash = hrefs.read(h.source, h.charId, h.chatId);
    } finally {
      busy = false;
    }
  }
</script>

{#await load}
  <p class="status">불러오는 중…</p>
{:then r}
  {#each groupHighlights(r.highlights) as g (g.key)}
    <section class="hl-group" aria-label={g.charName || '이름 없는 캐릭터'}>
      <h3 class="hl-char">{g.charName || '(이름 없음)'}</h3>
      {#each g.chats as c (c.chatId)}
        <h4 class="hl-chat">{c.chatTitle || '제목 없음'}{#if c.deleted} <span class="meta">· 원본에서 지워짐</span>{/if}</h4>
        <ul class="list hl-list">
          {#each c.items as h (h.id)}
            <li class="hl-item" data-color={h.color}>
              <button type="button" class="hl-open" disabled={busy} onclick={() => void open(h)}>
                <span class="hl-dot" aria-hidden="true"></span>
                {#if h.text}<span class="hl-text">{h.text}</span>{:else}<span class="hl-text meta">채팅을 한 번 열면 문장이 보여요 · 메시지 {h.start.msgIdx + 1}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
    </section>
  {:else}
    <p class="status">아직 칠한 문장이 없어요.</p>
  {/each}
  {#if r.hasMore}<p class="meta">최근 {r.highlights.length}개까지 보여요.</p>{/if}
{:catch}
  <p class="notice" role="alert">불러오지 못했어요.</p>
{/await}
