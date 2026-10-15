import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { resetState } from './helpers';

test.beforeEach(async ({ request }) => { await resetState(request); });

test('export the open chat as RisuAI JSON and download it', async ({ page }) => {
  await page.goto('/#/read/main/c1/face');
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '내보내기' }).click(); // 내보내기는 보기 설정 패널 안에 있다 (아이폰 제목 칸 때문에 상단 바에서 옮김)
  const dlg = page.getByRole('dialog', { name: '내보내기' });
  await dlg.getByLabel('RisuAI 가져오기용 (JSON)').check();
  const [post] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/export?')),
    dlg.getByRole('button', { name: '만들기' }).click(),
  ]);
  expect(typeof post.postDataJSON().version).toBe('number'); // 리더가 고정한 버전으로 만든다
  const link = dlg.getByRole('link', { name: '다운로드' });
  await expect(link).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(dl.suggestedFilename()).toMatch(/^page-\d{8}-[0-9a-f]{8}\.json$/);
  const body = JSON.parse(fs.readFileSync((await dl.path())!, 'utf8'));
  expect(body).toMatchObject({ type: 'risuChat', ver: 2, folders: [] });
  expect(body.data.message).toHaveLength(2);
});

test('export the open chat as EPUB with the card image rule unchecked', async ({ page }) => {
  await page.goto('/#/read/main/c1/face');
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '내보내기' }).click();
  const dlg = page.getByRole('dialog', { name: '내보내기' });
  await expect(dlg.getByLabel('책 (EPUB)')).toBeChecked();
  const rule = dlg.getByLabel('카드 그림: 합성 표정');
  await expect(rule).toBeChecked(); // 리더에서 켜진 규칙이 기본 체크
  await rule.uncheck();
  await dlg.getByRole('button', { name: '만들기' }).click();
  const link = dlg.getByRole('link', { name: '다운로드' });
  await expect(link).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(dl.suggestedFilename()).toMatch(/^page-\d{8}-[0-9a-f]{8}\.epub$/);
  const bytes = fs.readFileSync((await dl.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(bytes.subarray(30, 38).toString()).toBe('mimetype');
});

// zip 안 파일 이름은 압축되지 않는다 — 다운로드 바이트를 latin1 문자열로 훑어 OEBPS/images/ 아래 이름을 모은다. (이름 바로 뒤에 다음 헤더의 `PK` 가 붙으므로 확장자까지만 잡는다.)
function imageEntryNames(bytes: Buffer): string[] {
  const names = bytes.toString('latin1').match(/OEBPS\/images\/[A-Za-z0-9_-]+\.(?:webp|jpe?g|png|gif)/g) ?? [];
  return [...new Set(names)];
}

async function exportEpubWithImageMode(page: Page, modeLabel?: string): Promise<Buffer> {
  await page.goto('/#/read/main/c1/face');
  await page.getByRole('button', { name: '보기 설정' }).click();
  await page.getByRole('button', { name: '내보내기' }).click();
  const dlg = page.getByRole('dialog', { name: '내보내기' });
  await expect(dlg.getByLabel('책 (EPUB)')).toBeChecked();
  await expect(dlg.getByLabel('카드 그림: 합성 표정')).toBeChecked(); // 카드 그림 규칙이 켜져 있어야 face 채팅에 그림이 들어간다
  if (modeLabel) await dlg.getByLabel(modeLabel).check();
  await dlg.getByRole('button', { name: '만들기' }).click();
  const link = dlg.getByRole('link', { name: '다운로드' });
  await expect(link).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  return fs.readFileSync((await dl.path())!);
}

test('EPUB image size: default (줄이기) stores WebP images', async ({ page }) => {
  const bytes = await exportEpubWithImageMode(page);
  const names = imageEntryNames(bytes);
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n.endsWith('.webp'))).toBe(true);
});

test('EPUB image size: 호환 우선 stores JPEG images', async ({ page }) => {
  const bytes = await exportEpubWithImageMode(page, '호환 우선 (킨들 등 전자잉크 기기에 최적화)');
  const names = imageEntryNames(bytes);
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n.endsWith('.jpg'))).toBe(true);
});

test('EPUB image size: 원본 keeps the source format (PNG)', async ({ page }) => {
  const bytes = await exportEpubWithImageMode(page, '원본');
  const names = imageEntryNames(bytes);
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n.endsWith('.png'))).toBe(true);
});

test('export panel hides PDF (A5) when the server has no PDF sidecar', async ({ page }) => {
  await page.goto('/#/read/main/c1/face');
  await page.getByRole('button', { name: '보기 설정' }).click();
  const formats = page.waitForResponse((r) => r.url().includes('/api/export/formats'));
  await page.getByRole('button', { name: '내보내기' }).click();
  const res = await formats; // 형식 목록 응답을 받은 뒤에 PDF 가 없음을 확인한다
  expect((await res.json()).formats).toEqual(['json', 'epub']);
  const dlg = page.getByRole('dialog', { name: '내보내기' });
  await expect(dlg.getByLabel('책 (EPUB)')).toBeVisible();
  await expect(dlg.getByText('PDF (A5)')).toHaveCount(0);
});
