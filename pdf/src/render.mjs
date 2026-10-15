import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Chromium 실행 인자 (서버 main 과 테스트가 같은 값을 쓴다).
// - --no-sandbox: 컨테이너 안에서는 사용자 네임스페이스가 없어 샌드박스를 켤 수 없다. 대신 JS 끔·요청 차단·
//   우리가 만든 HTML 만 연다·읽기 전용 루트·cap_drop ALL (스펙 P4).
// - 나머지는 네트워크 송신을 아예 끊는다. page.route 의 abort 는 요청만 막고, 미리 연결(preconnect)이나
//   <iframe src=http://…> 같은 TCP 연결은 막지 못했다. 프록시를 닿지 않는 곳(127.0.0.1:1)으로 돌리고,
//   루프백 예외를 없애고(<-loopback>), 이름 풀이를 전부 실패시킨다.
export const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--font-render-hinting=none',
  '--proxy-server=http://127.0.0.1:1',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--dns-prefetch-disable',
  '--disable-features=NetworkPrediction',
];

// 쪽 번호 바닥글. 이 인라인 style 은 Chromium 인쇄 머리말/바닥글 전용 템플릿 안의 것이라
// (웹 앱 화면이 아니라 PDF 안에만 그려진다) 웹 앱의 CSP 규칙(인라인 style 금지) 대상이 아니다.
const FOOTER = '<div style="width:100%;font-size:8px;text-align:center;color:#888;"><span class="pageNumber"></span></div>';

// 렌더 (스펙 §2): 새 컨텍스트, JS 끔, 작업 디렉터리 밖 요청 차단, A5, 쪽 번호, 책갈피.
// 시간 상한도 여기서 책임진다: 넘기면 컨텍스트를 닫아 page.pdf 를 중단시키고, 닫힌 뒤에야 Error('timeout') 로 끝난다.
export async function renderPdf(browser, dir, fontsDir, { timeoutMs }) {
  await fs.cp(fontsDir, path.join(dir, 'fonts'), { recursive: true });
  const base = pathToFileURL(dir + path.sep).href;
  // JS 를 끈다: 묶음 HTML 에 스크립트가 있어도 실행되지 않는다 (스펙 P4).
  const context = await browser.newContext({ javaScriptEnabled: false });
  let timedOut = false;
  let closing; // 시간 초과로 닫기 시작한 close() — finally 가 끝까지 기다려야 한다 (닫는 중에는 close() 가 곧바로 돌아온다)
  const timer = setTimeout(() => {
    timedOut = true;
    closing = context.close().catch(() => undefined);
  }, timeoutMs);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    // 작업 디렉터리 밖(네트워크·다른 file://) 요청은 전부 중단한다.
    await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page.goto(new URL('index.html', base).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready).catch(() => undefined); // JS 꺼짐이면 무시 — load 가 폰트를 기다린다
    return await page.pdf({
      format: 'A5', printBackground: true, preferCSSPageSize: false,
      displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: FOOTER,
      margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' },
      outline: true, tagged: true,
    });
  } catch (e) {
    if (timedOut) throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(timer);
    await (closing ?? context.close().catch(() => undefined));
  }
}
