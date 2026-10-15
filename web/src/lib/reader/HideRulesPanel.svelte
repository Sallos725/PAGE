<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import { RULE_ERROR_TEXT, checkRule, type RuleError } from '../hide-rules';
  import { trialRun } from '../hide-trial';
  import type { HideCandidate, HideRule, HideRuleScope, ImageRule } from '../types';

  type Props = {
    source: string;
    char: string;
    rules: HideRule[];
    sample: () => string[];
    onChange: (rules: HideRule[]) => void;
    imageRules: ImageRule[];
    onImageChange: (rules: ImageRule[]) => void;
    onClose: () => void;
  };
  let { source, char, rules, sample, onChange, imageRules, onImageChange, onClose }: Props = $props();

  type Draft = { id: string | null; name: string; pattern: string; flags: string; scope: HideRuleScope; origin: 'manual' | 'card' };
  let draft = $state<Draft | null>(null);
  let error = $state<string | null>(null);
  let preview = $state<string | null>(null);
  let busy = $state(false);
  let candidates = $state<HideCandidate[]>([]);

  onMount(() => {
    void api.hideCandidates(source, char).then((c) => (candidates = c)).catch(() => (candidates = []));
  });

  const blank = (): Draft => ({ id: null, name: '', pattern: '', flags: 'g', scope: 'char', origin: 'manual' });
  const startNew = () => { draft = blank(); error = null; preview = null; };
  const startEdit = (r: HideRule) => { draft = { id: r.id, name: r.name, pattern: r.pattern, flags: r.flags, scope: r.scope, origin: r.origin }; error = null; preview = null; };
  const startFrom = (c: HideCandidate) => { draft = { id: null, name: c.name, pattern: c.pattern, flags: c.flags, scope: 'char', origin: 'card' }; error = null; preview = null; };

  /** 검증 → Worker 시험 실행. 통과하면 정규화된 플래그를, 아니면 null (error 를 채운다). */
  async function verify(d: Draft): Promise<string | null> {
    const c = checkRule(d.name, d.pattern, d.flags);
    if (!c.ok) { error = RULE_ERROR_TEXT[c.error]; return null; }
    const t = await trialRun(d.pattern, c.flags, sample());
    if (!t.ok) { error = RULE_ERROR_TEXT[t.error as RuleError]; return null; }
    preview = `불러온 메시지에서 ${t.count}곳`;
    return c.flags;
  }

  async function test() {
    if (!draft) return;
    error = null;
    busy = true;
    try { await verify(draft); } finally { busy = false; }
  }

  async function save() {
    if (!draft) return;
    error = null;
    busy = true;
    try {
      const flags = await verify(draft);
      if (flags === null) return;
      const d = draft;
      if (d.id) {
        const r = await api.updateHideRule(source, d.id, { name: d.name.trim(), pattern: d.pattern, flags });
        onChange(rules.map((x) => (x.id === r.id ? r : x)));
      } else {
        const r = await api.addHideRule(source, char, { name: d.name.trim(), pattern: d.pattern, flags, scope: d.scope, origin: d.origin });
        onChange([...rules, r]);
        candidates = candidates.filter((c) => !(c.pattern === r.pattern && c.flags === r.flags));
      }
      draft = null;
      preview = null;
    } catch {
      error = '저장하지 못했어요.';
    } finally {
      busy = false;
    }
  }

  async function toggle(r: HideRule, enabled: boolean) {
    try {
      const u = await api.updateHideRule(source, r.id, { enabled });
      onChange(rules.map((x) => (x.id === u.id ? u : x)));
    } catch {
      error = '바꾸지 못했어요.';
    }
  }

  async function remove(r: HideRule) {
    try {
      await api.deleteHideRule(source, r.id);
      onChange(rules.filter((x) => x.id !== r.id));
    } catch {
      error = '지우지 못했어요.';
    }
  }

  async function toggleImage(r: ImageRule, enabled: boolean) {
    try {
      await api.setImageRule(source, char, r.key, enabled);
      onImageChange(imageRules.map((x) => (x.key === r.key ? { ...x, enabled } : x)));
    } catch {
      error = '바꾸지 못했어요.';
    }
  }

  const clearMsgs = () => { error = null; preview = null; };
</script>

<div class="panel rules-panel" data-part="panel" role="dialog" aria-label="숨김 규칙">
  <div class="panel-head">
    <strong>숨김 규칙</strong>
    <button type="button" onclick={onClose}>닫기</button>
  </div>
  <p class="hint">목록의 정규식과 일치하는 부분은 화면에 안 보여요. 원문은 그대로라서 원문 보기를 켜면 다시 보여요.</p>

  <ul class="list rule-list">
    {#each rules as r (r.id)}
      <li class="rule">
        <label class="rule-on"><input type="checkbox" checked={r.enabled} onchange={(e) => void toggle(r, e.currentTarget.checked)} /> {r.name}</label>
        <code class="pattern">{r.pattern}</code>
        <span class="meta">{r.scope === 'global' ? '모든 캐릭터' : '이 캐릭터만'}{r.flags ? ` · ${r.flags}` : ''}{r.origin === 'card' ? ' · 카드에서 가져옴' : ''}</span>
        <span class="rule-actions">
          <button type="button" aria-label={`${r.name} 수정`} onclick={() => startEdit(r)}>수정</button>
          <button type="button" aria-label={`${r.name} 삭제`} onclick={() => void remove(r)}>삭제</button>
        </span>
      </li>
    {:else}
      <li class="status">아직 규칙이 없어요.</li>
    {/each}
  </ul>

  {#if draft}
    <form class="rule-form" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <label class="row">이름 <input type="text" maxlength="40" bind:value={draft.name} oninput={clearMsgs} /></label>
      <label class="row">패턴 <input type="text" class="mono" maxlength="500" spellcheck="false" autocapitalize="off" bind:value={draft.pattern} oninput={clearMsgs} /></label>
      <label class="row">플래그 <input type="text" class="mono flags" maxlength="5" spellcheck="false" autocapitalize="off" bind:value={draft.flags} oninput={clearMsgs} /></label>
      {#if !draft.id}
        <label class="row">범위
          <select bind:value={draft.scope}>
            <option value="char">이 캐릭터만</option>
            <option value="global">모든 캐릭터</option>
          </select>
        </label>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      {#if preview}<p class="meta" role="status">{preview}</p>{/if}
      <div class="form-actions">
        <button type="button" disabled={busy} onclick={() => void test()}>시험하기</button>
        <button type="submit" disabled={busy}>저장</button>
        <button type="button" onclick={() => { draft = null; clearMsgs(); }}>취소</button>
      </div>
    </form>
  {:else}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <button type="button" class="wide" onclick={startNew}>규칙 추가</button>
  {/if}

  {#if candidates.length}
    <section class="candidates" aria-label="카드의 정규식">
      <p class="hint">캐릭터 카드의 표시용 정규식이에요. 가져오기 전에 고칠 수 있어요.</p>
      <ul class="list">
        {#each candidates as c (c.flags + c.pattern)}
          <li class="rule">
            <span class="rule-name">{c.name}</span>
            <code class="pattern">{c.pattern}</code>
            <span class="rule-actions"><button type="button" aria-label={`${c.name} 가져오기`} onclick={() => startFrom(c)}>가져오기</button></span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if imageRules.length}
    <section class="card-images" aria-labelledby="card-images-title">
      <h3 id="card-images-title" class="sub-head">카드 그림</h3>
      <p class="hint">캐릭터 카드의 표시용 정규식 중 본문 그림만 적용해요. 조건에 따라 바뀌는 그림과 상태창 꾸밈은 빠져요.</p>
      <ul class="list">
        {#each imageRules as r (r.key)}
          <li class="rule">
            <label class="rule-on"><input type="checkbox" checked={r.enabled} onchange={(e) => void toggleImage(r, e.currentTarget.checked)} /> {r.name || '이름 없는 규칙'} 그림 표시</label>
            <code class="pattern">{r.pattern}</code>
            <span class="meta">그림 {r.images.length}장{r.slow ? ' · 느려서 꺼둠' : ''}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
