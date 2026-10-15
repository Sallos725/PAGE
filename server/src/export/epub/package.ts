import { strToU8, zip, type Zippable } from 'fflate';
import { esc, xhtmlDoc } from './render.js';

// EPUB 3 패키지 (스펙 2.5 §2.3). mimetype 은 첫 항목·무압축이어야 한다 (fflate 는 넣은 순서를 지킨다).
// fflate 의 비동기 zip 은 약 160KB 미만 항목을 워커 없이 메인 스레드에서 동기로 압축하고(챕터 파일은 모두 이 아래다),
// 저장만 하는(level 0) 그림의 CRC 도 메인 스레드에서 계산한다. 워커가 도움이 되는 건 큰 압축 가능 항목뿐이다.
// 실측 규모: 책 한 권 글자 압축 약 0.1~0.5초, 그림 300MB 의 CRC 약 0.75초 — 그동안 이벤트 루프가 잠깐 막힌다.

export type EpubImage = { id: string; href: string; mime: string; bytes: Uint8Array };
export type EpubInput = {
  id: string; // uuid
  title: string;
  author: string;
  modified: string; // 유효한 ISO 날짜 문자열이면 된다. OPF 에는 CCYY-MM-DDThh:mm:ssZ 로 정리해 넣는다.
  chapters: { title: string; xhtml: string }[];
  images: EpubImage[];
  cover: EpubImage | null; // cover.id 는 쓰지 않는다 (매니페스트 id 는 항상 'cover-image')
};

const CSS = `body { font-family: serif; line-height: 1.75; margin: 0 1em; }
h2 { font-size: 1em; text-align: center; margin: 2em 0 1.5em; letter-spacing: 0.1em; }
p { margin: 0 0 0.8em; text-indent: 0; }
p.dialogue { margin-left: 0.5em; }
.msg { margin: 0 0 1.4em; }
.msg.user { color: #555; font-style: italic; border-left: 2px solid #ccc; padding-left: 0.8em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 20%; }
`;

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const XML_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

function fail(code: string): never {
  throw new Error(`epub: ${code}`); // 사용자 내용은 메시지에 넣지 않는다
}

function normaliseModified(s: string): string {
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) fail('invalid-modified');
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function buildEpub(e: EpubInput): Promise<Uint8Array> {
  const title = e.title.trim() || '제목 없음';
  const chapters = e.chapters.length ? e.chapters : [{ title: '1장', xhtml: xhtmlDoc('1장', '<section><h2>1장</h2></section>') }];
  const cover = e.cover;
  const modified = normaliseModified(e.modified);

  const ids = ['nav', 'css', ...(cover ? ['cover-image', 'cover'] : []), ...chapters.map((_, i) => `c${i + 1}`), ...e.images.map((im) => im.id)];
  if (ids.some((id) => !XML_NAME.test(id))) fail('bad-manifest-id');
  if (new Set(ids).size !== ids.length) fail('duplicate-manifest-id');
  const hrefs = [...(cover ? [cover.href] : []), ...e.images.map((im) => im.href)];
  if (new Set(hrefs).size !== hrefs.length) fail('duplicate-path');

  const items = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...(cover ? [
      `<item id="cover-image" href="${esc(cover.href)}" media-type="${esc(cover.mime)}" properties="cover-image"/>`,
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    ] : []),
    ...chapters.map((_, i) => `<item id="c${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`),
    ...e.images.map((im) => `<item id="${esc(im.id)}" href="${esc(im.href)}" media-type="${esc(im.mime)}"/>`),
  ];
  const spine = [...(cover ? ['<itemref idref="cover"/>'] : []), ...chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`)];
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="ko">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${esc(e.id)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${e.author.trim() ? `<dc:creator>${esc(e.author.trim())}</dc:creator>\n` : ''}<dc:language>ko</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>${items.join('')}</manifest>
<spine>${spine.join('')}</spine>
</package>`;
  const nav = xhtmlDoc(title, `<nav epub:type="toc" id="toc"><h1>차례</h1><ol>${chapters.map((c, i) => `<li><a href="chapter-${i + 1}.xhtml">${esc(c.title)}</a></li>`).join('')}</ol></nav>`);

  const files: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(CONTAINER),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(CSS),
  };
  if (cover) {
    files['OEBPS/cover.xhtml'] = strToU8(xhtmlDoc(title, `<section epub:type="cover"><img src="${esc(cover.href)}" alt="${esc(title)}"/></section>`));
    files[`OEBPS/${cover.href}`] = [cover.bytes, { level: 0 }];
  }
  chapters.forEach((c, i) => { files[`OEBPS/chapter-${i + 1}.xhtml`] = strToU8(c.xhtml); });
  for (const im of e.images) files[`OEBPS/${im.href}`] = [im.bytes, { level: 0 }]; // 이미 압축된 그림은 다시 압축하지 않는다
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}
