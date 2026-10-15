<script lang="ts">
  import HighlightList from '../reader/HighlightList.svelte';
  import { hrefs } from '../route';
</script>

<main class="page highlights-page" data-part="highlights">
  <nav><a href={hrefs.home}>← 서고</a></nav>
  <h1>형광펜</h1>
  <HighlightList />
</main>
