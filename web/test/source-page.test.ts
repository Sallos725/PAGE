// 원본 연결 화면 (Source.svelte) — api 를 가짜로. 경로는 합성.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  portableSource: vi.fn(), checkPortableSource: vi.fn(), connectPortableSource: vi.fn(),
  disconnectPortableSource: vi.fn(), browsePortable: vi.fn(), health: vi.fn(),
}));
vi.mock('../src/lib/api', async (orig) => {
  const m = await orig<typeof import('../src/lib/api')>();
  return { ...m, api: { ...m.api, ...fake } };
});
const { default: Source } = await import('../src/lib/pages/Source.svelte');
const { ApiError } = await import('../src/lib/api');

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } };
const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
const text = () => target.textContent ?? '';
function type(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); }

beforeEach(() => { target = document.createElement('div'); document.body.appendChild(target); Object.values(fake).forEach((f) => f.mockReset()); });
afterEach(() => { if (app) unmount(app); app = null; target.remove(); });

type Props = { restartPollMs?: number; restartGiveUpMs?: number; restartFirstUpMs?: number; onRestarted?: () => void };
async function open(platform = 'win32', connected: unknown = null, props: Props = {}) {
  fake.portableSource.mockResolvedValue({ connected, platform });
  app = mount(Source, { target, props: { restartPollMs: 1, restartGiveUpMs: 50, restartFirstUpMs: 20, onRestarted: () => {}, ...props } });
  await settle();
}
const pathInput = () => target.querySelector<HTMLInputElement>('input[name="source-path"]')!;
/** 경로를 넣고 확인 → 판별 성공 → 연결 버튼까지. */
async function checkOk() {
  fake.checkPortableSource.mockResolvedValue({ ok: true, kind: 'pocketrisu', saveDir: 'C:\\합성\\save' });
  type(pathInput(), 'C:\\합성');
  button('확인')!.click(); await settle();
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('원본 연결 화면', () => {
  it('Windows 면 찾아보기 버튼, 아니면 없음', async () => {
    await open('win32');
    expect(button('찾아보기')).toBeTruthy();
    unmount(app!); app = null;
    await open('linux');
    expect(button('찾아보기')).toBeUndefined();
  });
  it('찾아보기 → 경로 칸 채우고 판별 결과 표시', async () => {
    await open();
    fake.browsePortable.mockResolvedValue({ path: 'C:\\합성\\PocketRisu' });
    fake.checkPortableSource.mockResolvedValue({ ok: true, kind: 'pocketrisu', saveDir: 'C:\\합성\\PocketRisu\\save' });
    button('찾아보기')!.click();
    await settle();
    expect(target.querySelector<HTMLInputElement>('input[name="source-path"]')!.value).toBe('C:\\합성\\PocketRisu');
    expect(text()).toContain('PocketRisu 를 찾았어요');
    expect(button('연결')).toBeTruthy();
  });
  it('판별 실패 문구, 연결 버튼 없음', async () => {
    await open();
    fake.checkPortableSource.mockResolvedValue({ ok: false, reason: 'not-found' });
    type(target.querySelector<HTMLInputElement>('input[name="source-path"]')!, 'C:\\합성');
    button('확인')!.click();
    await settle();
    expect(target.querySelector('[role="alert"]')!.textContent).toContain('찾지 못했어요');
    expect(button('연결')).toBeUndefined();
  });
  it('연결 → 다시 켜는 중 → health 가 돌아오면 홈으로', async () => {
    await open();
    fake.checkPortableSource.mockResolvedValue({ ok: true, kind: 'pocketrisu', saveDir: 'C:\\합성\\save' });
    fake.connectPortableSource.mockResolvedValue({ restarting: true });
    fake.health.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ app: 'page', portable: true, sources: [] });
    const go = vi.fn();
    unmount(app!);
    fake.portableSource.mockResolvedValue({ connected: null, platform: 'win32' });
    app = mount(Source, { target, props: { restartPollMs: 1, restartGiveUpMs: 50, onRestarted: go } });
    await settle();
    type(target.querySelector<HTMLInputElement>('input[name="source-path"]')!, 'C:\\합성');
    button('확인')!.click(); await settle();
    button('연결')!.click(); await settle();
    expect(text()).toContain('다시 켜는 중');
    await new Promise((r) => setTimeout(r, 30)); await settle();
    expect(go).toHaveBeenCalled();
  });
  it('연결돼 있으면 경로·상태와 연결 해제(확인 한 번)', async () => {
    const go = vi.fn();
    await open('win32', { dir: 'C:\\합성\\save', health: { status: 'ok' } }, { onRestarted: go });
    expect(text()).toContain('C:\\합성\\save');
    button('연결 해제')!.click(); flushSync();
    expect(fake.disconnectPortableSource).not.toHaveBeenCalled();
    fake.disconnectPortableSource.mockResolvedValue({ restarting: true });
    fake.health.mockResolvedValue({ app: 'page', portable: true, sources: [] });
    button('정말 해제')!.click(); await settle();
    expect(fake.disconnectPortableSource).toHaveBeenCalled();
    await wait(40); await settle();
    expect(go).toHaveBeenCalled();
  });
  it('서버가 안 내려간 채 health 가 계속 성공하면 정해진 시간 전에는 홈으로 가지 않음', async () => {
    const go = vi.fn();
    await open('win32', null, { onRestarted: go, restartFirstUpMs: 1000, restartGiveUpMs: 5000 });
    fake.connectPortableSource.mockResolvedValue({ restarting: true });
    fake.health.mockResolvedValue({ app: 'page', portable: true, sources: [] });
    await checkOk();
    button('연결')!.click(); await settle();
    await wait(40); await settle();
    expect(fake.health).toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(text()).toContain('다시 켜는 중');
    expect(target.querySelector('a[href="#/"]')).toBeNull();
  });
  it('끝내 다시 켜지지 않으면 홈으로 가지 않고 안내', async () => {
    const go = vi.fn();
    await open('win32', null, { onRestarted: go, restartGiveUpMs: 30 });
    fake.connectPortableSource.mockResolvedValue({ restarting: true });
    fake.health.mockRejectedValue(new Error('down'));
    await checkOk();
    button('연결')!.click(); await settle();
    await wait(60); await settle();
    expect(go).not.toHaveBeenCalled();
    expect(text()).not.toContain('다시 켜는 중');
    expect(target.querySelector('[role="alert"]')!.textContent).toContain('PAGE 가 다시 켜지지 않았어요');
    expect(target.querySelector('a[href="#/"]')).toBeTruthy();
  });
  it('연결(PUT) 실패 이유를 문구로', async () => {
    await open();
    fake.connectPortableSource.mockRejectedValue(new ApiError(400, 'unreadable'));
    await checkOk();
    button('연결')!.click(); await settle();
    expect(target.querySelector('[role="alert"]')!.textContent).toContain('권한');
    expect(fake.health).not.toHaveBeenCalled();
  });
  it('degraded 면 일부를 읽지 못한다고, 그 밖은 읽을 수 없다고', async () => {
    await open('win32', { dir: 'C:\\합성\\save', health: { status: 'degraded' } });
    expect(text()).toContain('일부를 읽지 못하고 있어요');
    unmount(app!); app = null;
    await open('win32', { dir: 'C:\\합성\\save', health: { status: 'unavailable' } });
    expect(text()).toContain('지금은 읽을 수 없어요');
    expect(text()).not.toContain('일부를');
  });
  it('찾아보기 중에는 안내를 보이고 경로 칸을 잠금', async () => {
    await open();
    let done!: (v: unknown) => void;
    fake.browsePortable.mockReturnValue(new Promise((r) => { done = r; }));
    button('찾아보기')!.click(); await settle();
    expect(text()).toContain('폴더 선택 창을 열었어요');
    expect(pathInput().disabled).toBe(true);
    done({ cancelled: true }); await settle();
    expect(text()).not.toContain('폴더 선택 창을 열었어요');
    expect(pathInput().disabled).toBe(false);
  });
  it('판별 응답이 왔을 때 경로가 바뀌었으면 결과를 버림', async () => {
    await open();
    let done!: (v: unknown) => void;
    fake.checkPortableSource.mockReturnValue(new Promise((r) => { done = r; }));
    type(pathInput(), 'C:\\합성');
    button('확인')!.click(); await settle();
    expect(pathInput().disabled).toBe(true);
    // 잠긴 칸이라도 코드로 값이 바뀐 경우를 흉내 낸다
    type(pathInput(), 'C:\\다른');
    done({ ok: true, kind: 'pocketrisu', saveDir: 'C:\\합성\\save' }); await settle();
    expect(button('연결')).toBeUndefined();
    expect(text()).not.toContain('PocketRisu 를 찾았어요');
  });
});
