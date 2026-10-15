<!-- 원본 연결 (포터블 전용, 포터블 스펙 §6) -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '../api';
  import { hrefs } from '../route';
  import { checkMessage } from '../sources';
  import type { PortableSource, SourceCheck } from '../types';

  type Reason = Extract<SourceCheck, { ok: false }>['reason'];
  const REASONS: readonly string[] = ['not-absolute', 'unc', 'not-found', 'unreadable'] satisfies Reason[];

  // restartFirstUpMs: 내려간 걸 못 봤을 때, 이만큼 지난 뒤 응답해야 다시 켜진 걸로 본다 (아직 안 내려간 옛 서버의 응답을 거른다).
  let { restartPollMs = 500, restartGiveUpMs = 60_000, restartFirstUpMs = 10_000, onRestarted = () => { location.hash = hrefs.home; location.reload(); } }:
    { restartPollMs?: number; restartGiveUpMs?: number; restartFirstUpMs?: number; onRestarted?: () => void } = $props();

  let info = $state<PortableSource | null>(null);
  let failed = $state(false);
  let path = $state('');
  let check = $state<SourceCheck | null>(null);
  let error = $state('');
  let busy = $state(false);
  let restarting = $state(false);
  let confirmOff = $state(false);
  let browsing = $state(false);
  let restartFailed = $state(false);
  let alive = true;

  onMount(() => {
    api.portableSource().then((r) => { info = r; }, () => { failed = true; });
    return () => { alive = false; };
  });

  async function runCheck() {
    error = ''; check = null;
    if (!path.trim()) return;
    const asked = path.trim();
    busy = true;
    try {
      const r = await api.checkPortableSource(asked);
      if (path.trim() !== asked) return; // 그사이 경로가 바뀌었다 — 옛 결과는 버린다
      check = r;
      if (!r.ok) error = checkMessage(r.reason);
    } catch { if (path.trim() === asked) error = '확인하지 못했어요. 잠시 뒤 다시 해 주세요.'; }
    finally { busy = false; }
  }

  async function browse() {
    error = '';
    busy = true; browsing = true;
    try {
      const r = await api.browsePortable();
      browsing = false;
      if ('path' in r) { path = r.path; check = null; busy = false; await runCheck(); }
    } catch (e) {
      error = e instanceof ApiError && e.code === 'busy' ? '폴더 선택 창이 이미 열려 있어요. 작업 표시줄을 확인해 주세요.' : '폴더 선택 창을 열지 못했어요. 경로를 직접 붙여 넣어 주세요.';
    } finally { busy = false; browsing = false; }
  }

  // 서버가 내려갔다 다시 뜨기를 기다린다. 내려간 걸 못 봤어도 restartFirstUpMs 뒤에 응답하면 다시 켜진 걸로 본다.
  // restartGiveUpMs 안에 돌아오지 않으면 홈으로 가지 않고 안내를 낸다.
  async function waitRestart() {
    restarting = true; restartFailed = false;
    const start = Date.now();
    let sawDown = false;
    while (alive && Date.now() - start < restartGiveUpMs) {
      await new Promise((r) => setTimeout(r, restartPollMs));
      try {
        await api.health();
        if (sawDown || Date.now() - start >= restartFirstUpMs) { if (alive) onRestarted(); return; }
      } catch { sawDown = true; }
    }
    restarting = false;
    restartFailed = true;
  }

  async function connect() {
    if (!check?.ok) return;
    busy = true; error = '';
    try { await api.connectPortableSource(path.trim()); await waitRestart(); }
    catch (e) { error = e instanceof ApiError && e.code && REASONS.includes(e.code) ? checkMessage(e.code as Reason) : '연결하지 못했어요.'; }
    finally { busy = false; }
  }

  async function disconnect() {
    busy = true; error = '';
    try { await api.disconnectPortableSource(); await waitRestart(); }
    catch { error = '연결을 해제하지 못했어요.'; }
    finally { busy = false; confirmOff = false; }
  }
</script>

<main class="page appearance-page source-page" data-part="source">
  {#if !restarting}<nav><a href={hrefs.home}>← 서고</a></nav>{/if}
  <h1>원본 연결</h1>
  {#if restartFailed && !restarting}<p class="notice" role="alert">PAGE 가 다시 켜지지 않았어요. PAGE 창(검은 창)을 확인해 주세요.</p>{/if}
  {#if restarting}
    <p class="status" role="status">PAGE 를 다시 켜는 중… 잠시만 기다려 주세요.</p>
  {:else if failed}
    <p class="notice" role="alert">원본 연결 정보를 불러오지 못했어요.</p>
  {:else if info}
    <section>
      <h2>지금 상태</h2>
      {#if info.connected}
        <p>PocketRisu 연결됨 · <code>{info.connected.dir}</code>{#if info.connected.health?.status === 'degraded'} · 일부를 읽지 못하고 있어요{:else if info.connected.health && info.connected.health.status !== 'ok'} · 지금은 읽을 수 없어요{/if}</p>
        {#if confirmOff}
          <p>연결을 해제해도 서고에 들어온 책은 남아요.</p>
          <button type="button" disabled={busy} onclick={disconnect}>정말 해제</button>
          <button type="button" disabled={busy} onclick={() => (confirmOff = false)}>취소</button>
        {:else}
          <button type="button" disabled={busy} onclick={() => (confirmOff = true)}>연결 해제</button>
        {/if}
      {:else}
        <p>연결된 원본이 없어요. 가져오기(JSON)만 쓰고 있어요.</p>
      {/if}
    </section>
    <section>
      <h2>{info.connected ? '다른 폴더로 바꾸기' : 'PocketRisu 연결하기'}</h2>
      <p>PocketRisu 폴더(안에 save 폴더가 있는 곳)를 골라 주세요. PAGE 는 읽기만 하고 아무것도 쓰지 않아요.</p>
      {#if info.platform === 'win32'}<button type="button" disabled={busy} onclick={browse}>찾아보기</button>{/if}
      {#if browsing}<p class="status" role="status">폴더 선택 창을 열었어요. 작업 표시줄에서 찾을 수도 있어요.</p>{/if}
      <label>폴더 경로 <input name="source-path" type="text" disabled={busy} bind:value={path} oninput={() => { check = null; error = ''; }} /></label>
      <button type="button" disabled={busy || !path.trim()} onclick={runCheck}>확인</button>
      {#if check?.ok}
        <p role="status">PocketRisu 를 찾았어요 · <code>{check.saveDir}</code></p>
        <button type="button" disabled={busy} onclick={connect}>연결</button>
      {/if}
      {#if error}<p class="notice" role="alert">{error}</p>{/if}
    </section>
  {:else}
    <p class="status">불러오는 중…</p>
  {/if}
</main>
