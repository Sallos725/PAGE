<script lang="ts">
  type Props = { current: string; original: string; onSave: (name: string) => Promise<void>; onCancel: () => void };
  let { current, original, onSave, onCancel }: Props = $props();
  // svelte-ignore state_referenced_locally
  let value = $state(current === original ? '' : current);
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const v = value.trim();
    if (v.length > 80) { error = '80자까지 쓸 수 있어요.'; return; }
    busy = true;
    error = null;
    try {
      await onSave(v);
    } catch {
      error = '저장하지 못했어요.';
    } finally {
      busy = false;
    }
  }
</script>

<form class="rename" onsubmit={submit}>
  <input type="text" aria-label="새 이름" maxlength="80" placeholder={original} bind:value />
  <button type="submit" disabled={busy}>저장</button>
  <button type="button" onclick={onCancel}>취소</button>
  <span class="meta">원래 이름 · {original} (비우면 원래 이름으로)</span>
  {#if error}<span class="form-error" role="alert">{error}</span>{/if}
</form>
