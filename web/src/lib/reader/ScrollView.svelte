<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api } from '../api';
  import { blockText } from '../blocks';
  import type { Chapter, ChapterLoader } from '../chapters';
  import { marksForBlock, relocateHighlights, type Highlight } from '../highlights';
  import { anchorOf } from '../position';
  import { fractionWithin, pickReadingBlock } from '../scroll-math';
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
    onPosition: (p: ReadingPosition) => void;
  };
  let { loader, first, startAt, source, char, showRaw, bubble, highlights, charName, onPosition }: Props = $props();
  const two = (n: number) => String(n).padStart(2, '0');
  const timeOf = (t?: number) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

  const MAX_CHAPTERS = 3; // 화면 밖 챕터 DOM 은 해제한다 (스펙 4.2)
  const LINE_GAP = 20; // 읽기 줄 = sticky 헤더 아래 20px (헤더에 가려진 블록을 "읽는 중"으로 판정하면 안 된다)
  const PREFETCH = 1200; // 가장자리까지 남은 거리가 이보다 작으면 이웃 챕터를 미리 로드

  // svelte-ignore state_referenced_locally
  let chapters = $state<Chapter[]>([first]);
  // 숨김 규칙으로 텍스트가 밀리면 하이라이트 끝점을 다시 찾는다 (못 찾은 것은 숨김).
  const shown = $derived(relocateHighlights(highlights, chapters.flatMap((c) => c.messages)));
  let topEdge: HTMLElement;
  let bottomEdge: HTMLElement;
  let atStart = $state(false);
  let atEnd = $state(false);
  let ready = false;
  let busy = false;
  let raf = 0;

  // 화면에 보이는 블록만 추적 (스크롤마다 수천 개 요소를 훑지 않는다)
  const visible = new Set<HTMLElement>();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      if (e.isIntersecting) visible.add(el);
      else visible.delete(el);
    }
    // 큰 점프(scrollIntoView 등) 뒤엔 스크롤 이벤트가 더 없다. 교차 집합이 따라잡은 지금 다시 보고해야 위치가 멈춘 채 남지 않는다.
    schedule();
  });
  function track(node: HTMLElement) {
    io.observe(node);
    return {
      destroy() {
        io.unobserve(node);
        visible.delete(node);
      },
    };
  }

  function textOf(msgIdx: number, blockIdx: number): string {
    for (const ch of chapters) {
      const m = ch.messages.find((x) => x.idx === msgIdx);
      if (m) {
        const b = m.blocks[blockIdx];
        return b ? blockText(b) : '';
      }
    }
    return '';
  }

  /** 읽기 줄의 뷰포트 y. 헤더 높이·iOS 안전영역에 따라 달라지므로 매번 실측한다. */
  function lineY(): number {
    const bar = document.querySelector('.reader-bar');
    return (bar ? bar.getBoundingClientRect().bottom : 0) + LINE_GAP;
  }

  function readingBlock(y: number = lineY()) {
    const rects = [...visible].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, top: r.top, bottom: r.bottom };
    });
    return pickReadingBlock(rects, y);
  }

  function report() {
    if (!ready) return;
    const y = lineY();
    const hit = readingBlock(y);
    if (!hit) return;
    const msgIdx = Number(hit.el.dataset.msg);
    const blockIdx = Number(hit.el.dataset.block);
    const text = textOf(msgIdx, blockIdx);
    const charOffset = Math.floor(text.length * fractionWithin(hit.top, hit.bottom, y));
    onPosition({ msgIdx, blockIdx, charOffset, anchorHash: anchorOf(text, charOffset) });
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      report();
      void maybeLoad();
    });
  }

  /** 챕터를 붙이거나 떼도 읽던 블록이 화면에서 움직이지 않게 스크롤을 보정한다. */
  async function anchored(mutate: () => void) {
    const anchor = readingBlock()?.el ?? null;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    mutate();
    await tick();
    if (anchor && anchor.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - before);
  }

  async function loadNext() {
    if (busy || atEnd) return;
    busy = true;
    try {
      const nxt = await loader.next(chapters[chapters.length - 1]!);
      if (!nxt) { atEnd = true; return; }
      chapters.push(nxt);
      await tick();
      if (chapters.length > MAX_CHAPTERS) await anchored(() => { chapters.shift(); });
    } catch {
      /* 네트워크 오류: 다음 스크롤에서 다시 시도한다 */
    } finally {
      busy = false;
      schedule();
    }
  }

  async function loadPrev() {
    if (busy || atStart) return;
    busy = true;
    try {
      const prv = await loader.prev(chapters[0]!);
      if (!prv) { atStart = true; return; }
      await anchored(() => { chapters.unshift(prv); });
      if (chapters.length > MAX_CHAPTERS) { chapters.pop(); await tick(); }
    } catch {
      /* 위와 같음 */
    } finally {
      busy = false;
      schedule();
    }
  }

  async function maybeLoad() {
    if (!ready || !bottomEdge || !topEdge) return;
    if (bottomEdge.getBoundingClientRect().top < window.innerHeight + PREFETCH) await loadNext();
    if (topEdge.getBoundingClientRect().bottom > -PREFETCH) await loadPrev();
  }

  function scrollToPosition(pos: ReadingPosition) {
    const el =
      document.querySelector<HTMLElement>(`[data-msg="${pos.msgIdx}"][data-block="${pos.blockIdx}"]`) ??
      document.querySelector<HTMLElement>(`[data-msg="${pos.msgIdx}"]`);
    if (!el) return;
    const text = textOf(pos.msgIdx, pos.blockIdx);
    const frac = text.length ? Math.min(1, pos.charOffset / text.length) : 0;
    const r = el.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + r.height * frac - lineY());
  }

  onMount(() => {
    void (async () => {
      await tick();
      if (startAt) scrollToPosition(startAt);
      else window.scrollTo(0, 0);
      await new Promise<number>((r) => requestAnimationFrame(r)); // 레이아웃이 자리 잡은 뒤 추적 시작
      ready = true;
      schedule();
    })();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  });
</script>

<div class="scroll" data-part="reader-scroll" class:bubbles={bubble} data-testid="scroll">
  <div bind:this={topEdge} class="edge">{atStart ? '처음이에요' : ''}</div>
  {#each chapters as ch (ch.id)}
    <section class="chapter" data-chapter={ch.id}>
      <header class="chapter-head">
        <span class="index">CHAPTER {two(ch.range.window + 1)} · 메시지 {ch.range.from + 1}–{ch.range.to}</span>
        <h2>{ch.range.window + 1}장{ch.range.part > 0 ? ' (이어서)' : ''}</h2>
      </header>
      {#if ch.messages.length === 0}<p class="chapter-note">이 장에는 내 메시지만 있어요</p>{/if}
      {#each ch.messages as m (m.idx)}
        <article class="msg {m.role}" data-msg={m.idx} data-part="message" data-role={m.role}>
          <div class="speaker"><span class="marker" aria-hidden="true"></span><span class="who">{m.role === 'char' ? charName || '캐릭터' : '나'}</span><span class="index">#{String(m.idx + 1).padStart(3, '0')}{m.time ? ` · ${timeOf(m.time)}` : ''}</span></div>
          {#if showRaw}
            <pre class="raw" data-raw>{m.text}</pre>
          {:else}
            {#if m.blocks.length === 0}<p class="hidden-msg">숨김 처리된 메시지</p>{/if}
            {#each m.blocks as b, bi (bi)}
              <div class="block" data-msg={m.idx} data-block={bi} use:track>
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
    </section>
  {/each}
  <div bind:this={bottomEdge} class="edge">{atEnd ? '끝이에요' : ''}</div>
</div>
