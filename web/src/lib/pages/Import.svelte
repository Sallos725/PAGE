<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '../api';
  import { focusOnMount } from '../appearance/focus';
  import { hrefs } from '../route';
  import { IMPORTED, importSummary } from '../sources';
  import type { ImportChar } from '../types';

  const FILE_MAX = 50 * 1024 * 1024;
  const NAME_MAX = 60;
  const NEW = 'new';

  let chars = $state<ImportChar[] | null>(null);
  /** 올리기 대상으로 고를 수 있는 캐릭터 (정보 파일이 깨진 캐릭터는 지우기만 된다). */
  const targets = $derived((chars ?? []).filter((c) => !c.broken));
  const BROKEN_NAME = '읽을 수 없는 캐릭터';
  let first = true;
  let failed = $state(false);
  let target = $state<string>(NEW); // 'new' 또는 charId
  let newName = $state('');
  let newImage = $state<File | null>(null);
  let files = $state<File[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let imageInput = $state<HTMLInputElement | null>(null);
  let busy = $state(false);
  let lines = $state<{ name: string; text: string; ok: boolean }[]>([]);
  let error = $state('');
  let doneChar = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let draft = $state('');
  let confirmDelete = $state<string | null>(null);
  let manageError = $state('');

  async function load() {
    try {
      chars = await api.importChars();
      const usable = chars.filter((c) => !c.broken);
      if (target !== NEW && !usable.some((c) => c.charId === target)) target = NEW;
      if (first && target === NEW && usable.length) target = usable[0]!.charId; // 처음 열 때만 기존 캐릭터를 골라 둔다
      first = false;
    } catch { failed = true; }
  }
  onMount(() => { void load(); });

  const FORMAT_TEXT = 'RisuAI 채팅 내보내기 파일(.json)이 아니에요.';
  /** 채팅 파일 올리기 오류. 코드 없는 400(파서 실패·빈 파일)도 형식 문제로 본다. */
  function fileError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 413) return '파일은 50MB 까지예요.';
      switch (e.code) {
        case 'unsupported-format': return FORMAT_TEXT;
        case 'too-many-chats': return '한 파일에 채팅은 500개까지예요.';
        case 'not-found': return '캐릭터를 찾을 수 없어요.';
      }
      if (e.status === 400) return FORMAT_TEXT;
    }
    return '올리지 못했어요.';
  }
  function nameError(e: unknown, fallback: string): string {
    if (e instanceof ApiError && e.code === 'bad-name') return '이름을 1~60자로 써 주세요.';
    if (e instanceof ApiError && e.code === 'not-found') return '캐릭터를 찾을 수 없어요.';
    return fallback;
  }
  function imageError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 413) return '그림은 10MB 까지예요.';
      if (e.code === 'bad-image') return '그림은 PNG·JPEG·WebP 만 쓸 수 있어요.';
      if (e.code === 'not-found') return '캐릭터를 찾을 수 없어요.';
    }
    return '그림을 올리지 못했어요.';
  }

  const pickFiles = (e: Event & { currentTarget: HTMLInputElement }) => { files = Array.from(e.currentTarget.files ?? []); };
  const pickImage = (e: Event & { currentTarget: HTMLInputElement }) => { newImage = e.currentTarget.files?.[0] ?? null; };

  const canUpload = $derived(!busy && files.length > 0 && (target !== NEW || newName.trim().length > 0));

  async function upload() {
    if (!canUpload) return;
    busy = true;
    error = '';
    lines = [];
    doneChar = null;
    let charId = target;
    let attempted = false; // 채팅 파일을 실제로 보냈는가 — 보낸 때만 고른 파일을 비운다
    try {
      // 너무 큰 파일은 보내기 전에 거른다. 보낼 파일이 없으면 새 캐릭터도 만들지 않는다.
      const send = files.filter((f) => f.size <= FILE_MAX);
      lines = files.filter((f) => f.size > FILE_MAX).map((f) => ({ name: f.name, text: '파일은 50MB 까지예요.', ok: false }));
      if (send.length === 0) return;
      const creating = target === NEW;
      if (creating) {
        const name = newName.trim();
        if (Array.from(name).length > NAME_MAX) { error = '이름은 60자까지예요.'; return; }
        try { charId = await api.createImportChar(name); } catch (e) { error = nameError(e, '캐릭터를 만들지 못했어요.'); return; }
        target = charId;
        newName = '';
        if (newImage) {
          try { await api.setImportCharImage(charId, newImage); } catch (e) { error = imageError(e); }
        }
        await load();
      }
      attempted = true;
      for (const f of send) {
        try {
          const r = await api.importChats(charId, await f.text());
          const late = r.sync === 'pending' ? ' · 올렸지만 서고 반영이 늦어지고 있어요' : '';
          lines = [...lines, { name: f.name, text: importSummary(r.results) + late, ok: true }];
        } catch (e) {
          lines = [...lines, { name: f.name, text: fileError(e), ok: false }];
        }
      }
      doneChar = charId;
      // 그림 오류가 있으면 덮어쓰지 않고 이어 붙인다
      if (creating && !lines.some((l) => l.ok)) error = [error, '캐릭터는 만들어졌어요. 다른 파일을 올려 보세요.'].filter(Boolean).join(' ');
      await load();
    } finally {
      // 실제로 올렸으면 같은 파일을 다시 고를 수 있게 입력을 비운다. 이름 검사·캐릭터 만들기에서 멈췄으면 고른 파일을 그대로 둔다.
      if (attempted) {
        files = [];
        newImage = null;
        if (fileInput) fileInput.value = '';
        if (imageInput) imageInput.value = '';
      }
      busy = false;
    }
  }

  async function rename(c: ImportChar) {
    manageError = '';
    try { await api.renameImportChar(c.charId, draft.trim()); renaming = null; await load(); } catch (e) { manageError = nameError(e, '이름을 바꾸지 못했어요.'); }
  }
  async function setImage(c: ImportChar, e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    manageError = '';
    try { await api.setImportCharImage(c.charId, file); await load(); } catch (err) { manageError = imageError(err); }
  }
  async function removeImage(c: ImportChar) {
    manageError = '';
    try { await api.deleteImportCharImage(c.charId); await load(); } catch { manageError = '그림을 지우지 못했어요.'; }
  }
  async function removeChar(c: ImportChar) {
    confirmDelete = null;
    manageError = '';
    try { await api.deleteImportChar(c.charId); await load(); } catch { manageError = '지우지 못했어요.'; }
  }
</script>

<main class="page appearance-page import-page" data-part="import">
  <nav><a href={hrefs.home}>← 서고</a></nav>
  <h1>가져오기</h1>
  <p class="meta">RisuAI 에서 내보낸 채팅 파일(.json)을 올리면 “가져온 채팅”으로 읽을 수 있어요. 같은 채팅을 다시 올리면 새 버전으로 쌓여요.</p>

  {#if failed}
    <p class="status" role="alert">불러오지 못했어요.</p>
  {:else if !chars}
    <p class="status">불러오는 중…</p>
  {:else}
    <section class="appearance-section" aria-labelledby="import-target">
      <h2 id="import-target">어느 캐릭터에?</h2>
      <div class="field">
        <label for="import-char-select">캐릭터</label>
        <select id="import-char-select" bind:value={target} disabled={busy}>
          {#each targets as c (c.charId)}<option value={c.charId}>{c.name} (채팅 {c.chatCount}개)</option>{/each}
          <option value={NEW}>새 캐릭터</option>
        </select>
      </div>
      {#if target === NEW}
        <div class="field">
          <label for="import-char-name">새 캐릭터 이름</label>
          <input id="import-char-name" type="text" maxlength={NAME_MAX} bind:value={newName} disabled={busy} />
        </div>
        <div class="field">
          <label for="import-char-image">그림 (선택, 10MB 까지)</label>
          <input id="import-char-image" bind:this={imageInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onchange={pickImage} />
        </div>
      {/if}
    </section>

    <section class="appearance-section" aria-labelledby="import-files">
      <h2 id="import-files">JSON 파일</h2>
      <div class="field">
        <label for="import-file-input">채팅 내보내기 파일 (여러 개 가능, 하나에 50MB 까지)</label>
        <input id="import-file-input" bind:this={fileInput} type="file" accept=".json,application/json" multiple disabled={busy} onchange={pickFiles} />
      </div>
      <div class="actions"><button type="button" disabled={!canUpload} onclick={() => void upload()}>{busy ? '올리는 중…' : '올리기'}</button></div>
      {#if error}<p class="notice" role="alert">{error}</p>{/if}
      <ul class="item-list" aria-label="올리기 결과" aria-live="polite">
        {#each lines as l, i (i)}
          <li class="item" data-ok={l.ok}><span class="item-name">{l.name}</span> <span class="meta">{l.ok ? l.text : `실패 · ${l.text}`}</span></li>
        {/each}
      </ul>
      {#if doneChar}<p><a href={hrefs.chats(IMPORTED, doneChar)}>서고에서 보기</a></p>{/if}
    </section>

    <section class="appearance-section" aria-labelledby="import-manage">
      <h2 id="import-manage">가져온 캐릭터</h2>
      {#if manageError}<p class="notice" role="alert">{manageError}</p>{/if}
      <ul class="item-list">
        {#each chars as c (c.charId)}
          <li class="item" data-broken={c.broken ? 'true' : undefined}>
            <div class="item-head">
              {#if c.broken}
                <span class="item-name">{BROKEN_NAME}</span>
                <span class="meta">정보 파일이 손상됐어요 — 지우기만 할 수 있어요 · 채팅 파일 {c.chatCount}개</span>
              {:else}
                <a class="item-name" href={hrefs.chats(IMPORTED, c.charId)}>{c.name}</a>
                <span class="meta">채팅 {c.chatCount}개{c.hasImage ? ' · 그림 있음' : ''}</span>
              {/if}
            </div>
            {#if c.broken}
              <div class="row-actions">
                {#if confirmDelete === c.charId}
                  <button type="button" aria-label={`${BROKEN_NAME} 정말 지우기`} use:focusOnMount onclick={() => void removeChar(c)}>정말 지우기</button>
                  <button type="button" onclick={() => (confirmDelete = null)}>취소</button>
                {:else}
                  <button type="button" aria-label={`${BROKEN_NAME} 지우기`} onclick={() => (confirmDelete = c.charId)}>지우기</button>
                {/if}
              </div>
              {#if confirmDelete === c.charId}<p class="notice" role="alert">정말 지우기: 채팅 {c.chatCount}개와 책갈피·형광펜이 모두 지워져요.</p>{/if}
            {:else if renaming === c.charId}
              <form class="row-actions" onsubmit={(e) => { e.preventDefault(); void rename(c); }}>
                <input type="text" aria-label="새 캐릭터 이름" maxlength={NAME_MAX} bind:value={draft} use:focusOnMount />
                <button type="submit" disabled={!draft.trim()}>저장</button>
                <button type="button" onclick={() => (renaming = null)}>취소</button>
              </form>
            {:else}
              <div class="row-actions">
                <button type="button" aria-label={`${c.name} 이름 바꾸기`} onclick={() => { renaming = c.charId; draft = c.name; }}>이름 바꾸기</button>
                <label class="file-button">그림 바꾸기<input type="file" class="visually-hidden" accept="image/png,image/jpeg,image/webp" aria-label={`${c.name} 그림 바꾸기`} onchange={(e) => void setImage(c, e)} /></label>
                {#if c.hasImage}<button type="button" aria-label={`${c.name} 그림 지우기`} onclick={() => void removeImage(c)}>그림 지우기</button>{/if}
                {#if confirmDelete === c.charId}
                  <button type="button" aria-label={`${c.name} 정말 지우기`} use:focusOnMount onclick={() => void removeChar(c)}>정말 지우기</button>
                  <button type="button" onclick={() => (confirmDelete = null)}>취소</button>
                {:else}
                  <button type="button" aria-label={`${c.name} 지우기`} onclick={() => (confirmDelete = c.charId)}>지우기</button>
                {/if}
              </div>
              {#if confirmDelete === c.charId}<p class="notice" role="alert">정말 지우기: 채팅 {c.chatCount}개와 책갈피·형광펜이 모두 지워져요.</p>{/if}
            {/if}
          </li>
        {:else}
          <li class="status">가져온 캐릭터가 없어요.</li>
        {/each}
      </ul>
    </section>
  {/if}
</main>
