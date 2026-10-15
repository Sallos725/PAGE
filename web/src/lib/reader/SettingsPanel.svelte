<script lang="ts">
  import { appearance, familyOf, fontValue } from '../appearance.svelte';
  import { hrefs } from '../route';
  import { LIMITS, customThemeId, type Theme } from '../settings-core';
  import { settings, update } from '../settings.svelte';

  let { onClose, onRules, onExport, canExport = true }: { onClose: () => void; onRules: () => void; onExport: () => void; canExport?: boolean } = $props();
  const PRESET_NAMES = ['serif', 'sans', 'system'];
  const uploaded = $derived(familyOf(settings.font));
  const preset = $derived(
    PRESET_NAMES.includes(settings.font) ? settings.font
      : uploaded !== null && appearance.fonts.some((f) => f.family === uploaded) ? `font:${uploaded}` : 'custom',
  );
  // svelte-ignore state_referenced_locally
  let custom = $state(PRESET_NAMES.includes(settings.font) ? '' : settings.font);
  const missingTheme = $derived(customThemeId(settings.theme) !== null && !appearance.themes.some((t) => `custom:${t.id}` === settings.theme));

  const LINE = [1.5, 1.7, 1.85, 2, 2.2];
  const PARA = [0, 0.5, 0.9, 1.3];
  const WIDTH = [30, 34, 38, 44, 50];
</script>

<div class="panel" data-part="panel" role="dialog" aria-label="보기 설정">
  <div class="panel-head">
    <strong>보기 설정</strong>
    <button type="button" onclick={onClose}>닫기</button>
  </div>
  <div class="row">
    <span>글자 크기</span>
    <button type="button" aria-label="글자 크기 줄이기" disabled={settings.fontSize <= LIMITS.fontSize[0]} onclick={() => update({ fontSize: settings.fontSize - 1 })}>가−</button>
    <output aria-live="polite">{settings.fontSize}px</output>
    <button type="button" aria-label="글자 크기 키우기" disabled={settings.fontSize >= LIMITS.fontSize[1]} onclick={() => update({ fontSize: settings.fontSize + 1 })}>가+</button>
  </div>
  <label class="row">글꼴
    <select value={preset} onchange={(e) => { const v = e.currentTarget.value; if (v.startsWith('font:')) update({ font: fontValue(v.slice(5)) }); else if (v !== 'custom') update({ font: v }); }}>
      <option value="serif">명조</option>
      <option value="sans">고딕</option>
      <option value="system">시스템</option>
      {#each appearance.fonts as f (f.id)}<option value={`font:${f.family}`}>{f.family}</option>{/each}
      <option value="custom" disabled={!custom && preset !== 'custom'}>직접 입력</option>
    </select>
  </label>
  <label class="row">직접 입력
    <input type="text" placeholder="기기에 설치된 글꼴 이름" maxlength="120" bind:value={custom} onchange={() => { if (custom.trim()) update({ font: custom.trim() }); }} />
  </label>
  <label class="row">줄 간격
    <select value={String(settings.lineHeight)} onchange={(e) => update({ lineHeight: Number(e.currentTarget.value) })}>
      {#each LINE as v (v)}<option value={String(v)}>{v}</option>{/each}
    </select>
  </label>
  <label class="row">문단 간격
    <select value={String(settings.paraSpacing)} onchange={(e) => update({ paraSpacing: Number(e.currentTarget.value) })}>
      {#each PARA as v (v)}<option value={String(v)}>{v}</option>{/each}
    </select>
  </label>
  <label class="row">본문 폭(스크롤)
    <select value={String(settings.width)} onchange={(e) => update({ width: Number(e.currentTarget.value) })}>
      {#each WIDTH as v (v)}<option value={String(v)}>{v}</option>{/each}
    </select>
  </label>
  <label class="row"><input type="checkbox" checked={settings.justify} onchange={(e) => update({ justify: e.currentTarget.checked })} /> 양쪽 정렬</label>
  <label class="row"><input type="checkbox" checked={settings.indent} onchange={(e) => update({ indent: e.currentTarget.checked })} /> 첫 줄 들여쓰기</label>
  <label class="row"><input type="checkbox" checked={settings.bubble} onchange={(e) => update({ bubble: e.currentTarget.checked })} /> 말풍선</label>
  <label class="row"><input type="checkbox" checked={settings.hideUser} onchange={(e) => update({ hideUser: e.currentTarget.checked })} /> 내 메시지 숨기기</label>
  <button type="button" class="wide" onclick={onRules}>숨김 규칙</button>
  <button type="button" class="wide" disabled={!canExport} onclick={onExport}>내보내기</button>
  <label class="row">테마
    <select value={settings.theme} onchange={(e) => update({ theme: e.currentTarget.value as Theme })}>
      <option value="system">기기 설정</option>
      <option value="light">밝게</option>
      <option value="dark">어둡게</option>
      <option value="sepia">세피아</option>
      {#each appearance.themes as t (t.id)}<option value={`custom:${t.id}`}>{t.name}</option>{/each}
      {#if missingTheme}<option value={settings.theme}>(없는 테마)</option>{/if}
    </select>
  </label>
  <a class="wide" href={hrefs.appearance}>테마·글꼴 관리</a>
</div>
