<script lang="ts">
  import type { Block } from '../blocks';
  import { segments, type Mark } from '../highlights';

  let { block, src, marks = [] }: { block: Block; src: string | null; marks?: Mark[] } = $props();
  let failed = $state(false);

  // CSP(style-src-attr / script-src-attr)를 풀지 않기 위해 `style:` 지시문과 `onerror=` 속성을 쓰지 않는다:
  // Svelte 는 둘 다 인라인 속성(style="…", onerror="this.__e=event")으로 내보낸다. CSSOM/addEventListener 는 CSP 대상이 아니다.
  function sized(node: HTMLElement, ratio: string | null) {
    const apply = (r: string | null) => (r ? node.style.setProperty('aspect-ratio', r) : node.style.removeProperty('aspect-ratio'));
    apply(ratio);
    return { update: apply };
  }
  function watchError(node: HTMLImageElement) {
    const fail = () => { failed = true; };
    node.addEventListener('error', fail);
    if (node.complete && node.naturalWidth === 0 && node.currentSrc) fail(); // 리스너 전에 이미 실패한 경우
    return { destroy: () => node.removeEventListener('error', fail) };
  }
  const ratio = $derived(block.kind === 'image' && block.width && block.height ? `${block.width} / ${block.height}` : null);
  // 하이라이트는 텍스트를 조각으로 나눠 <mark> 로 감싼다 — 여전히 텍스트 노드만 만든다 (HTML 주입 없음)
  const pieces = $derived(block.kind === 'paragraph' || block.kind === 'dialogue' ? segments(block.text, marks) : []);
</script>

{#if block.kind === 'paragraph' || block.kind === 'dialogue'}
  <p class="para" class:dialogue={block.kind === 'dialogue'}>{#each pieces as seg, i (i)}{#if seg.mark}<mark class="hl" data-hl={seg.mark.id} data-color={seg.mark.color}>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</p>
{:else if block.kind === 'image'}
  <figure class="img">
    {#if failed || !src}
      <div class="broken" role="img" aria-label="이미지를 불러올 수 없어요">이미지를 불러올 수 없어요</div>
    {:else}
      <img {src} alt="" loading="lazy" decoding="async" width={block.width} height={block.height} use:sized={ratio} use:watchError />
    {/if}
  </figure>
{:else}
  <hr class="divider" />
{/if}
