<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import { focusOnMount } from '../appearance/focus';
  import CharImage from '../library/CharImage.svelte';
  import Shelf from '../library/Shelf.svelte';
  import { hrefs } from '../route';
  import { IMPORTED } from '../sources';
  import { loadShelfView, setShelfView, shelfView } from '../shelf-view.svelte';
  import type { CharInfo, ChatInfo, ShelfChat } from '../types';
  import RenameForm from './RenameForm.svelte';

  let { source, char }: { source: string; char: string } = $props();
  let me = $state<CharInfo | null>(null);
  let list = $state<ChatInfo[] | null>(null);
  let failed = $state(false);
  let editing = $state<string | null>(null); // '' = 캐릭터, 그 밖 = chatId

  async function load() {
    try {
      const [chars, chats] = await Promise.all([api.chars(source, { includeDeleted: true }), api.chats(source, char, { includeDeleted: true })]);
      me = chars.find((c) => c.charId === char) ?? null;
      list = chats;
    } catch {
      failed = true;
    }
  }
  onMount(() => { void load(); void loadShelfView(); });

  async function renameChar(name: string) {
    const r = await api.setAlias(source, char, undefined, name);
    if (me) me = { ...me, displayName: r.displayName };
    editing = null;
  }
  async function renameChat(id: string, name: string) {
    const r = await api.setAlias(source, char, id, name);
    list = (list ?? []).map((c) => (c.chatId === id ? { ...c, displayName: r.displayName } : c));
    editing = null;
  }

  // 가져온 채팅만: 완전히 지우기 (두 단계). 마지막 채팅이면 캐릭터도 사라지므로 홈으로 돌아간다.
  let confirming = $state<string | null>(null);
  let deleteError = $state('');
  async function removeChat(id: string) {
    confirming = null;
    deleteError = '';
    try {
      await api.deleteImportChat(char, id);
      const chars = await api.chars(source);
      if (!chars.some((c) => c.charId === char)) { location.hash = hrefs.home; return; }
      await load();
    } catch { deleteError = '지우지 못했어요.'; }
  }

  const asShelf = (c: ChatInfo): ShelfChat => ({
    chatId: c.chatId, displayName: c.displayName, msgCount: c.msgCount, lastError: c.lastError, lastDate: c.lastDate, progress: c.progress, readAt: c.readAt,
    deleted: c.deleted, keptAt: c.keptAt,
  });
  const live = $derived((list ?? []).filter((c) => !c.deleted));
  const gone = $derived((list ?? []).filter((c) => c.deleted));
  const shown = $derived(me?.deleted ? gone : live);
  const totalMsgs = $derived(shown.reduce((n, c) => n + (c.msgCount ?? 0), 0));
  const lastDate = $derived(Math.max(0, ...shown.map((c) => c.lastDate ?? 0)));
  const fmtDate = (t: number) => (t ? new Date(t).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '');
  const recentRead = $derived([...(list ?? [])].filter((c) => c.readAt).sort((a, b) => b.readAt! - a.readAt!).slice(0, 3));
</script>

{#snippet chatList(items: ChatInfo[], empty: string)}
  {#if shelfView.value === 'shelf'}
    <Shelf {source} {char} chats={items.map(asShelf)} wrap />
  {:else}
    <ul class="list">
      {#each items as c (c.chatId)}
        <li class="with-action">
          {#if c.msgCount}
            <a href={hrefs.read(source, char, c.chatId)}><strong>{c.displayName || '(제목 없음)'}</strong> <span class="meta">메시지 {c.msgCount}{c.progress !== null ? ` · ${Math.round(c.progress * 100)}%` : ''}{c.keptAt !== null ? ' · 보관' : ''}</span></a>
          {:else}
            <span class="empty"><strong>{c.displayName || '(제목 없음)'}</strong> <span class="meta">{c.lastError ? '읽을 수 없어요' : '비어 있어요'}</span></span>
          {/if}
          <button type="button" class="icon" aria-label={`${c.displayName || '제목 없음'} 이름 바꾸기`} onclick={() => (editing = c.chatId)}>✎</button>
        </li>
        {#if editing === c.chatId}
          <li><RenameForm current={c.displayName} original={c.originalName} onSave={(n) => renameChat(c.chatId, n)} onCancel={() => (editing = null)} /></li>
        {/if}
      {:else}
        <li class="status">{empty}</li>
      {/each}
    </ul>
  {/if}
{/snippet}

<main class="page" data-part="chat-list">
  <nav><a href={hrefs.chars(source)}>← 서고</a></nav>
  <div class="title-row">
    {#if me}<CharImage src={me.imageUrl} name={me.displayName} size={40} />{/if}
    <h1>{me ? me.displayName || '(이름 없음)' : '채팅'}</h1>
    {#if me}<button type="button" class="icon" aria-label="표시 이름 바꾸기" onclick={() => (editing = '')}>✎</button>{/if}
  </div>
  {#if me && me.displayName !== me.originalName}<p class="meta">원래 이름 · {me.originalName}</p>{/if}
  {#if me?.deleted}<p class="notice" role="status">원본에서 지워진 캐릭터예요. PAGE 사본은 그대로 읽을 수 있어요.</p>{/if}
  {#if list}<p class="index">채팅 {shown.length}권 · 메시지 {totalMsgs.toLocaleString('ko-KR')}{lastDate ? ` · 최근 ${fmtDate(lastDate)}` : ''}</p>{/if}
  {#if editing === '' && me}
    <RenameForm current={me.displayName} original={me.originalName} onSave={renameChar} onCancel={() => (editing = null)} />
  {/if}

  <div class="view-toggle" role="group" aria-label="보기 방식">
    <button type="button" aria-pressed={shelfView.value === 'shelf'} onclick={() => setShelfView('shelf')}>서가</button>
    <button type="button" aria-pressed={shelfView.value === 'list'} onclick={() => setShelfView('list')}>목록</button>
  </div>

  {#if failed}
    <p class="status" role="alert">불러오지 못했어요.</p>
  {:else if !list}
    <p class="status">불러오는 중…</p>
  {:else}
    {#if !me?.deleted || live.length}{@render chatList(live, '채팅이 없어요.')}{/if}
    {#if gone.length}
      <section aria-labelledby="gone-chats">
        <div class="section-head"><h2 id="gone-chats">원본에서 지워진 채팅 {gone.length}권</h2><span class="index">GONE</span></div>
        {@render chatList(gone, '')}
      </section>
    {/if}
  {/if}

  {#if source === IMPORTED && live.length}
    <section class="appearance-section" aria-labelledby="delete-chats" data-part="import-delete">
      <h2 id="delete-chats">채팅 지우기</h2>
      <p class="meta">지우면 채팅과 그 책갈피·형광펜이 서고에서도 완전히 사라져요. 마지막 채팅을 지우면 캐릭터도 함께 지워져요.</p>
      {#if deleteError}<p class="notice" role="alert">{deleteError}</p>{/if}
      <ul class="item-list">
        {#each live as c (c.chatId)}
          <li class="item">
            <div class="item-head"><span class="item-name">{c.displayName || '(제목 없음)'}</span></div>
            <div class="row-actions">
              {#if confirming === c.chatId}
                <button type="button" aria-label={`${c.displayName || '제목 없음'} 정말 지우기`} use:focusOnMount onclick={() => void removeChat(c.chatId)}>정말 지우기</button>
                <button type="button" onclick={() => (confirming = null)}>취소</button>
              {:else}
                <button type="button" aria-label={`${c.displayName || '제목 없음'} 지우기`} onclick={() => (confirming = c.chatId)}>지우기</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if recentRead.length}
    <section aria-labelledby="recent-books">
      <div class="section-head"><h2 id="recent-books">최근에 펼친 책</h2><span class="index">BY DATE</span></div>
      <ul class="list">
        {#each recentRead as c (c.chatId)}
          <li><a href={hrefs.read(source, char, c.chatId)}><span class="recent-title">{c.displayName || '(제목 없음)'}</span> <span class="meta">{c.progress !== null ? `${Math.round(c.progress * 100)}%` : ''}</span></a></li>
        {/each}
      </ul>
    </section>
  {/if}
</main>
