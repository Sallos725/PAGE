import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { prepareBook } from '../src/export/epub/prepare.js';
import { DEFAULT_EPUB_OPTIONS, produceEpub, type EpubOptions } from '../src/export/epub/produce.js';
import { chatVersion } from '../src/export/source.js';
import { StateStore } from '../src/state/store.js';
import { AM, PNG_1X1, chat, msg } from '../src/tools/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const ALL: EpubOptions = { ...DEFAULT_EPUB_OPTIONS, imageMode: 'original' };

async function setup() {
  const h = makeHarness({
    spec: {
      characters: [{
        chaId: 'c1', name: 'Alice', image: 'assets/alice.png',
        chats: [{ id: 'e1', name: '합성 책', message: [
          msg('user', '[u0] 안녕'),
          msg('char', `[c1] 웃었다\n{{raw::${AM(1)}}}\n{{raw::없는그림}}\n{{raw::이상한형식}}`),
          msg('user', '[u2] 다음'),
          msg('char', `[c3] 끝\n{{raw::${AM(2)}}}`),
        ] }, chat('e2', ['x'])],
      }],
      manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png'], [AM(2), 'assets/p2.png', 'png'], ['이상한형식', 'assets/odd.bin', 'bin']] }],
      assets: {
        'assets/p1.png': PNG_1X1, 'assets/p2.png': await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        'assets/alice.png': PNG_1X1, 'assets/odd.bin': new Uint8Array([1, 2, 3, 4]),
      },
    },
  });
  await h.sync();
  const cv = chatVersion(h.store, 'main', 'c1', 'e1')!;
  const ctx = { store: h.store, state: new StateStore(h.dataDir), kind: h.adapter.kind, source: 'main', charId: 'c1', cv, title: '합성 책', author: 'Alice', now: h.clock.now };
  return { ctx };
}

describe('prepareBook', () => {
  it('matches the EPUB produced from the same input: chapter titles, message count, image count, warnings', async () => {
    const { ctx } = await setup();
    const book = await prepareBook(ctx, ALL);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-p-')), 'out.epub');
    const r = await produceEpub(ctx, ALL, tmp);
    const files = unzipSync(new Uint8Array(fs.readFileSync(tmp)));
    const chapterFiles = Object.entries(files).filter(([n]) => n.startsWith('OEBPS/chapter-')).sort(([a], [b]) => a.localeCompare(b));
    const epubTitles = chapterFiles.map(([, b]) => /<title>([^<]*)<\/title>/.exec(strFromU8(b))![1]);
    const epubMessages = chapterFiles.reduce((n, [, b]) => n + (strFromU8(b).match(/<div class="msg /g)?.length ?? 0), 0);
    const epubImages = Object.keys(files).filter((n) => /^OEBPS\/images\/[0-9a-f]{16}\./.test(n));

    expect(book.chapters.map((c) => c.title)).toEqual(epubTitles);
    expect(book.chapters.reduce((n, c) => n + c.messages.length, 0)).toBe(4);
    expect(epubMessages).toBe(4);
    expect(book.images).toHaveLength(epubImages.length);
    expect(book.images).toHaveLength(2);
    expect(book.cover).not.toBeNull();
    expect(files['OEBPS/images/cover.png']).toBeDefined();
    expect(book.warnings).toEqual(r.warnings);
    expect(book.warnings).toEqual({ missingImages: 1, skippedImages: 1, slowRules: [] });
  });

  it('hrefOf resolves used images and returns null for missing/skipped/unknown names', async () => {
    const { ctx } = await setup();
    const book = await prepareBook(ctx, ALL);
    expect(book.hrefOf(AM(1))).toMatch(/^images\/[0-9a-f]{16}\.png$/);
    expect(book.images.map((i) => i.href)).toContain(book.hrefOf(AM(1)));
    expect(book.hrefOf('없는그림')).toBeNull();
    expect(book.hrefOf('이상한형식')).toBeNull();
    expect(book.hrefOf('never-seen')).toBeNull();
  });

  it('drops excluded user messages and the cover when asked, but keeps the chapter', async () => {
    const { ctx } = await setup();
    const book = await prepareBook(ctx, { ...ALL, includeUser: false, cover: false });
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]!.messages.map((m) => m.role)).toEqual(['char', 'char']);
    expect(book.cover).toBeNull();
  });

  it('returns image mime per imageMode (images and cover)', async () => {
    const { ctx } = await setup();
    const mimes = async (imageMode: EpubOptions['imageMode']) => {
      const b = await prepareBook(ctx, { ...DEFAULT_EPUB_OPTIONS, imageMode });
      return { images: b.images.map((i) => i.mime).sort(), cover: b.cover!.mime };
    };
    expect(await mimes('original')).toEqual({ images: ['image/png', 'image/png'], cover: 'image/png' });
    expect(await mimes('small')).toEqual({ images: ['image/webp', 'image/webp'], cover: 'image/webp' });
    expect(await mimes('compat')).toEqual({ images: ['image/jpeg', 'image/jpeg'], cover: 'image/jpeg' });
  });
});
