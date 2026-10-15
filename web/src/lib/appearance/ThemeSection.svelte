<script lang="ts">
  import { ApiError, api } from '../api';
  import { appearance, refreshThemes } from '../appearance.svelte';
  import { customThemeId } from '../settings-core';
  import { settings, update } from '../settings.svelte';
  import { THEME_LIMITS, cssBytes, parseThemeFile, uniqueName, type ThemeBase } from '../theme-file';
  import { defaultThemeCss } from '../theme-template';
  import { focusOnMount } from './focus';
  import ThemeEditor from './ThemeEditor.svelte';

  const BASE_LABEL: Record<ThemeBase, string> = { light: '밝게', dark: '어둡게', sepia: '세피아' };
  let editing = $state<string | null>(null);
  let confirmDelete = $state<string | null>(null);
  let error = $state('');
  let busy = $state(false);
  const activeId = $derived(customThemeId(settings.theme));
  const names = () => appearance.themes.map((t) => t.name);
  const TOO_LARGE = 'CSS 가 너무 커요 (256KB 까지).';
  const errText = (e: unknown, fallback: string) =>
    e instanceof ApiError ? (e.status === 413 ? TOO_LARGE : e.code === 'too-many' ? '테마는 50개까지예요.' : fallback) : fallback;

  async function add() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const t = await api.createTheme({ name: uniqueName('새 테마', names()), base: 'light', css: defaultThemeCss() });
      await refreshThemes();
      editing = t.id;
    } catch (e) { error = errText(e, '만들지 못했어요.'); } finally { busy = false; }
  }

  async function importFile(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    error = '';
    if (file.size > THEME_LIMITS.cssBytes + 4096) { error = TOO_LARGE; return; } // 머리 주석 몫으로 조금 더 받는다
    busy = true;
    try {
      const parsed = parseThemeFile(await file.text(), file.name);
      if (cssBytes(parsed.css) > THEME_LIMITS.cssBytes) { error = TOO_LARGE; return; }
      await api.createTheme({ ...parsed, name: uniqueName(parsed.name, names()) });
      await refreshThemes();
    } catch (err) { error = errText(err, '가져오지 못했어요.'); } finally { busy = false; }
  }

  async function duplicate(id: string) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const t = await api.theme(id);
      await api.createTheme({ name: uniqueName(`${t.name} 사본`, names()), base: t.base, css: t.css });
      await refreshThemes();
    } catch (e) { error = errText(e, '복제하지 못했어요.'); } finally { busy = false; }
  }

  async function remove(id: string, base: ThemeBase) {
    confirmDelete = null;
    error = '';
    try {
      await api.deleteTheme(id);
      if (activeId === id) update({ theme: base }); // 지금 쓰던 프리셋이면 그 바탕 테마로
      if (editing === id) editing = null;
      await refreshThemes();
    } catch { error = '지우지 못했어요.'; }
  }
</script>

<section class="appearance-section" aria-labelledby="themes-title">
  <h2 id="themes-title">테마</h2>
  <div class="actions">
    <button type="button" disabled={busy} onclick={() => void add()}>추가</button>
    <label class="file-button">임포트<input type="file" accept=".css,text/css" class="visually-hidden" disabled={busy} onchange={(e) => void importFile(e)} /></label>
  </div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <ul class="item-list">
    {#each appearance.themes as t (t.id)}
      <li class="item" class:active={activeId === t.id}>
        <div class="item-head">
          <span class="item-name">{t.name}</span>
          <span class="meta">{BASE_LABEL[t.base]}{activeId === t.id ? ' · 사용 중' : ''}</span>
        </div>
        <div class="row-actions">
          <button type="button" aria-label={`${t.name} 사용`} disabled={activeId === t.id} onclick={() => update({ theme: `custom:${t.id}` })}>사용</button>
          <button type="button" aria-label={`${t.name} 편집`} aria-expanded={editing === t.id} onclick={() => (editing = editing === t.id ? null : t.id)}>편집</button>
          <button type="button" aria-label={`${t.name} 복제`} disabled={busy} onclick={() => void duplicate(t.id)}>복제</button>
          <a class="button-link" href={api.themeDownloadUrl(t.id)} download aria-label={`${t.name} 내보내기`}>내보내기</a>
          {#if confirmDelete === t.id}
            <button type="button" aria-label={`${t.name} 정말 삭제`} use:focusOnMount onclick={() => void remove(t.id, t.base)}>정말 삭제</button>
            <button type="button" onclick={() => (confirmDelete = null)}>취소</button>
          {:else}
            <button type="button" aria-label={`${t.name} 삭제`} onclick={() => (confirmDelete = t.id)}>삭제</button>
          {/if}
        </div>
        {#if editing === t.id}<ThemeEditor id={t.id} onDone={() => { if (editing === t.id) editing = null; }} />{/if}
      </li>
    {:else}
      <li class="status">아직 만든 테마가 없어요. 추가를 누르면 지금 색이 적힌 기본 테마가 생겨요.</li>
    {/each}
  </ul>
</section>
