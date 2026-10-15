<script lang="ts">
  import Library from '../library/Library.svelte';
  import { hrefs } from '../route';
  let { source }: { source: string } = $props();
</script>

<main class="page library-page">
  <header class="library-aside" data-part="app-header">
    <nav><a href={hrefs.home}>← 서고</a></nav>
    <div class="index">SOURCE</div>
    <h1 class="library-title">{source}</h1>
  </header>
  <div class="library-main"><Library {source} /></div>
</main>
