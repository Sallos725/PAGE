// 내보내기 패널의 PDF 안내 — 포터블(PDF 사이드카 없음)일 때만 문구를 낸다.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ exportFormats: vi.fn(), app: vi.fn(), health: vi.fn() }));
vi.mock('../src/lib/api', async (orig) => {
  const m = await orig<typeof import('../src/lib/api')>();
  return { ...m, api: { ...m.api, ...fake } };
});
const { default: ExportPanel } = await import('../src/lib/reader/ExportPanel.svelte');

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } };
const NOTE = 'PDF 는 Docker 판에서 만들 수 있어요';

beforeEach(() => { target = document.createElement('div'); document.body.appendChild(target); Object.values(fake).forEach((f) => f.mockReset()); });
afterEach(() => { if (app) unmount(app); app = null; target.remove(); });

async function open(formats: string[], portable: boolean | 'fail') {
  fake.exportFormats.mockResolvedValue({ formats });
  if (portable === 'fail') fake.app.mockRejectedValue(new Error('x'));
  else fake.app.mockResolvedValue({ app: 'page', portable });
  app = mount(ExportPanel, { target, props: { source: 's', char: 'c', chat: 'h', hideRules: [], imageRules: [], hideUser: false, onClose: () => {} } });
  await settle();
}

describe('내보내기 PDF 안내', () => {
  it('포터블이고 PDF 가 없으면 안내', async () => {
    await open(['json', 'epub'], true);
    expect(target.textContent).toContain(NOTE);
    expect(target.querySelector('input[value="pdf"]')).toBeNull();
    expect(fake.health).not.toHaveBeenCalled(); // 어댑터를 거치는 health 는 부르지 않는다
  });
  it('포터블이 아니면 안내 없음', async () => {
    await open(['json', 'epub'], false);
    expect(target.textContent).not.toContain(NOTE);
  });
  it('/api/app 을 못 받으면 안내 없음', async () => {
    await open(['json', 'epub'], 'fail');
    expect(target.textContent).not.toContain(NOTE);
  });
  it('PDF 를 만들 수 있으면 선택지만', async () => {
    await open(['json', 'epub', 'pdf'], true);
    expect(target.querySelector('input[value="pdf"]')).toBeTruthy();
    expect(target.textContent).not.toContain(NOTE);
  });
});
