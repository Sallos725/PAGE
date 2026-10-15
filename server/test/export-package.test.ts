import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PNG_1X1 } from '../src/tools/synthetic-source.js';
import { buildEpub, type EpubInput } from '../src/export/epub/package.js';
import { chapterXhtml } from '../src/export/epub/render.js';

const input = (over: Partial<EpubInput> = {}): EpubInput => ({
  id: '11111111-2222-4333-8444-555555555555',
  title: '합성 <채팅>', author: 'Alice', modified: '2026-10-14T12:00:00Z',
  chapters: [{ title: '1장', xhtml: chapterXhtml('1장', '<div class="msg char"><figure><img src="images/aaaa.png" alt=""/></figure></div>') }, { title: '2장', xhtml: chapterXhtml('2장', '<p>b</p>') }],
  images: [{ id: 'img-aaaa', href: 'images/aaaa.png', mime: 'image/png', bytes: PNG_1X1 }],
  cover: { id: 'cover-image', href: 'images/cover.png', mime: 'image/png', bytes: PNG_1X1 },
  ...over,
});

describe('EPUB package', () => {
  it('mimetype is the first entry, stored without compression or extra field', async () => {
    const z = Buffer.from(await buildEpub(input()));
    expect(z.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(z.readUInt16LE(8)).toBe(0); // 압축 방식 0 = stored
    const nameLen = z.readUInt16LE(26);
    expect(z.readUInt16LE(28)).toBe(0); // extra field 없음
    expect(z.subarray(30, 30 + nameLen).toString()).toBe('mimetype');
    expect(z.subarray(30 + nameLen, 30 + nameLen + 20).toString()).toBe('application/epub+zip');
  });

  it('has container, OPF with metadata, manifest, cover and spine; nav lists chapters', async () => {
    const files = unzipSync(await buildEpub(input()));
    expect(Object.keys(files).sort()).toEqual([
      'META-INF/container.xml', 'OEBPS/chapter-1.xhtml', 'OEBPS/chapter-2.xhtml', 'OEBPS/content.opf', 'OEBPS/cover.xhtml',
      'OEBPS/images/aaaa.png', 'OEBPS/images/cover.png', 'OEBPS/nav.xhtml', 'OEBPS/style.css', 'mimetype',
    ]);
    expect(strFromU8(files['META-INF/container.xml']!)).toContain('full-path="OEBPS/content.opf"');
    const opf = strFromU8(files['OEBPS/content.opf']!);
    expect(opf).toContain('<dc:identifier id="uid">urn:uuid:11111111-2222-4333-8444-555555555555</dc:identifier>');
    expect(opf).toContain('<dc:title>합성 &lt;채팅&gt;</dc:title>');
    expect(opf).toContain('<dc:creator>Alice</dc:creator>');
    expect(opf).toContain('<dc:language>ko</dc:language>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-14T12:00:00Z</meta>');
    expect(opf).toContain('<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>');
    expect(opf).toContain('<item id="img-aaaa" href="images/aaaa.png" media-type="image/png"/>');
    expect(opf).toContain('<spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>');
    const nav = strFromU8(files['OEBPS/nav.xhtml']!);
    expect(nav).toContain('<nav epub:type="toc" id="toc">');
    expect(nav).toContain('<li><a href="chapter-2.xhtml">2장</a></li>');
  });

  it('without a cover and author, and with no chapters, still makes a valid one-chapter book', async () => {
    const files = unzipSync(await buildEpub(input({ cover: null, author: '', chapters: [] })));
    expect(files['OEBPS/cover.xhtml']).toBeUndefined();
    const opf = strFromU8(files['OEBPS/content.opf']!);
    expect(opf).not.toContain('dc:creator');
    expect(opf).toContain('<spine><itemref idref="c1"/></spine>');
    expect(files['OEBPS/chapter-1.xhtml']).toBeDefined();
  });

  it('normalises modified to CCYY-MM-DDThh:mm:ssZ and rejects an invalid date', async () => {
    const files = unzipSync(await buildEpub(input({ modified: '2026-10-14T12:00:00.123Z' })));
    expect(strFromU8(files['OEBPS/content.opf']!)).toContain('<meta property="dcterms:modified">2026-10-14T12:00:00Z</meta>');
    const off = unzipSync(await buildEpub(input({ modified: '2026-10-14T21:00:00+09:00' })));
    expect(strFromU8(off['OEBPS/content.opf']!)).toContain('>2026-10-14T12:00:00Z<');
    await expect(buildEpub(input({ modified: 'nope' }))).rejects.toThrow('epub: invalid-modified');
  });

  it('rejects colliding manifest ids, bad ids and colliding paths', async () => {
    const im = { id: 'img-aaaa', href: 'images/aaaa.png', mime: 'image/png', bytes: PNG_1X1 };
    await expect(buildEpub(input({ images: [im, { ...im, href: 'images/bbbb.png' }] }))).rejects.toThrow('epub: duplicate-manifest-id');
    await expect(buildEpub(input({ images: [{ ...im, id: 'nav' }] }))).rejects.toThrow('epub: duplicate-manifest-id');
    await expect(buildEpub(input({ images: [{ ...im, id: '1abc' }] }))).rejects.toThrow('epub: bad-manifest-id');
    await expect(buildEpub(input({ images: [{ ...im, id: 'img b' }] }))).rejects.toThrow('epub: bad-manifest-id');
    await expect(buildEpub(input({ images: [{ ...im, href: 'images/cover.png' }] }))).rejects.toThrow('epub: duplicate-path');
  });

  const hasJava = spawnSync('java', ['-version']).status === 0;
  it.skipIf(!hasJava)('passes epubcheck (skipped when java is missing)', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'page-epub-')), 'synthetic.epub');
    fs.writeFileSync(f, await buildEpub(input()));
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'epubcheck.sh');
    const out = execFileSync(script, [f], { encoding: 'utf8' });
    expect(out).toMatch(/No errors or warnings detected/);
  }, 120_000);
});
