<script lang="ts">
  import { api } from '../api';
  import { refreshThemes } from '../appearance.svelte';
  import { focusOnMount } from './focus';
  import { THEME_LIMITS, cleanThemeName, cssBytes, type ThemeBase } from '../theme-file';

  let { id, onDone }: { id: string; onDone: () => void } = $props();
  let name = $state('');
  let base = $state<ThemeBase>('light');
  let css = $state('');
  let loaded = $state(false);
  let error = $state('');
  let saving = $state(false);

  // svelte-ignore state_referenced_locally
  void api.theme(id).then((t) => { name = t.name; base = t.base; css = t.css; loaded = true; }).catch(() => { error = '불러오지 못했어요.'; });

  async function save() {
    const n = cleanThemeName(name);
    if (!n) { error = '이름을 적어 주세요.'; return; }
    if (cssBytes(css) > THEME_LIMITS.cssBytes) { error = 'CSS 가 너무 커요 (256KB 까지).'; return; }
    saving = true;
    error = '';
    try {
      await api.updateTheme(id, { name: n, base, css });
      await refreshThemes();
      onDone();
    } catch {
      error = '저장하지 못했어요.';
    } finally {
      saving = false;
    }
  }
</script>

<form class="theme-editor" aria-label="테마 편집" onsubmit={(e) => { e.preventDefault(); void save(); }}>
  {#if !loaded && !error}
    <p class="status">불러오는 중…</p>
  {:else}
    <label class="row">이름 <input type="text" maxlength={THEME_LIMITS.nameMax} bind:value={name} use:focusOnMount /></label>
    <label class="row">바탕
      <select bind:value={base}>
        <option value="light">밝게</option>
        <option value="dark">어둡게</option>
        <option value="sepia">세피아</option>
      </select>
    </label>
    <label class="css-label">CSS
      <textarea class="css-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" rows="16" bind:value={css}></textarea>
    </label>
    {#if error}<p class="notice" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="submit" disabled={saving || !loaded}>저장</button>
      <button type="button" onclick={onDone}>취소</button>
    </div>
  {/if}
</form>
