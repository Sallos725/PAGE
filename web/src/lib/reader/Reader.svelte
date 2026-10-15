<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import { blockText } from '../blocks';
  import { ChapterLoader, WINDOW, snapToVisible, windowOf, type Chapter, type ChapterView } from '../chapters';
  import { applyHideRules, compileRules } from '../hide-rules';
  import { applyImageRules } from '../image-rules';
  import { rangeToPositions, type Highlight } from '../highlights';
  import { anchorOf, relocate, resolvePosition } from '../position';
  import { hrefs } from '../route';
  import { layoutSignature, type ReaderMode } from '../settings-core';
  import { settings, settingsReady, update } from '../settings.svelte';
  import { HIGHLIGHT_SNIPPET, cap, snippetFor, textAt, textBetween, tidy } from '../snippets';
  import type { Bookmark, ChatInfo, HideRule, ImageRule, ReadingPosition } from '../types';
  import BookView from './BookView.svelte';
  import BookmarksPanel from './BookmarksPanel.svelte';
  import HideRulesPanel from './HideRulesPanel.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import Icon from './Icon.svelte';
  import ScrollView from './ScrollView.svelte';
  import SettingsPanel from './SettingsPanel.svelte';

  let { source, char, chat }: { source: string; char: string; chat: string } = $props();

  type Ready = { loader: ChapterLoader; first: Chapter; startAt: ReadingPosition | null };
  type Pt = { msgIdx: number; blockIdx: number; charOffset: number };
  let ready = $state<Ready | null>(null);
  let failed = $state(false);
  let empty = $state(false);
  let showRaw = $state(false);
  let changedNotice = $state(false);
  let current = $state(0);
  let total = $state(0);
  let mode = $state<ReaderMode>('scroll');
  let viewKey = $state(0); // 모드·레이아웃 설정을 바꾸면 뷰를 새로 만든다 (같은 위치에서 시작)
  let uiVisible = $state(true); // 책 모드의 헤더·진행률 오버레이 (중앙 탭으로 토글)
  let page = $state({ view: 0, views: 1 });
  let panel = $state<'settings' | 'bookmarks' | 'rules' | 'export' | null>(null);
  let items = $state<Bookmark[]>([]);
  let chatTitle = $state('');
  let charName = $state('');
  let keptAt = $state<number | null>(null);
  let deletedChat = $state(false);
  let rules = $state<HideRule[]>([]);
  let imageRules = $state<ImageRule[]>([]);
  let selection = $state<{ start: Pt; end: Pt } | null>(null);

  let here: ReadingPosition | null = null; // 마지막으로 보고된 위치 (어느 모드든)
  let latest: ReadingPosition | null = null; // 저장할 위치
  let lastSent: string | null = null;
  let baseline: ReadingPosition | null = null; // 복원 직후 같은 자리 보고는 저장하지 않는다
  let timer: ReturnType<typeof setTimeout> | null = null;

  const highlights = $derived<Highlight[]>(
    items.filter((b) => b.kind === 'highlight' && b.end).map((b) => ({ id: b.id, start: b.start, end: b.end!, color: b.color || 'yellow' })),
  );

  /** 지금 규칙·설정으로 만든 챕터 보기 옵션 (원문 보기는 ParsedMessage.text 를 그대로 쓰므로 여기와 무관). */
  function viewOpts(): ChapterView {
    const res = compileRules(rules);
    const imgs = imageRules.filter((r) => r.enabled && !r.slow);
    const transform = res.length || imgs.length ? (t: string) => applyImageRules(applyHideRules(t, res), imgs) : undefined;
    return { transform, hideUser: settings.hideUser };
  }

  /** 다시 그릴 챕터 안에서 위치를 맞춘다: 숨긴 메시지면 옮기고, 텍스트가 밀렸으면 앵커로 다시 찾는다. */
  function fitPosition(pos: ReadingPosition | null, c: Chapter): ReadingPosition | null {
    if (!pos) return null;
    const p = settings.hideUser ? snapToVisible(pos, c.messages) : pos;
    const m = c.messages.find((x) => x.idx === p.msgIdx);
    if (!m) return p;
    const texts = m.blocks.map(blockText);
    return relocate(p, texts) ?? { msgIdx: p.msgIdx, blockIdx: 0, charOffset: 0, anchorHash: anchorOf(texts[0] ?? '', 0) };
  }

  function persist(keepalive = false) {
    if (!latest) return;
    const body = JSON.stringify(latest);
    if (body === lastSent) return;
    lastSent = body;
    void api.putPosition(source, char, chat, latest, { keepalive }).catch(() => { lastSent = null; });
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    persist(true);
  }
  function onPosition(pos: ReadingPosition) {
    if (frozen) return; // 설정 변경으로 화면이 흔들리는 동안의 위치는 믿지 않는다
    here = pos;
    current = pos.msgIdx;
    if (baseline && pos.msgIdx === baseline.msgIdx && pos.blockIdx === baseline.blockIdx) return;
    baseline = null;
    latest = pos;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => persist(), 1500); // 디바운스: 스크롤/쪽 넘김 중엔 저장하지 않는다
  }

  async function init() {
    try {
      await Promise.race([settingsReady, new Promise((r) => setTimeout(r, 1500))]);
      mode = settings.mode;
      await api.syncChat(source, char, chat).catch(() => undefined); // 최신성. 실패해도 라이브러리 사본으로 읽는다
      const [saved, marks, ruleList, chatList, charList, imgRules] = await Promise.all([
        api.getPosition(source, char, chat),
        api.listBookmarks(source, char, chat).catch(() => [] as Bookmark[]),
        api.hideRules(source, char).catch(() => [] as HideRule[]),
        api.chats(source, char, { includeDeleted: true }).catch(() => [] as ChatInfo[]),
        api.chars(source, { includeDeleted: true }).catch(() => [] as { charId: string; displayName: string }[]),
        api.imageRules(source, char).catch(() => [] as ImageRule[]),
      ]);
      const me = chatList.find((c) => c.chatId === chat);
      chatTitle = me?.displayName ?? '';
      keptAt = me?.keptAt ?? null;
      deletedChat = me?.deleted ?? false;
      charName = charList.find((c) => c.charId === char)?.displayName ?? '';
      items = marks;
      rules = ruleList;
      imageRules = imgRules;
      const loader = new ChapterLoader((from, limit, version) => api.messages(source, char, chat, { from, limit, version }));
      loader.setView(viewOpts());
      const first = await loader.chapterAt(saved?.position.msgIdx ?? 0);
      total = Math.max(0, loader.total);
      if (!first) { empty = true; return; }
      let startAt: ReadingPosition | null = null;
      if (saved) {
        const msg = first.messages.find((m) => m.idx === saved.position.msgIdx);
        const inRange = saved.position.msgIdx >= first.range.from && saved.position.msgIdx < first.range.to;
        let pos: ReadingPosition;
        let notice = false;
        if (!msg && settings.hideUser && inRange) {
          pos = snapToVisible(saved.position, first.messages); // 숨긴 내 메시지에 있던 위치: 바뀐 게 아니다
        } else {
          const r = resolvePosition(saved.position, msg ? msg.blocks.map(blockText) : null, loader.total);
          pos = r.pos;
          notice = !r.exact && !r.relocated;
        }
        startAt = pos;
        baseline = pos;
        here = pos;
        current = pos.msgIdx;
        changedNotice = notice;
      }
      ready = { loader, first, startAt };
      void backfillTexts();
    } catch {
      failed = true;
    }
  }

  let alive = true;

  /** from~to 메시지를 덮는 장들의 메시지를 차례로 모은다 (가운데 장도 빠지지 않게). 너무 길면 20장까지만. */
  async function messagesSpan(loader: ChapterLoader, from: number, to: number) {
    const out: Chapter['messages'] = [];
    let i = from;
    for (let n = 0; n < 20 && i <= to; n++) {
      const c = await loader.chapterAt(i);
      if (!c) break;
      out.push(...c.messages);
      if (c.range.to <= i) break;
      i = c.range.to;
    }
    return out;
  }

  /** 문장이 없는 옛 책갈피·형광펜을 화면 글자로 채운다 (형광펜 스펙 H2). 한 번에 최대 100개, 차례로. */
  async function backfillTexts() {
    const todo = items.filter((b) => !b.text).slice(0, 100);
    if (todo.length === 0) return;
    // 리더의 로더와 캐시를 공유하지 않는다 (먼 창을 받으며 읽는 창 캐시를 밀어내지 않게). 보기 옵션은 시작 시점 것으로 고정.
    const loader = new ChapterLoader((from, limit, version) => api.messages(source, char, chat, { from, limit, version }));
    loader.setView(viewOpts());
    for (const b of todo) {
      if (!alive) return;
      try {
        const msgs = await messagesSpan(loader, b.start.msgIdx, b.end?.msgIdx ?? b.start.msgIdx);
        const text = snippetFor(b, msgs);
        if (!text || !alive) continue;
        await api.setBookmarkText(source, char, chat, b.id, text);
        items = items.map((x) => (x.id === b.id ? { ...x, text } : x));
      } catch {
        /* 다음에 열 때 다시 */
      }
    }
  }

  /** 같은 ReadingPosition 에서 뷰를 다시 만든다 (모드 전환·레이아웃 설정 변경·책갈피 이동). 스펙 4.1. */
  async function remountAt(pos: ReadingPosition | null) {
    if (!ready) return;
    ready.loader.setView(viewOpts());
    const first = await ready.loader.chapterAt(pos?.msgIdx ?? 0);
    if (!first) return;
    ready = { loader: ready.loader, first, startAt: fitPosition(pos, first) };
    viewKey++;
  }

  async function switchMode() {
    if (!ready) return;
    (document.activeElement as HTMLElement | null)?.blur?.(); // 포커스가 버튼에 남으면 Space 가 모드를 다시 바꾼다
    const next: ReaderMode = mode === 'scroll' ? 'book' : 'scroll';
    await remountAt(here ?? ready.startAt);
    mode = next;
    uiVisible = true;
    update({ mode: next });
  }

  /** 레이아웃 설정이 바뀌면 0.3초 뒤 현재 위치에서 다시 그린다 (연속 조작은 한 번으로 모은다). */
  // CSS 는 즉시 바뀌어 화면이 흔들린다. 바뀌는 순간의 위치를 고정하고, 다시 그릴 때까지 위치 보고를 무시한다.
  // (effect 는 마이크로태스크라 다음 프레임의 스크롤/교차 보고보다 먼저 돈다)
  // svelte-ignore state_referenced_locally
  let lastSig = layoutSignature(settings);
  let sigTimer: ReturnType<typeof setTimeout> | null = null;
  let frozen = false;
  let pinned: ReadingPosition | null = null;
  $effect(() => {
    const sig = layoutSignature(settings);
    if (sig === lastSig) return;
    lastSig = sig;
    if (!ready) return; // 리더가 아직 안 열렸으면 처음부터 새 설정으로 그린다
    if (!frozen) {
      frozen = true;
      pinned = here ?? ready.startAt;
    }
    if (sigTimer) clearTimeout(sigTimer);
    sigTimer = setTimeout(async () => {
      await remountAt(pinned);
      frozen = false;
    }, 300);
  });

  async function onImageRulesChange(next: ImageRule[]) {
    imageRules = next;
    if (!ready) return;
    const p = here ?? ready.startAt;
    frozen = true;
    try {
      await remountAt(p);
    } finally {
      frozen = false;
    }
  }

  async function onRulesChange(next: HideRule[]) {
    rules = next;
    if (!ready) return;
    const p = here ?? ready.startAt;
    frozen = true;
    try {
      await remountAt(p);
    } finally {
      frozen = false;
    }
  }

  async function goTo(pos: ReadingPosition) {
    if (settings.hideUser && ready) {
      const c = await ready.loader.chapterAt(pos.msgIdx);
      const hidden = !!c && pos.msgIdx >= c.range.from && pos.msgIdx < c.range.to && !c.messages.some((m) => m.idx === pos.msgIdx);
      if (hidden) {
        if (!confirm('이 책갈피는 내 메시지에 있어요. 내 메시지 숨기기를 끌까요?')) return;
        here = pos; // 설정 변경이 이 위치에서 다시 그리도록 (layoutSignature effect 가 here 를 고정한다)
        current = pos.msgIdx;
        baseline = null;
        latest = pos;
        panel = null;
        update({ hideUser: false });
        return;
      }
    }
    here = pos;
    current = pos.msgIdx;
    baseline = null;
    latest = pos; // 책갈피로 이동한 곳이 새 읽기 위치다
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => persist(), 300);
    panel = null;
    await remountAt(pos);
  }

  function withAnchor(p: Pt): ReadingPosition {
    const el = document.querySelector(`.block[data-msg="${p.msgIdx}"][data-block="${p.blockIdx}"]`);
    return { ...p, anchorHash: anchorOf(el?.textContent ?? '', p.charOffset) };
  }

  async function addBookmark() {
    const pos = here ?? ready?.startAt ?? null;
    if (!pos) return;
    // 문장은 backfill 과 같은 기준(화면 블록 글자)으로. 못 만들면 빈 채로 두고 다음에 열 때 채운다.
    let text = '';
    try {
      if (ready) text = textAt(pos, await messagesSpan(ready.loader, pos.msgIdx, pos.msgIdx)) ?? '';
    } catch {
      /* 빈 채로 */
    }
    try {
      items = [...items, await api.addBookmark(source, char, chat, { kind: 'bookmark', start: pos, text })];
    } catch {
      /* 실패 시 목록이 그대로다 */
    }
  }

  async function addHighlight() {
    const r = selection;
    if (!r) return;
    const picked = document.getSelection()?.toString() ?? ''; // 블록 글자를 못 만들 때만 쓰는 보조
    selection = null;
    document.getSelection()?.removeAllRanges();
    // 선택 글자에는 화자 이름·장 머리 같은 화면 장식이 섞이므로, backfill 과 같은 기준(화면 블록 글자)으로 만든다.
    let text = cap(tidy(picked), HIGHLIGHT_SNIPPET);
    try {
      if (ready) text = textBetween(r.start, r.end, await messagesSpan(ready.loader, r.start.msgIdx, r.end.msgIdx)) ?? text;
    } catch {
      /* 보조 글자를 쓴다 */
    }
    try {
      items = [...items, await api.addBookmark(source, char, chat, { kind: 'highlight', start: withAnchor(r.start), end: withAnchor(r.end), color: 'yellow', text })];
    } catch {
      /* 위와 같음 */
    }
  }

  async function removeItem(id: string) {
    try {
      await api.deleteBookmark(source, char, chat, id);
      items = items.filter((b) => b.id !== id);
    } catch {
      /* 위와 같음 */
    }
  }

  let clearSelTimer: ReturnType<typeof setTimeout> | null = null;
  function onSelectionChange() {
    const sel = document.getSelection();
    const r = sel && sel.rangeCount > 0 && !sel.isCollapsed ? rangeToPositions(sel.getRangeAt(0)) : null;
    if (r) {
      if (clearSelTimer) { clearTimeout(clearSelTimer); clearSelTimer = null; }
      selection = r;
      return;
    }
    if (clearSelTimer) clearTimeout(clearSelTimer);
    // 버튼을 누르는 순간 선택이 풀리는 기기(iOS) 대비: 잠깐 버튼을 유지한다
    clearSelTimer = setTimeout(() => { selection = null; clearSelTimer = null; }, 400);
  }

  onMount(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('pagehide', flush);
    void init();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('pagehide', flush);
      if (sigTimer) clearTimeout(sigTimer);
      flush();
    };
  });

  const pct = $derived(total > 0 ? Math.round(((current + 1) / total) * 100) : 0);
  const chapterNo = $derived(windowOf(current) + 1);
  const chapterTotal = $derived(Math.max(1, Math.ceil(total / WINDOW)));
  function fill(node: HTMLElement, p: number) {
    const apply = (v: number) => { node.style.width = `${v}%`; };
    apply(p);
    return { update: apply };
  }
  const book = $derived(mode === 'book');
  const showUi = $derived(!book || uiVisible);
  const toggle = (p: 'settings' | 'bookmarks') => (panel = panel === p ? null : p);
  async function toggleKept() {
    try {
      keptAt = (await api.setKept(source, char, chat, keptAt === null)).keptAt;
    } catch {
      /* 바꾸지 못하면 표시를 그대로 둔다 */
    }
  }
</script>

<header class="reader-bar" data-part="reader-bar" class:overlay={book} class:ui-hidden={!showUi} inert={!showUi}>
  <a class="tool back" href={hrefs.chats(source, char)} aria-label="서가로 돌아가기"><Icon name="back" /></a>
  <div class="reader-title">
    <span class="reader-title-main">{chatTitle}</span>
    <span class="index">{chapterNo}장 / {chapterTotal}</span>
  </div>
  <button type="button" class="tool mode" aria-label={book ? '스크롤로 보기' : '책으로 보기'} onclick={() => void switchMode()} disabled={!ready}><Icon name={book ? 'scroll' : 'book'} /></button>
  <button type="button" class="tool" aria-label="보관" disabled={!ready} aria-pressed={keptAt !== null} onclick={() => void toggleKept()}><Icon name="keep" /></button>
  <button type="button" class="tool" aria-label="책갈피" aria-expanded={panel === 'bookmarks'} onclick={() => toggle('bookmarks')}><Icon name="bookmark" /></button>
  <button type="button" class="tool" aria-label="보기 설정" aria-expanded={panel === 'settings'} onclick={() => toggle('settings')}>Aa</button>
  <label><input type="checkbox" bind:checked={showRaw} /> 원문</label>
</header>

{#if panel === 'settings' && showUi}
  <SettingsPanel onClose={() => (panel = null)} onRules={() => (panel = 'rules')} onExport={() => (panel = 'export')} canExport={!!ready} />
{:else if panel === 'bookmarks' && showUi}
  <BookmarksPanel {items} canAdd={!!ready} current={{ source, char, chat }} onAdd={() => void addBookmark()} onJump={(p) => void goTo(p)} onDelete={(id) => void removeItem(id)} onClose={() => (panel = null)} />
{:else if panel === 'rules' && showUi}
  <HideRulesPanel {source} {char} {rules} sample={() => ready?.loader.loadedTexts() ?? []} onChange={(r) => void onRulesChange(r)} {imageRules} onImageChange={(r) => void onImageRulesChange(r)} onClose={() => (panel = null)} />
{:else if panel === 'export' && showUi}
  <ExportPanel {source} {char} {chat} hideRules={rules} {imageRules} hideUser={settings.hideUser} version={ready?.loader.pinnedVersion} onClose={() => (panel = null)} />
{/if}

{#if selection}
  <!-- 누르는 순간 선택이 풀리지 않게 pointerdown 기본 동작을 막는다 -->
  <button type="button" class="hl-action" onpointerdown={(e) => e.preventDefault()} onmousedown={(e) => e.preventDefault()} onclick={() => void addHighlight()}>하이라이트</button>
{/if}

{#if failed}
  <main class="page"><p class="status" role="alert">불러오지 못했어요.</p></main>
{:else if empty}
  <main class="page"><p class="status">메시지가 없어요.</p></main>
{:else if !ready}
  <main class="page"><p class="status">불러오는 중…</p></main>
{:else}
  {#if changedNotice && showUi}
    <div class="notice reader-notice" role="status">
      내용이 바뀌었을 수 있어요
      <button type="button" onclick={() => (changedNotice = false)}>닫기</button>
    </div>
  {/if}
  {#if deletedChat && showUi}
    <p class="notice reader-gone-notice" role="status">원본에서 지워진 채팅이에요. PAGE 사본으로 읽고 있어요.</p>
  {/if}
  {#key viewKey}
    {#if book}
      <BookView
        loader={ready.loader}
        first={ready.first}
        startAt={ready.startAt}
        {source}
        {char}
        {showRaw}
        bubble={settings.bubble}
        {highlights}
        {charName}
        {onPosition}
        onPage={(p) => (page = p)}
        onToggleUi={() => (uiVisible = !uiVisible)}
      />
    {:else}
      <ScrollView loader={ready.loader} first={ready.first} startAt={ready.startAt} {source} {char} {showRaw} bubble={settings.bubble} {highlights} {charName} {onPosition} />
    {/if}
  {/key}
  <footer class="progress" class:ui-hidden={!showUi} aria-live="off">
    <span class="progress-bar" aria-hidden="true"><span class="fill" use:fill={pct}></span></span>
    <span class="progress-text">{pct}% · {current + 1} / {total}{#if book} · 쪽 {page.view + 1}/{page.views}{/if}</span>
  </footer>
{/if}
