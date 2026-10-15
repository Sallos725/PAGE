// E2E 서버: 합성 save → 동기화 → 실제 API + 빌드된 SPA 를 4173 에서 서빙. 채팅 내용은 모두 합성이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', '..', 'server', 'dist');
const web = path.join(here, '..', 'dist');
const imp = (p) => import(path.join(server, p));

const { writeSource, chat, msg, AM, PNG_1X1 } = await imp('tools/synthetic-source.js');
const { LibraryStore } = await imp('library/store.js');
const { StateStore } = await imp('state/store.js');
const { AppearanceStore } = await imp('state/appearance.js');
const { PocketRisuAdapter } = await imp('source/pocketrisu/adapter.js');
const { ImportStore } = await imp('import/store.js');
const { ImportAdapter } = await imp('source/import/adapter.js');
const { Syncer } = await imp('sync/syncer.js');
const { buildApp } = await imp('api/app.js');
const { ExportManager } = await imp('export/jobs.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-e2e-'));
const srcDir = path.join(root, 'src');
const dataDir = path.join(root, 'data');

const N = 130;
const para = (i) => [`[m${i}-p0] ${'첫 문단 '.repeat(8)}${i}`, `"[m${i}-p1] 대사 ${i}."`, `[m${i}-p2] ${'마지막 문단 '.repeat(10)}${i}`].join('\n');
const messages = Array.from({ length: N }, (_, i) => msg(i % 2 === 0 ? 'user' : 'char', para(i)));
messages[5].data =
  `<div class="am-illustration-projection" data-am-asset="${AM(1)}" data-am-slot-id="s5"><span class="am-image" style="width:90%"><img class="am-image__media" data-am-asset="${AM(1)}" src="{{raw::${AM(1)}}}" width="64" height="96"></span></div>\n[m5-after] 삽화 뒤 문단`;
messages[7].data = '[m7-xss] <script>window.__xss=1</script><img src=x onerror="window.__xss=2"> [m7-end]';

const spec = {
  characters: [{
    chaId: 'c1',
    name: 'Alice',
    image: 'assets/alice.png',
    chats: [
      { id: 'long', name: '긴 채팅', message: messages },
      chat('short', ['짧은 채팅의 첫 줄', '둘째 줄']),
      { id: 'status', name: '상태창 채팅', message: [
        msg('user', '[s0] 안녕'),
        msg('char', '[s1] 본문 앞 <st>HP 10 / MP 3</st> 본문 뒤'),
        msg('user', '[s2] 다음'),
        msg('char', '[s3] 둘째 본문 <st>HP 9 / MP 2</st> 끝'),
        msg('user', '[s4] 하나 더'),
        msg('char', '<st>HP 8 / MP 1</st>'),
      ] },
      chat('face', ['[f0] 안녕', '[f1] 그녀가 웃었다 <표정=웃음> 그리고 말했다']),
      chat('gone', ['[g0] 지워질 채팅의 첫 줄', '[g1] 둘째 줄']),
    ],
    customscript: [
      { comment: '합성 상태창', in: '<st>[\\s\\S]*?</st>', out: '<div>합성 출력</div>', type: 'editdisplay', ableFlag: true, flag: 'g' },
      { comment: '입력용', in: 'zzz', out: 'yyy', type: 'editinput' },
      { comment: '합성 표정', in: '<표정=([^>]+)>', out: '<div class="p">{{#if 1}}<img src="{{raw::조건부}}">{{/if}}<img src="{{raw::$1}}"></div>', type: 'editdisplay' },
    ],
  }, { chaId: 'c2', name: 'Bob', chats: [chat('b1', ['[b0] 밥의 첫 줄', '[b1] 둘째 줄'])] },
  { chaId: 'c3', name: 'Carol', chats: [chat('c3a', ['[c0] 캐럴의 첫 줄', '[c1] 둘째 줄'])] }],
  manifests: [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png'], ['웃음', 'assets/smile.png', 'png']] }],
  assets: { 'assets/p1.png': PNG_1X1, 'assets/alice.png': PNG_1X1, 'assets/smile.png': PNG_1X1 },
};
writeSource(srcDir, spec);

const store = new LibraryStore(dataDir);
const state = new StateStore(dataDir);
const appearance = new AppearanceStore(state.db, dataDir);
const policy = {
  debounceMs: 0, massDeletionRatio: 0.5, warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9,
  freeSpace: () => ({ freeBytes: 1e12, totalBytes: 2e12 }),
};
const adapter = new PocketRisuAdapter('main', srcDir);
const imports = new ImportStore(dataDir);
const importAdapter = new ImportAdapter(imports);
const syncer = new Syncer({ store, now: Date.now, policy });
await syncer.syncSource(adapter);
// 3D: 원본에서 채팅 하나(gone)와 캐릭터 하나(Carol)를 지운 상태 — 라이브러리에는 삭제 표시로 남는다.
spec.characters[0].chats = spec.characters[0].chats.filter((c) => c.id !== 'gone');
spec.characters = spec.characters.filter((c) => c.chaId !== 'c3');
writeSource(srcDir, spec);
await syncer.syncSource(adapter, { force: true });

const exportManager = new ExportManager({ dir: path.join(dataDir, 'exports'), now: Date.now });
const app = await buildApp({ adapters: [adapter, importAdapter], imports, store, syncer, policy, now: Date.now, state, appearance, exportManager, webDir: web });
await app.listen({ host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 4173) });
console.log('e2e server ready');
