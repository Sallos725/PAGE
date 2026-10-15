import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/export/epub/images.js';
import { DEFAULT_EPUB_OPTIONS, produceEpub, renderMessage, type EpubOptions } from '../src/export/epub/produce.js';
import { chatVersion } from '../src/export/source.js';
import { StateStore } from '../src/state/store.js';
import { AM, PNG_1X1, chat, msg } from '../src/tools/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

// 기존 테스트는 1x1 바이트를 그대로 확인하므로 original. 변환 모드는 아래 'image modes' 에서 따로 본다.
const ALL: EpubOptions = { includeUser: true, cover: true, cardImages: true, chatImages: true, hideRuleIds: [], imageRuleKeys: [], imageMode: 'original' };

async function setup() {
  const h = makeHarness({
    spec: {
      characters: [{
        chaId: 'c1', name: 'Alice', image: 'assets/alice.png',
        chats: [{ id: 'e1', name: '합성 책', message: [
          msg('user', '[u0] 안녕 <st>HP 1</st>'),
          msg('char', `[c1] 웃었다 <표정=웃음> 끝\n{{raw::${AM(1)}}}\n{{raw::없는그림}}\n{{raw::이상한형식}}`),
          msg('user', '[u2] 다음'),
        ] }, chat('e2', ['x'])],
        customscript: [{ comment: '합성 표정', in: '<표정=([^>]+)>', out: '<img src="{{raw::$1}}">', type: 'editdisplay' }],
      }],
      manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png'], ['웃음', 'assets/smile.png', 'png'], ['이상한형식', 'assets/odd.bin', 'bin']] }],
      assets: { 'assets/p1.png': PNG_1X1, 'assets/smile.png': PNG_1X1, 'assets/alice.png': PNG_1X1, 'assets/odd.bin': new Uint8Array([1, 2, 3, 4]) },
    },
  });
  await h.sync();
  const state = new StateStore(h.dataDir);
  const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
  const ruleKey = (h.store.getCharMeta('main', 'c1')!.imageRules as { key: string }[])[0]!.key;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
  const run = async (opts: Partial<EpubOptions>) => {
    const r = await produceEpub({ store: h.store, state, kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now }, { ...ALL, ...opts }, tmp);
    const files = unzipSync(new Uint8Array(fs.readFileSync(tmp)));
    const text = Object.entries(files).filter(([n]) => n.startsWith('OEBPS/chapter-')).map(([, b]) => strFromU8(b)).join('');
    return { r, files, text };
  };
  return { state, run, ruleKey };
}

describe('produceEpub', () => {
  it('renders all messages, applies chosen rules, embeds deduped images and the cover, and counts what it skipped', async () => {
    const { state, run, ruleKey } = await setup();
    const rule = state.addHideRule('main', { scope: 'char', charId: 'c1', name: '상태창', pattern: '<st>[\\s\\S]*?</st>', flags: 'g', enabled: true, origin: 'manual' }, 1);
    const { r, files, text } = await run({ hideRuleIds: [rule.id], imageRuleKeys: [ruleKey] });
    expect(text).toContain('[u0] 안녕');
    expect(text).not.toContain('HP 1');
    expect(text).not.toContain('&lt;표정');
    expect(text).toContain('[c1] 웃었다');
    expect(text.match(/<img src="images\/[0-9a-f]{16}\.png" alt=""\/>/g)).toHaveLength(2); // 웃음 + AM 그림 (같은 바이트라도 이름마다 한 번씩 참조)
    expect(Object.keys(files).filter((n) => /^OEBPS\/images\/[0-9a-f]{16}\.png$/.test(n))).toHaveLength(1); // 같은 바이트 → 파일 하나
    expect(files['OEBPS/images/cover.png']).toBeDefined();
    expect(r.warnings).toEqual({ missingImages: 1, skippedImages: 1, slowRules: [] });
  });

  it('honours toggles: no user messages, no card images, no chat images, no cover; unchosen rules are not applied', async () => {
    const { run } = await setup();
    const { files, text } = await run({ includeUser: false, cardImages: false, chatImages: false, cover: false });
    expect(text).not.toContain('[u0]');
    expect(text).not.toContain('[u2]');
    expect(text).toContain('&lt;표정=웃음&gt;'); // 카드 그림 규칙을 고르지 않음 → 태그가 글자로 남는다
    expect(text).not.toContain('<img');
    expect(files['OEBPS/cover.xhtml']).toBeUndefined();
  });

  it('falls back to one escaped paragraph when a message fails to parse or render', () => {
    const href = () => null;
    const boom = () => { throw new Error('parse failed'); };
    const out = renderMessage('char', 'a <b> & c', ALL, href, boom);
    expect(out).toBe('<div class="msg char"><p>a &lt;b&gt; &amp; c</p></div>');
    // 정상 경로는 같은 입력을 파서로 처리한다
    expect(renderMessage('char', 'plain', ALL, href)).toContain('<p>plain</p>');
  });

  it('survives a missing blob file: counts it once, other images still render, and a missing cover blob means no cover', async () => {
    const PNG_B = Buffer.concat([PNG_1X1, Buffer.from([0])]); // 다른 해시, 같은 형식
    const PNG_C = Buffer.concat([PNG_1X1, Buffer.from([1])]);
    const h = makeHarness({
      spec: {
        characters: [{
          chaId: 'c1', name: 'Alice', image: 'assets/alice.png',
          chats: [{ id: 'e1', name: '합성 책', message: [
            msg('char', `[c1] 앞\n{{raw::${AM(1)}}}\n{{raw::살아있음}}`),
            msg('char', `[c2] 뒤\n{{raw::${AM(1)}}}\n{{raw::살아있음}}`),
          ] }],
        }],
        manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/gone.png', 'png'], ['살아있음', 'assets/alive.png', 'png']] }],
        assets: { 'assets/gone.png': PNG_B, 'assets/alive.png': PNG_C, 'assets/alice.png': PNG_1X1 },
      },
    });
    await h.sync();
    const state = new StateStore(h.dataDir);
    const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
    const ctx = { store: h.store, state, kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now };
    const read = () => unzipSync(new Uint8Array(fs.readFileSync(tmp)));

    fs.rmSync(h.store.blobPath(h.store.findAssetHash('main', 'c1', AM(1))!));
    const r1 = await produceEpub(ctx, ALL, tmp);
    const files1 = read();
    const text1 = Object.entries(files1).filter(([n]) => n.startsWith('OEBPS/chapter-')).map(([, b]) => strFromU8(b)).join('');
    expect(r1.warnings).toEqual({ missingImages: 1, skippedImages: 0, slowRules: [] }); // 이름당 한 번
    expect(text1).toContain('[c1] 앞');
    expect(text1).toContain('[c2] 뒤');
    expect(text1.match(/<img /g)).toHaveLength(2); // 살아있는 그림은 두 메시지 모두 그대로
    expect(files1['OEBPS/images/cover.png']).toBeDefined();

    fs.rmSync(h.store.blobPath(h.store.getCharImage('main', 'c1')!.hash!));
    const r2 = await produceEpub(ctx, ALL, tmp);
    const files2 = read();
    expect(files2['OEBPS/images/cover.png']).toBeUndefined();
    expect(files2['OEBPS/cover.xhtml']).toBeUndefined();
    expect(r2.warnings.missingImages).toBe(1);
  });

  it('names chapters like the reader: window + 1, with (이어서) for later parts of a split window', async () => {
    const big = 'ㄱ'.repeat(11_000);
    const message = [...Array.from({ length: 3 }, (_, i) => msg('char', `${big}${i}`)), ...Array.from({ length: 40 }, (_, i) => msg('char', `m${i}`))];
    const h = makeHarness({ spec: { characters: [{ chaId: 'c1', name: 'Alice', chats: [{ id: 'e1', name: '합성 책', message }] }] } });
    await h.sync();
    const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
    await produceEpub({ store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now }, { ...ALL, cover: false }, tmp);
    const titles = Object.entries(unzipSync(new Uint8Array(fs.readFileSync(tmp)))).filter(([n]) => n.startsWith('OEBPS/chapter-')).sort(([a], [b]) => a.localeCompare(b)).map(([, b]) => /<title>([^<]*)<\/title>/.exec(strFromU8(b))![1]);
    expect(titles).toEqual(['1장', '1장 (이어서)', '2장']);
  });
});

const hasJava = spawnSync('java', ['-version']).status === 0;

describe('produceEpub image modes (X8)', () => {
  const gradient = (w: number, h: number, seed: number) => {
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; raw[o] = (x + seed) & 255; raw[o + 1] = (y * 2 + seed) & 255; raw[o + 2] = ((x + y) >> 1) & 255; }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  };
  const transparent = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

  /** names: 메시지에 나오는 순서. assets: 이름 → 그림 바이트. */
  async function run(names: string[], assets: Record<string, Uint8Array>, cover: Uint8Array, opts: Partial<EpubOptions>, imageBudgetBytes?: number) {
    const kv: Record<string, Uint8Array> = { 'assets/cover.png': cover };
    for (const n of Object.keys(assets)) kv[`assets/${n}.png`] = assets[n]!;
    const h = makeHarness({
      spec: {
        characters: [{ chaId: 'c1', name: 'Alice', image: 'assets/cover.png', chats: [{ id: 'e1', name: '합성 책', message: names.map((n, i) => msg('char', `[m${i}]\n{{raw::${n}}}`)) }] }],
        manifests: [{ kind: 'character', ownerId: 'c1', items: Object.keys(assets).map((n) => [n, `assets/${n}.png`, 'png'] as [string, string, string]) }],
        assets: kv,
      },
    });
    await h.sync();
    const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
    const r = await produceEpub({ store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now, imageBudgetBytes }, { ...DEFAULT_EPUB_OPTIONS, ...opts }, tmp);
    const files = unzipSync(new Uint8Array(fs.readFileSync(tmp)));
    const images = Object.keys(files).filter((n) => /^OEBPS\/images\/[0-9a-f]{16}\./.test(n));
    return { r, files, images, tmp };
  }

  it('defaults to small: images and cover become WebP', async () => {
    expect(DEFAULT_EPUB_OPTIONS.imageMode).toBe('small');
    const { files, images } = await run(['a'], { a: await transparent(2400, 1200) }, await transparent(50, 50), {});
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/\.webp$/);
    expect(files['OEBPS/images/cover.webp']).toBeDefined();
    expect(strFromU8(files['OEBPS/content.opf']!)).toMatch(/href="images\/[0-9a-f]{16}\.webp" media-type="image\/webp"/);
    expect((await sharp(files[images[0]!]!).metadata()).width).toBe(1600);
  });

  it('compat gives JPEG (.jpg), original keeps the source extension', async () => {
    const c = await run(['a'], { a: await transparent(300, 300) }, await transparent(50, 50), { imageMode: 'compat' });
    expect(c.images[0]).toMatch(/\.jpg$/);
    expect(c.files['OEBPS/images/cover.jpg']).toBeDefined();
    expect(strFromU8(c.files['OEBPS/content.opf']!)).toMatch(/media-type="image\/jpeg"/);
    const o = await run(['a'], { a: await transparent(300, 300) }, await transparent(50, 50), { imageMode: 'original' });
    expect(o.images[0]).toMatch(/\.png$/);
    expect(o.files['OEBPS/images/cover.png']).toBeDefined();
  });

  it('counts the budget on converted size, in first-appearance order even when a later image converts faster', async () => {
    const big = await gradient(1500, 1500, 0);
    const tiny = await gradient(16, 16, 7);
    const sBig = (await convertImage(big, 'image/png', 'small'))!.bytes.length;
    const sTiny = (await convertImage(tiny, 'image/png', 'small'))!.bytes.length;
    expect(sBig).toBeLessThan(big.length); // 변환 뒤가 더 작다
    // 큰 그림이 먼저 나오고 빨리 끝나는 작은 그림이 뒤에 나온다. 한도는 큰 그림은 들어가고 작은 그림은 못 들어가는 크기.
    const a = await run(['big', 'tiny'], { big, tiny }, await transparent(8, 8), { cover: false }, sBig + Math.floor(sTiny / 2));
    expect(a.images).toHaveLength(1);
    expect(a.files[a.images[0]!]!.length).toBe(sBig); // 먼저 나온 큰 그림이 남고 뒤의 작은 그림이 빠진다
    expect(a.r.warnings).toEqual({ missingImages: 0, skippedImages: 1, slowRules: [] });
    // 변환 뒤 크기 기준이라 small 은 들어가지만 같은 한도에서 original(원본 크기)은 넘는다
    const b = await run(['big'], { big }, await transparent(8, 8), { cover: false }, sBig + 1);
    expect(b.images).toHaveLength(1);
    const c = await run(['big'], { big }, await transparent(8, 8), { cover: false, imageMode: 'original' }, sBig + 1);
    expect(c.images).toHaveLength(0);
    expect(c.r.warnings.skippedImages).toBe(1);
  });

  it('counts an image that fails to convert as skipped once per name, keeps going, and drops a cover that fails', async () => {
    const bad = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG 처럼 보이지만 깨졌다
    const { r, images, files } = await run(['bad', 'ok'], { bad, ok: await transparent(40, 40) }, bad, {});
    expect(images).toHaveLength(1);
    expect(r.warnings).toEqual({ missingImages: 0, skippedImages: 1, slowRules: [] });
    expect(Object.keys(files).some((n) => n.startsWith('OEBPS/images/cover.'))).toBe(false);
  });

  it('never starts converting image i before image i-4 is settled, even when image 0 is the slowest (bounded memory)', async () => {
    const N = 10;
    const names = Array.from({ length: N }, (_, i) => `n${i}`);
    const kv: Record<string, Uint8Array> = {};
    for (let i = 0; i < N; i++) kv[`assets/n${i}.png`] = Buffer.concat([PNG_1X1, Buffer.from([i])]); // 해시마다 다르다
    const h = makeHarness({
      spec: {
        characters: [{ chaId: 'c1', name: 'Alice', chats: [{ id: 'e1', name: '합성 책', message: names.map((n, i) => msg('char', `[m${i}]\n{{raw::${n}}}`)) }] }],
        manifests: [{ kind: 'character', ownerId: 'c1', items: names.map((n) => [n, `assets/${n}.png`, 'png'] as [string, string, string]) }],
        assets: kv,
      },
    });
    await h.sync();
    const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const convert: typeof convertImage = async (bytes, mime) => {
      started++;
      if (bytes[bytes.length - 1] === 0) await gate; // 0 번 그림은 마지막에 끝난다
      return { bytes, mime, ext: 'png' };
    };
    const done = produceEpub({ store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now, convert }, { ...ALL, cover: false }, tmp);
    await new Promise((r) => setTimeout(r, 200)); // 풀이 멈출 때까지
    expect(started).toBe(4); // 0..3 만 시작했다. 4 번 이후는 0 번이 확정될 때까지 기다린다
    release();
    const { warnings } = await done;
    expect(started).toBe(N);
    expect(warnings).toEqual({ missingImages: 0, skippedImages: 0, slowRules: [] });
    expect(Object.keys(unzipSync(new Uint8Array(fs.readFileSync(tmp)))).filter((n) => n.startsWith('OEBPS/images/'))).toHaveLength(N);
  });

  it('stops reading and converting once the budget is used up (counted as skipped once per name)', async () => {
    const N = 10;
    const names = Array.from({ length: N }, (_, i) => `n${i}`);
    const kv: Record<string, Uint8Array> = {};
    for (let i = 0; i < N; i++) kv[`assets/n${i}.png`] = Buffer.concat([PNG_1X1, Buffer.from([i])]);
    const h = makeHarness({
      spec: {
        characters: [{ chaId: 'c1', name: 'Alice', chats: [{ id: 'e1', name: '합성 책', message: names.map((n, i) => msg('char', `[m${i}]\n{{raw::${n}}}`)) }] }],
        manifests: [{ kind: 'character', ownerId: 'c1', items: names.map((n) => [n, `assets/${n}.png`, 'png'] as [string, string, string]) }],
        assets: kv,
      },
    });
    await h.sync();
    const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-e-')), 'out.epub');
    const size = PNG_1X1.length + 1;
    let started = 0;
    const convert: typeof convertImage = async (bytes, mime) => { started++; return { bytes, mime, ext: 'png' }; };
    const { warnings } = await produceEpub({ store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now, convert, imageBudgetBytes: size }, { ...ALL, cover: false }, tmp);
    expect(warnings).toEqual({ missingImages: 0, skippedImages: N - 1, slowRules: [] }); // 첫 그림만 들어간다
    expect(Object.keys(unzipSync(new Uint8Array(fs.readFileSync(tmp)))).filter((n) => n.startsWith('OEBPS/images/'))).toHaveLength(1);
    expect(started).toBeLessThanOrEqual(4); // 첫 창(0..3)만 변환했고, 4 번부터는 한도가 찬 걸 보고 건너뛴다
  });

  it.skipIf(!hasJava)('produces an EPUB that epubcheck accepts with WebP and with JPEG images (skipped when java is missing)', async () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'epubcheck.sh');
    for (const imageMode of ['small', 'compat'] as const) {
      const { tmp } = await run(['a', 'b'], { a: await transparent(400, 300), b: await gradient(200, 100, 3) }, await transparent(60, 90), { imageMode });
      expect(execFileSync(script, [tmp], { encoding: 'utf8' })).toMatch(/No errors or warnings detected/);
    }
  }, 120_000);
});
