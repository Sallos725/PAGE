<script lang="ts">
  import { hrefs } from '../route';
  import { spineColor, spineHeight, spineState, spineWidth, type SpineRange } from '../spines';
  import type { ShelfChat } from '../types';

  let { source, char, chat, range, scale = 1, charName = '' }: { source: string; char: string; chat: ShelfChat; range: SpineRange | null; scale?: number; charName?: string } = $props();
  const state = $derived(spineState(chat));
  const label = $derived(
    `${charName ? `${charName} · ` : ''}${chat.displayName || '제목 없음'}${chat.msgCount ? ` · 메시지 ${chat.msgCount}` : ''}${state === 'reading' && chat.progress !== null ? ` · 읽는 중 ${Math.round(chat.progress * 100)}%` : ''}${state === 'empty' ? ' · 비어 있음' : ''}${chat.keptAt !== null ? ' · 보관' : ''}${chat.deleted ? ' · 원본에서 지워짐' : ''}`,
  );
  function sized(node: HTMLElement, s: { h: number; w: number }) {
    const apply = (v: { h: number; w: number }) => { node.style.height = `${v.h}px`; node.style.width = `${v.w}px`; node.style.lineHeight = `${v.w}px`; };
    apply(s);
    return { update: apply };
  }
  const dims = $derived({ h: spineHeight(chat.msgCount, range, scale), w: spineWidth(chat.displayName) });
</script>

{#if state === 'empty'}
  <span class="spine empty" data-part="spine" class:kept={chat.keptAt !== null} title={label} aria-label={label} use:sized={dims}>{#if charName}<span class="spine-char">{charName}</span>{/if}<span class="spine-title">{chat.displayName || '제목 없음'}</span></span>
{:else}
  <a class="spine" data-part="spine" class:reading={state === 'reading'} class:kept={chat.keptAt !== null} data-c={spineColor(chat.chatId)} href={hrefs.read(source, char, chat.chatId)} title={label} aria-label={label} use:sized={dims}>
    {#if charName}<span class="spine-char">{charName}</span>{/if}<span class="spine-title">{chat.displayName || '제목 없음'}</span>
  </a>
{/if}
