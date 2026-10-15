import fs from 'node:fs';
import { Readable } from 'node:stream';
import { ExportError, type ExportWarnings } from '../jobs.js';
import { prepareBook, type EpubContext, type EpubOptions } from '../epub/prepare.js';
import { buildPdfBundle } from './html.js';

// PDF 파이프라인 (스펙 2.5c §3): prepareBook(EPUB 과 공용) → HTML 묶음(zip) → 사이드카 POST /render → 결과 파일.
// 사이드카 응답 본문·채팅 내용·원인 오류는 오류나 로그에 넣지 않는다 — 코드만.
//
// 동시성: PAGE 는 사이드카로 한 번에 하나만 보낸다 (ExportManager 가 작업을 줄 세워 하나씩 돌린다).
// 사이드카의 렌더 상한(300초)보다 클라이언트 상한(330초)이 조금 긴 것도 그래서 맞다 — 우리 요청은 대기열 없이
// 바로 렌더에 들어가므로, 사이드카의 504 가 먼저 오고 클라이언트 시간 초과는 안전망일 뿐이다.

export type PdfContext = EpubContext & {
  pdfUrl: string;
  /** 테스트에서만 쓴다: fetch 바꿔치기. */
  fetchImpl?: typeof fetch;
  /** 사이드카 렌더 상한(300초)보다 조금 길게. 테스트에서 줄일 수 있다. */
  pdfTimeoutMs?: number;
};

const PDF_TIMEOUT_MS = 330_000;
const MAGIC = Buffer.from('%PDF-');
const SLICE = 1024 * 1024;

/** 묶음을 1MB 조각(뷰, 복사 없음)으로 흘려 보낸다. */
async function* slices(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += SLICE) yield bytes.subarray(i, i + SLICE);
}

/**
 * 준비 → 묶음. `book`(그림·장 전체)은 이 함수가 끝나면 범위를 벗어나, 사이드카를 기다리는 몇 분 동안
 * 메모리에 남지 않는다. 묶음은 스트림 안에만 남는다.
 */
async function buildRequest(ctx: PdfContext, opts: EpubOptions): Promise<{ stream: Readable; length: number; warnings: ExportWarnings }> {
  const book = await prepareBook(ctx, opts);
  const bundle = await buildPdfBundle(book, { title: ctx.title, author: ctx.author });
  return { stream: Readable.from(slices(bundle), { objectMode: false }), length: bundle.length, warnings: book.warnings };
}

export async function producePdf(ctx: PdfContext, opts: EpubOptions, tmpFile: string): Promise<{ warnings: ExportWarnings }> {
  const { stream, length, warnings } = await buildRequest(ctx, opts);

  let pdf: Buffer;
  try {
    // 본문을 Uint8Array 로 주면 undici 가 한 번 더 복사한다 — 스트림으로 보내 묶음을 한 벌만 들고 있는다.
    // content-length 를 직접 주어 사이드카가 본문을 읽기 전에 413/503 으로 거절할 수 있게 한다.
    const init = {
      method: 'POST',
      body: Readable.toWeb(stream),
      duplex: 'half',
      headers: { 'content-type': 'application/zip', 'content-length': String(length) },
      redirect: 'error',
      signal: AbortSignal.timeout(ctx.pdfTimeoutMs ?? PDF_TIMEOUT_MS),
    } as RequestInit;
    const res = await (ctx.fetchImpl ?? fetch)(`${ctx.pdfUrl.replace(/\/+$/, '')}/render`, init);
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined); // 본문은 읽지 않는다
      throw new ExportError(res.status === 503 ? 'pdf-busy' : 'pdf-failed');
    }
    pdf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    stream.destroy();
    throw e instanceof ExportError ? e : new ExportError('pdf-failed'); // 원인(주소·내용이 섞일 수 있다)은 버린다
  }
  if (pdf.length < MAGIC.length || !pdf.subarray(0, MAGIC.length).equals(MAGIC)) throw new ExportError('pdf-failed');
  await fs.promises.writeFile(tmpFile, pdf);
  return { warnings };
}
