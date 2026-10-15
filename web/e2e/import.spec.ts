// web/e2e/import.spec.ts — RisuAI 채팅 JSON 가져오기 (합성 JSON 만, 테스트 안에서 만든다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const exportJson = (id: string, title: string, texts: string[]) => ({
  type: 'risuChat', ver: 2,
  data: { id, name: title, lastDate: 1, message: texts.map((t, i) => ({ role: i % 2 ? 'char' : 'user', data: t })) },
});
const file = (name: string, json: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });

async function makeChar(request: APIRequestContext, name: string, chats: { id: string; title: string; texts: string[] }[]) {
  const { charId } = (await (await request.post('/api/import/chars', { data: { name } })).json()) as { charId: string };
  for (const c of chats) expect((await request.post(`/api/import/chars/${charId}/chats`, { data: exportJson(c.id, c.title, c.texts) })).ok()).toBe(true);
  return charId;
}

test('create a character with an image, upload two JSON files, read one from the library', async ({ page }) => {
  await page.goto('/#/import');
  await expect(page.getByRole('heading', { name: '가져오기' })).toBeVisible();
  await page.locator('#import-char-name').fill('합성 임포트');
  await page.locator('#import-char-image').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.locator('#import-file-input').setInputFiles([
    file('one.json', exportJson('i1', '합성 첫째', ['[i1-0] 첫째 채팅의 첫 줄', '[i1-1] 둘째 줄'])),
    file('two.json', exportJson('i2', '합성 둘째', ['[i2-0] 둘째 채팅의 첫 줄'])),
  ]);
  await page.getByRole('button', { name: '올리기' }).click();
  const results = page.getByRole('list', { name: '올리기 결과' });
  await expect(results.getByRole('listitem')).toHaveCount(2);
  await expect(results.getByRole('listitem').filter({ hasText: 'one.json' })).toContainText('새 채팅 1');
  await expect(results.getByRole('listitem').filter({ hasText: 'two.json' })).toContainText('새 채팅 1');
  await page.getByRole('link', { name: '서고에서 보기' }).click();
  await expect(page).toHaveURL(/#\/s\/imported\/c\//);
  await expect(page.getByRole('heading', { name: '합성 임포트' })).toBeVisible();
  await expect(page.getByText(/채팅 2권/)).toBeVisible();
  await page.getByRole('button', { name: '목록' }).click();
  await page.getByRole('link', { name: /합성 첫째/ }).click();
  await expect(page.locator('article[data-msg="0"]')).toContainText('[i1-0] 첫째 채팅의 첫 줄');
});

test('uploading the same chat again with one more message makes an update the reader shows', async ({ page, request }) => {
  const charId = await makeChar(request, '합성 갱신', [{ id: 'a', title: '합성 채팅', texts: ['[a-0] 처음', '[a-1] 둘째'] }]);
  await page.goto('/#/import');
  await expect(page.locator('#import-char-select')).toHaveValue(charId);
  await page.locator('#import-file-input').setInputFiles(file('again.json', exportJson('a', '합성 채팅', ['[a-0] 처음', '[a-1] 둘째', '[a-2] 새로 붙은 메시지'])));
  await page.getByRole('button', { name: '올리기' }).click();
  await expect(page.getByRole('list', { name: '올리기 결과' })).toContainText('갱신 1');
  await expect(page.locator('#import-file-input')).toHaveValue(''); // 같은 파일을 다시 고를 수 있다
  await page.goto(`/#/read/imported/${charId}/a`);
  await expect(page.locator('article[data-msg="2"]')).toContainText('[a-2] 새로 붙은 메시지');
});

test('deleting chats from the list removes them; the last one takes the character and returns home', async ({ page, request }) => {
  const charId = await makeChar(request, '합성 지우기', [
    { id: 'a', title: '합성 제목 A', texts: ['[a-0] 첫 줄'] },
    { id: 'b', title: '합성 제목 B', texts: ['[b-0] 첫 줄'] },
  ]);
  const bm = await request.post(`/api/state/bookmarks?source=imported&char=${charId}&chat=a`, {
    data: { kind: 'bookmark', start: { msgIdx: 0, blockIdx: 0, charOffset: 0, anchorHash: 'x' } },
  });
  expect(bm.status()).toBe(201);
  await page.goto(`/#/s/imported/c/${charId}`);
  const manage = page.getByRole('region', { name: '채팅 지우기' });
  await manage.getByRole('button', { name: '합성 제목 A 지우기', exact: true }).click();
  await manage.getByRole('button', { name: '합성 제목 A 정말 지우기' }).click();
  await expect(manage.getByText('합성 제목 A')).toHaveCount(0);
  await expect(manage.getByText('합성 제목 B')).toBeVisible();
  const marks = (await (await request.get(`/api/state/bookmarks?source=imported&char=${charId}&chat=a`)).json()) as { bookmarks: unknown[] };
  expect(marks.bookmarks).toEqual([]);

  await manage.getByRole('button', { name: '합성 제목 B 지우기', exact: true }).click();
  await manage.getByRole('button', { name: '합성 제목 B 정말 지우기' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('heading', { name: '서고' })).toBeVisible();
  expect(((await (await request.get('/api/import/chars')).json()) as { chars: unknown[] }).chars).toEqual([]);
  await expect(page.locator('.source-name')).toHaveCount(0);
});

test('the home shows the imported source by name next to the PocketRisu one, and hides it while empty', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.stacks .shelf-label', { hasText: 'Alice' })).toBeVisible();
  await expect(page.locator('.source-name')).toHaveCount(0); // 원본이 하나뿐인 지금 모양 그대로
  await makeChar(request, '합성 이웃', [{ id: 'n', title: '합성 이웃 채팅', texts: ['[n-0] 첫 줄'] }]);
  await page.goto('/');
  await expect(page.locator('.source-name', { hasText: '가져온 채팅' })).toBeVisible();
  await expect(page.locator('.source-name', { hasText: 'main' })).toBeVisible();
  await expect(page.locator('.shelf-label', { hasText: '합성 이웃' })).toBeVisible();
});

test('a file over 50MB is refused before anything is created, and a bad file leaves the new character with a hint', async ({ page, request }) => {
  await page.goto('/#/import');
  await page.locator('#import-char-name').fill('합성 큰 파일');
  // Playwright 는 50MB 넘는 버퍼를 받지 않으므로 임시 파일로 올린다
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'page-e2e-big-'));
  const big = path.join(tmp, 'big.json');
  fs.writeFileSync(big, Buffer.alloc(50 * 1024 * 1024 + 1, 0x20));
  try {
    await page.locator('#import-file-input').setInputFiles(big);
    await page.getByRole('button', { name: '올리기' }).click();
    await expect(page.getByRole('list', { name: '올리기 결과' })).toContainText('파일은 50MB 까지예요');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); } // 파일이 브라우저에 읽히는 동안은 지우지 않는다
  expect(((await (await request.get('/api/import/chars')).json()) as { chars: unknown[] }).chars).toEqual([]);

  await page.locator('#import-file-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"type":"nope"}') });
  await page.getByRole('button', { name: '올리기' }).click();
  await expect(page.getByRole('list', { name: '올리기 결과' })).toContainText('RisuAI 채팅 내보내기 파일(.json)이 아니에요');
  await expect(page.getByRole('alert').filter({ hasText: '캐릭터는 만들어졌어요' })).toBeVisible();
  expect(((await (await request.get('/api/import/chars')).json()) as { chars: { name: string }[] }).chars.map((c) => c.name)).toEqual(['합성 큰 파일']);
});
