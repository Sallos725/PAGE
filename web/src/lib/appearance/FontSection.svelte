<script lang="ts">
  import { ApiError, api } from '../api';
  import { appearance, familyOf, fontValue, refreshFonts } from '../appearance.svelte';
  import { DEFAULTS, FONT_STACKS } from '../settings-core';
  import { settings, update } from '../settings.svelte';
  import { focusOnMount } from './focus';
  import { FONT_LIMITS, familyFromFileName, isFamily, uniqueName } from '../theme-file';

  const FORMAT = { woff2: 'WOFF2', ttf: 'TTF', otf: 'OTF' } as const;
  let error = $state('');
  let done = $state('');
  let busy = $state(false);
  let renaming = $state<string | null>(null);
  let draft = $state('');
  let confirmDelete = $state<string | null>(null);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;

  /** 견본 줄 글꼴은 CSSOM 으로 (CSP: 인라인 style 속성 금지). */
  function sample(node: HTMLElement, family: string) {
    const apply = (f: string) => { node.style.fontFamily = `${fontValue(f)}, ${FONT_STACKS.serif}`; };
    apply(family);
    return { update: apply };
  }

  function errText(e: unknown, fallback: string): string {
    if (!(e instanceof ApiError)) return fallback;
    if (e.status === 413) return '글꼴 파일은 10MB 까지예요.';
    switch (e.code) {
      case 'bad-font': return 'woff2·ttf·otf 글꼴만 올릴 수 있어요.';
      case 'too-many': return '글꼴은 30개까지예요.';
      case 'library-full': return '글꼴을 모두 합쳐 200MB 를 넘을 수 없어요.';
      case 'family-taken': return '같은 이름의 글꼴이 있어요.';
      case 'bad-family': return '이름에는 글자·숫자·공백·-·_·. 만 쓸 수 있어요.';
      default: return fallback;
    }
  }

  async function addFile(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    error = '';
    done = '';
    if (file.size > FONT_LIMITS.fileBytes) { error = '글꼴 파일은 10MB 까지예요.'; return; }
    busy = true;
    try {
      const family = uniqueName(familyFromFileName(file.name), appearance.fonts.map((f) => f.family), FONT_LIMITS.familyMax, (s) => s.toLowerCase());
      await api.addFont(family, file);
      await refreshFonts(true);
      done = '올렸어요.';
    } catch (err) { error = errText(err, '올리지 못했어요.'); } finally { busy = false; }
  }

  async function rename(id: string, old: string) {
    const family = draft.trim().normalize('NFC');
    if (!isFamily(family)) { error = '이름에는 글자·숫자·공백·-·_·. 만 쓸 수 있어요.'; return; }
    error = '';
    try {
      await api.renameFont(id, family);
      if (familyOf(settings.font) === old) update({ font: fontValue(family) }); // 이 글꼴로 읽고 있었으면 새 이름으로
      renaming = null;
      await refreshFonts(true);
    } catch (err) { error = errText(err, '이름을 바꾸지 못했어요.'); }
  }

  async function remove(id: string, family: string) {
    confirmDelete = null;
    error = '';
    try {
      await api.deleteFont(id);
      if (familyOf(settings.font) === family) update({ font: DEFAULTS.font });
      await refreshFonts(true);
    } catch { error = '지우지 못했어요.'; }
  }
</script>

<section class="appearance-section" aria-labelledby="fonts-title">
  <h2 id="fonts-title">글꼴</h2>
  <p class="meta">올린 글꼴은 보기 설정의 글꼴 목록에 나오고, 테마 CSS 에서는 <code>font-family: "이름"</code> 으로 불러요. 파일 하나 10MB 까지.</p>
  <div class="actions">
    <label class="file-button" aria-busy={busy}>{busy ? '올리는 중…' : '글꼴 추가'}<input type="file" accept=".woff2,.ttf,.otf,font/woff2,font/ttf,font/otf" class="visually-hidden" disabled={busy} onchange={(e) => void addFile(e)} /></label>
  </div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if done}<p class="status" role="status">{done}</p>{/if}
  <ul class="item-list">
    {#each appearance.fonts as f (f.id)}
      <li class="item">
        <div class="item-head">
          <span class="item-name">{f.family}</span>
          <span class="meta">{FORMAT[f.format]} · {mb(f.size)}{familyOf(settings.font) === f.family ? ' · 읽는 글꼴' : ''}</span>
        </div>
        <p class="font-sample" use:sample={f.family}>다람쥐 헌 쳇바퀴에 타고파 · PAGE 0123</p>
        {#if renaming === f.id}
          <form class="row-actions" onsubmit={(e) => { e.preventDefault(); void rename(f.id, f.family); }}>
            <input type="text" aria-label="새 글꼴 이름" maxlength={FONT_LIMITS.familyMax} bind:value={draft} use:focusOnMount />
            <button type="submit">저장</button>
            <button type="button" onclick={() => (renaming = null)}>취소</button>
          </form>
        {:else}
          <div class="row-actions">
            <button type="button" aria-label={`${f.family} 이름 바꾸기`} onclick={() => { renaming = f.id; draft = f.family; }}>이름 바꾸기</button>
            {#if confirmDelete === f.id}
              <button type="button" aria-label={`${f.family} 정말 삭제`} use:focusOnMount onclick={() => void remove(f.id, f.family)}>정말 삭제</button>
              <button type="button" onclick={() => (confirmDelete = null)}>취소</button>
            {:else}
              <button type="button" aria-label={`${f.family} 삭제`} onclick={() => (confirmDelete = f.id)}>삭제</button>
            {/if}
          </div>
        {/if}
      </li>
    {:else}
      <li class="status">올린 글꼴이 없어요.</li>
    {/each}
  </ul>
</section>
