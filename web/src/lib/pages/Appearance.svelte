<script lang="ts">
  import FontSection from '../appearance/FontSection.svelte';
  import ThemeSection from '../appearance/ThemeSection.svelte';
  import { hrefs } from '../route';
</script>

<main class="page appearance-page" data-part="appearance">
  <nav><a href={hrefs.home}>← 서고</a></nav>
  <h1>테마·글꼴</h1>
  <ThemeSection />
  <FontSection />
  <section class="appearance-section" aria-labelledby="safe-title">
    <h2 id="safe-title">화면이 깨졌을 때</h2>
    <p>주소에 <code>?theme=off</code> 를 붙여 열면 커스텀 테마 없이 열려요. <a href="/?theme=off#/appearance">안전 모드로 열기</a></p>
    <p class="meta">색 토큰, 글꼴·리더 변수, data-part 이름표는 업데이트해도 유지돼요. 그 밖의 클래스는 바뀔 수 있어요.</p>
  </section>
</main>
