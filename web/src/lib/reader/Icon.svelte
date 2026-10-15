<script lang="ts">
  let { name }: { name: 'back' | 'book' | 'scroll' | 'bookmark' | 'keep' } = $props();
</script>

<svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  {#if name === 'back'}<path d="M15 6l-6 6 6 6"></path>
  {:else if name === 'book'}<path d="M3 5.5c3-1 6-1 9 1 3-2 6-2 9-1v13c-3-1-6-1-9 1-3-2-6-2-9-1z"></path><path d="M12 6.5v13"></path>
  {:else if name === 'scroll'}<path d="M7 4h10M7 9h10M7 14h10M7 19h6"></path>
  {:else if name === 'keep'}<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"></path>
  {:else}<path d="M7 4h10v16l-5-3.5L7 20z"></path>{/if}
</svg>
