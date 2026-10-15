<script lang="ts">
  // 캐릭터 대표 이미지. 없거나 실패하면 이니셜 칸 (스펙 6.4). onerror 속성 대신 addEventListener (CSP).
  let { src, name, size = 24 }: { src: string | null; name: string; size?: number } = $props();
  let failed = $state(false);
  const initial = $derived([...name.trim()][0] ?? '?');
  function box(node: HTMLElement, px: number) {
    const apply = (n: number) => { node.style.width = `${n}px`; node.style.height = `${n}px`; node.style.fontSize = `${Math.round(n * 0.45)}px`; };
    apply(px);
    return { update: apply };
  }
  function watchError(node: HTMLImageElement) {
    const fail = () => { failed = true; };
    node.addEventListener('error', fail);
    if (node.complete && node.naturalWidth === 0 && node.currentSrc) fail();
    return { destroy: () => node.removeEventListener('error', fail) };
  }
</script>

{#if src && !failed}
  <img class="char-image" {src} alt="" use:box={size} use:watchError />
{:else}
  <span class="char-image initial" aria-hidden="true" use:box={size}>{initial}</span>
{/if}
