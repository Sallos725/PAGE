// 가져오기 화면 (Import.svelte) — api 를 가짜로 바꿔 화면 동작만 본다. 데이터는 합성.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportChar } from '../src/lib/types';

const fake = vi.hoisted(() => ({
  importChars: vi.fn(),
  createImportChar: vi.fn(),
  renameImportChar: vi.fn(),
  setImportCharImage: vi.fn(),
  deleteImportCharImage: vi.fn(),
  importChats: vi.fn(),
  deleteImportChar: vi.fn(),
}));
vi.mock('../src/lib/api', async (orig) => {
  const m = await orig<typeof import('../src/lib/api')>();
  return { ...m, api: { ...m.api, ...fake } };
});
const { ApiError } = await import('../src/lib/api');
const { default: Import } = await import('../src/lib/pages/Import.svelte');

const OK: ImportChar = { charId: 'a'.repeat(32), name: '합성 캐릭터', hasImage: false, chatCount: 1 };
const BROKEN: ImportChar = { charId: 'b'.repeat(32), name: '', broken: true, hasImage: false, chatCount: 2 };
const json = (name: string) => new File(['{"type":"risuChat","ver":2,"data":{"message":[]}}'], name, { type: 'application/json' });
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'face.png', { type: 'image/png' });

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); flushSync(); } };
async function open(chars: ImportChar[]) {
  fake.importChars.mockResolvedValue(chars);
  app = mount(Import, { target });
  await settle();
}
const $ = <T extends Element>(sel: string) => target.querySelector<T>(sel);
const buttons = (scope: ParentNode = target) => Array.from(scope.querySelectorAll('button'));
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
const alerts = () => Array.from(target.querySelectorAll('[role="alert"]')).map((e) => e.textContent ?? '').join('\n');

beforeEach(() => {
  for (const f of Object.values(fake)) f.mockReset();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
});

describe('Import page: characters whose info file is broken', () => {
  it('shows them as unreadable with only a delete button, and leaves them out of the upload targets', async () => {
    await open([OK, BROKEN]);
    const options = Array.from($<HTMLSelectElement>('#import-char-select')!.options).map((o) => o.value);
    expect(options).toEqual([OK.charId, 'new']);
    const items = Array.from(target.querySelectorAll('section[aria-labelledby="import-manage"] li.item'));
    expect(items).toHaveLength(2);
    const broken = items[1]!;
    expect(broken.textContent).toContain('읽을 수 없는 캐릭터');
    expect(broken.textContent).toContain('정보 파일이 손상됐어요');
    expect(broken.querySelector('a')).toBeNull(); // 서고 링크도 없다
    expect(broken.querySelector('input')).toBeNull(); // 그림 바꾸기 없음
    expect(buttons(broken).map((b) => b.textContent?.trim())).toEqual(['지우기']);
    expect(buttons(items[0]!).map((b) => b.textContent?.trim())).toEqual(['이름 바꾸기', '지우기']);
  });

  it('deletes a broken character with the usual two-step confirmation', async () => {
    await open([OK, BROKEN]);
    fake.deleteImportChar.mockResolvedValue(undefined);
    const broken = () => Array.from(target.querySelectorAll('section[aria-labelledby="import-manage"] li.item'))[1]!;
    buttons(broken())[0]!.click();
    flushSync();
    expect(fake.deleteImportChar).not.toHaveBeenCalled();
    expect(broken().textContent).toContain('채팅 2개');
    fake.importChars.mockResolvedValue([OK]);
    buttons(broken()).find((b) => b.textContent?.trim() === '정말 지우기')!.click();
    await settle();
    expect(fake.deleteImportChar).toHaveBeenCalledWith(BROKEN.charId);
    expect(target.querySelectorAll('section[aria-labelledby="import-manage"] li.item')).toHaveLength(1);
  });

  it('does not pick a broken character as the default upload target', async () => {
    await open([BROKEN]);
    expect($<HTMLSelectElement>('#import-char-select')!.value).toBe('new');
    expect(Array.from($<HTMLSelectElement>('#import-char-select')!.options).map((o) => o.value)).toEqual(['new']);
  });
});

describe('Import page: upload', () => {
  it('keeps the chosen files when the new character could not be created, and sends them on the retry', async () => {
    await open([]);
    type($<HTMLInputElement>('#import-char-name')!, '합성 새 캐릭터');
    pick($<HTMLInputElement>('#import-file-input')!, [json('one.json')]);
    fake.createImportChar.mockRejectedValueOnce(new ApiError(500));
    button('올리기').click();
    await settle();
    expect(alerts()).toContain('캐릭터를 만들지 못했어요.');
    expect(fake.importChats).not.toHaveBeenCalled();
    expect(button('올리기').disabled).toBe(false); // 고른 파일이 남아 있다

    fake.createImportChar.mockResolvedValueOnce(OK.charId);
    fake.importChats.mockResolvedValue({ results: [{ chatId: 'x', title: 't', messages: 1, status: 'new' }] });
    fake.importChars.mockResolvedValue([OK]);
    button('올리기').click();
    await settle();
    expect(fake.importChats).toHaveBeenCalledTimes(1);
    expect(fake.importChats.mock.calls[0]![0]).toBe(OK.charId);
    expect(button('올리기').disabled).toBe(true); // 실제로 올렸으니 비웠다
  });

  it('keeps the chosen files when the new name is too long', async () => {
    await open([]);
    type($<HTMLInputElement>('#import-char-name')!, '가'.repeat(61));
    pick($<HTMLInputElement>('#import-file-input')!, [json('one.json')]);
    button('올리기').click();
    await settle();
    expect(alerts()).toContain('이름은 60자까지예요.');
    expect(fake.createImportChar).not.toHaveBeenCalled();
    expect(button('올리기').disabled).toBe(false);
  });

  it('shows both the image error and the "character was created" hint when every file fails', async () => {
    await open([]);
    type($<HTMLInputElement>('#import-char-name')!, '합성 새 캐릭터');
    pick($<HTMLInputElement>('#import-char-image')!, [png()]);
    pick($<HTMLInputElement>('#import-file-input')!, [json('bad.json')]);
    fake.createImportChar.mockResolvedValue(OK.charId);
    fake.setImportCharImage.mockRejectedValue(new ApiError(400, 'bad-image'));
    fake.importChats.mockRejectedValue(new ApiError(400, 'unsupported-format'));
    fake.importChars.mockResolvedValue([OK]);
    button('올리기').click();
    await settle();
    const text = alerts();
    expect(text).toContain('그림은 PNG·JPEG·WebP 만 쓸 수 있어요.');
    expect(text).toContain('캐릭터는 만들어졌어요. 다른 파일을 올려 보세요.');
  });
});
