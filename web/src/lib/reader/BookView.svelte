<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api } from '../api';
  import { blockText } from '../blocks';
  import {
    GAP, MARGIN_X, bookLayout, charOffsetAt, fragmentIndexFor, keyAction, pickBlockOnView, swipeAction, tapZone, viewCount, viewOfX,
    type BookLayout,
  } from '../book-math';
  import type { Chapter, ChapterLoader } from '../chapters';
  import { marksForBlock, relocateHighlights, type Highlight } from '../highlights';
  import { anchorOf } from '../position';
  import type { ReadingPosition } from '../types';
  import BlockView from './BlockView.svelte';

  type Props = {
    loader: ChapterLoader;
    first: Chapter;
    startAt: ReadingPosition | null;
    source: string;
    char: string;
    showRaw: boolean;
    bubble: boolean;
    highlights: Highlight[];
    charName: string;
    spread: boolean; // 넓은 화면에서 두 쪽 펼침 (끄면 한 쪽씩)
    animate: boolean; // 쪽 넘김을 부드럽게 스크롤
    onPosition: (p: ReadingPosition) => void;
    onPage: (info: { view: number; views: number }) => void;
    onToggleUi: () => void;
  };
  let { loader, first, startAt, source, char, showRaw, bubble, highlights, charName, spread, animate, onPosition, onPage, onToggleUi }: Props = $props();
  const two = (n: number) => String(n).padStart(2, '0');
  const timeOf = (t?: number) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

  // svelte-ignore state_referenced_locally
  let chapter = $state<Chapter>(first);
  const shown = $derived(relocateHighlights(highlights, chapter.messages));
  let scroller: HTMLElement;
  let strip: HTMLElement;
  let snaps: HTMLElement;
  let layout: BookLayout | null = null;
  let view = $state(0);
  let views = $state(1);
  let perView = $state(1);
  // svelte-ignore state_referenced_locally
  let curMsg = $state(startAt?.msgIdx ?? first.range.from);

  // 화면이 가리키는 현재 위치. 복원 직후엔 복원한 위치 그대로이고, 사용자가 쪽을 넘긴 뒤에야 새로 계산해 보고한다
  // (모드/크기를 바꿔 왕복해도 위치가 "쪽의 첫 블록"으로 끌려가지 않게 — 계획 결정 4).
  // svelte-ignore state_referenced_locally
  let anchor: ReadingPosition | null = startAt;
  let moved = false;
  let busy = false;
  let turning = false; // 쪽 넘김 스크롤이 끝나기 전(settle 전). 이 사이 anchor 는 아직 이전 쪽이다
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let relayoutTimer: ReturnType<typeof setTimeout> | null = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function textOf(msgIdx: number, blockIdx: number): string {
    const m = chapter.messages.find((x) => x.idx === msgIdx);
    const b = m?.blocks[blockIdx];
    return b ? blockText(b) : '';
  }

  /** 헤더(오버레이, 안전영역 포함)와 진행 표시의 높이만큼 쪽 위아래를 비운다. 숨겨져도(투명) 자리는 같아서 탭으로 쪽 나눔이 바뀌지 않는다. */
  function insets() {
    const bar = document.querySelector<HTMLElement>('.reader-bar');
    const prog = document.querySelector<HTMLElement>('.progress');
    return { top: (bar?.offsetHeight ?? 0) + 16, bottom: (prog?.offsetHeight ?? 0) + 8 };
  }

  /** 레이아웃 값은 전부 CSSOM 으로 쓴다 — 인라인 style 속성은 CSP(style-src-attr) 위반이다. */
  function applyLayout() {
    const l = bookLayout(scroller.clientWidth, scroller.clientHeight, insets(), spread);
    layout = l;
    perView = l.perView;
    const s = strip.style;
    s.left = `${MARGIN_X}px`;
    s.top = `${l.top}px`;
    s.width = `${l.viewWidth}px`;
    s.height = `${l.pageHeight}px`;
    s.columnWidth = `${l.colWidth}px`;
    s.columnGap = `${GAP}px`;
    s.setProperty('--page-h', `${l.pageHeight}px`);
    views = viewCount(strip.scrollWidth, l);
    snaps.replaceChildren(); // snaps 의 자식은 Svelte 가 관리하지 않는다
    for (let i = 0; i < views; i++) {
      const m = document.createElement('i');
      m.className = 'snap';
      m.style.left = `${MARGIN_X + i * l.stride}px`;
      snaps.appendChild(m);
    }
    // 마지막 view 의 시작까지 스크롤할 수 있도록 스크롤 폭을 보장하는 꼬리표
    const tail = document.createElement('i');
    tail.className = 'tail';
    tail.style.left = `${(views - 1) * l.stride + l.viewWidth + 2 * MARGIN_X - 1}px`;
    snaps.appendChild(tail);
  }

  function goView(i: number, smooth: boolean) {
    if (!layout) return;
    const target = Math.max(0, Math.min(views - 1, i));
    view = target;
    scroller.scrollTo({ left: target * layout.stride, behavior: smooth && animate && !reduced.matches ? 'smooth' : 'auto' });
  }

  function viewOfPosition(pos: ReadingPosition): number | null {
    if (!layout) return null;
    const el =
      strip.querySelector<HTMLElement>(`.block[data-msg="${pos.msgIdx}"][data-block="${pos.blockIdx}"]`) ??
      strip.querySelector<HTMLElement>(`.block[data-msg="${pos.msgIdx}"]`);
    if (!el) return null;
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return null;
    const text = textOf(pos.msgIdx, pos.blockIdx);
    const frac = text.length ? Math.min(1, pos.charOffset / text.length) : 0;
    const frag = rects[fragmentIndexFor(rects, frac)]!;
    const x = frag.left - strip.getBoundingClientRect().left; // 스크롤과 무관한 strip 기준 오프셋
    return Math.min(views - 1, viewOfX(x, layout));
  }

  /** at: 넘기는 중(스크롤이 아직 그 쪽에 닿기 전)이면 목표 view. 화면과 목표 사이 거리만큼 옮겨서 읽는다. */
  function reportPosition(at?: number) {
    if (!layout) return;
    const sr = scroller.getBoundingClientRect();
    const left = sr.left + MARGIN_X + (at === undefined ? 0 : at * layout.stride - scroller.scrollLeft);
    const items = [...strip.querySelectorAll<HTMLElement>('.block')].map((el) => ({
      msg: Number(el.dataset.msg),
      block: Number(el.dataset.block),
      rects: [...el.getClientRects()].map((r) => ({ left: r.left, top: r.top, height: r.height })),
    }));
    const hit = pickBlockOnView(items, left, left + layout.viewWidth);
    if (!hit) return;
    const text = textOf(hit.msg, hit.block);
    const charOffset = charOffsetAt(text.length, hit.fraction);
    const pos = { msgIdx: hit.msg, blockIdx: hit.block, charOffset, anchorHash: anchorOf(text, charOffset) };
    anchor = pos;
    curMsg = pos.msgIdx;
    onPosition(pos);
  }

  /** 스크롤이 멈춘 뒤(스와이프·키·탭 모두) 현재 view 를 확정하고 위치를 보고한다. */
  function settle() {
    if (!layout) return;
    turning = false;
    const v = Math.max(0, Math.min(views - 1, Math.round(scroller.scrollLeft / layout.stride)));
    if (v !== view) {
      view = v;
      moved = true; // 네이티브 스와이프
    }
    onPage({ view, views });
    if (moved) reportPosition();
  }
  function onScroll() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 120);
  }

  function prefetch() {
    void loader.next(chapter).catch(() => undefined);
    void loader.prev(chapter).catch(() => undefined);
  }

  async function step(dir: 1 | -1) {
    if (busy || !layout) return;
    moved = true;
    const target = view + dir;
    if (target >= 0 && target < views) {
      turning = true;
      goView(target, true);
      return;
    }
    busy = true;
    try {
      const other = dir === 1 ? await loader.next(chapter) : await loader.prev(chapter);
      if (!other) return; // 채팅의 처음/끝
      chapter = other;
      await tick();
      applyLayout();
      goView(dir === 1 ? 0 : views - 1, false);
      settle(); // 같은 scrollLeft 면 scroll 이벤트가 없으므로 직접 확정한다
      prefetch();
    } catch {
      /* 네트워크 오류: 다시 누르면 재시도 */
    } finally {
      busy = false;
    }
  }

  function onClick(e: MouseEvent) {
    if (window.getSelection()?.toString()) return; // 텍스트를 고르는 중이면 쪽을 넘기지 않는다
    const r = scroller.getBoundingClientRect();
    const zone = tapZone(e.clientX - r.left, r.width);
    if (zone === 'next') void step(1);
    else if (zone === 'prev') void step(-1);
    else onToggleUi();
  }

  let touch0: { x: number; y: number } | null = null;
  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    touch0 = t ? { x: t.clientX, y: t.clientY } : null;
  }
  /** 쪽 사이 스와이프는 네이티브 scroll-snap 이 처리한다. 챕터 경계(첫/마지막 쪽)에서만 제스처로 챕터를 넘긴다. */
  function onTouchEnd(e: TouchEvent) {
    const t = e.changedTouches[0];
    const t0 = touch0;
    touch0 = null;
    if (!t || !t0) return;
    const a = swipeAction(t.clientX - t0.x, t.clientY - t0.y);
    if (a === 'next' && view === views - 1) void step(1);
    else if (a === 'prev' && view === 0) void step(-1);
  }

  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName ?? '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (/^(BUTTON|A)$/.test(tag) && e.key === ' ') return; // 포커스된 버튼의 Space 는 버튼이 쓴다
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const a = keyAction(e.key, e.shiftKey);
    if (!a) return;
    e.preventDefault();
    void step(a === 'next' ? 1 : -1);
  }

  /** 크기·폰트·이미지 로드로 쪽이 바뀌면, 현재 위치를 유지한 채 다시 나눈다 (스펙 4.1). */
  function scheduleRelayout() {
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      if (!scroller || !strip) return;
      if (turning) {
        // 쪽을 넘기는 중이면 anchor 는 아직 이전 쪽이다 → 넘기던 쪽을 위치로 삼는다 (이전 쪽으로 튀지 않게)
        turning = false;
        reportPosition(view);
      }
      applyLayout();
      const v = anchor ? viewOfPosition(anchor) : null;
      goView(v ?? Math.min(view, views - 1), false);
      onPage({ view, views });
    }, 150);
  }
  $effect(() => {
    void showRaw; // 원문 표시를 바꾸면 내용 길이가 달라진다
    scheduleRelayout();
  });

  onMount(() => {
    window.scrollTo(0, 0); // 스크롤 모드에서 넘어왔을 수 있다 (book 은 fixed 라 문서 스크롤이 필요 없다)
    const ro = new ResizeObserver(scheduleRelayout);
    ro.observe(scroller);
    scroller.addEventListener('load', scheduleRelayout, true); // 이미지 로드 → 열 수 변동
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    void (async () => {
      await tick();
      applyLayout();
      moved = false;
      const v = startAt ? viewOfPosition(startAt) : null;
      goView(v ?? 0, false);
      onPage({ view, views });
      // 키보드 사용자는 바로 넘길 수 있어야 한다. 포커스가 모드 버튼에 남으면 Space 가 버튼을 다시 눌러 모드가 되돌아간다.
      scroller.focus({ preventScroll: true });
      void document.fonts?.ready.then(scheduleRelayout);
      prefetch();
    })();
    return () => {
      ro.disconnect();
      scroller.removeEventListener('load', scheduleRelayout, true);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
      if (settleTimer) clearTimeout(settleTimer);
      if (relayoutTimer) clearTimeout(relayoutTimer);
    };
  });
</script>

<!-- 사용자 정의 키보드 조작 위젯이다: 키보드 대응(←/→/PageUp·Down/Space)은 전역 keydown(onKey)이 담당하므로 클릭의 키 이벤트 경고는 해당 없다. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="book"
  data-part="reader-book"
  bind:this={scroller}
  data-testid="book"
  data-view={view}
  data-views={views}
  data-per-view={perView}
  data-msg={curMsg}
  role="application"
  aria-label="책 보기: 좌우 방향키나 화면 가장자리로 쪽을 넘깁니다"
  tabindex="0"
  onclick={onClick}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
>
  <div class="inner">
    <div class="strip" class:bubbles={bubble} bind:this={strip}>
      <header class="chapter-head">
        <span class="index">CHAPTER {two(chapter.range.window + 1)} · 메시지 {chapter.range.from + 1}–{chapter.range.to}</span>
        <h2>{chapter.range.window + 1}장{chapter.range.part > 0 ? ' (이어서)' : ''}</h2>
      </header>
      {#if chapter.messages.length === 0}<p class="chapter-note">이 장에는 내 메시지만 있어요</p>{/if}
      {#each chapter.messages as m (m.idx)}
        <article class="msg {m.role}" data-msg={m.idx} data-part="message" data-role={m.role}>
          <div class="speaker"><span class="marker" aria-hidden="true"></span><span class="who">{m.role === 'char' ? charName || '캐릭터' : '나'}</span><span class="index">#{String(m.idx + 1).padStart(3, '0')}{m.time ? ` · ${timeOf(m.time)}` : ''}</span></div>
          {#if showRaw}
            <pre class="raw" data-raw>{m.text}</pre>
          {:else}
            {#if m.blocks.length === 0}<p class="hidden-msg">숨김 처리된 메시지</p>{/if}
            {#each m.blocks as b, bi (bi)}
              <div class="block" data-msg={m.idx} data-block={bi}>
                <BlockView
                  block={b}
                  src={b.kind === 'image' ? api.assetUrl(source, char, b.assetName) : null}
                  marks={shown.length ? marksForBlock(shown, m.idx, bi, blockText(b).length) : []}
                />
              </div>
            {/each}
          {/if}
        </article>
      {/each}
    </div>
    <div class="snaps" bind:this={snaps}></div>
  </div>
</div>
