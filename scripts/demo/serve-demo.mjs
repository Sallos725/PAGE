// 데모 서버: README 스크린샷용. 합성 save(직접 지은 짧은 이야기) → 동기화 → 실제 API + 빌드된 SPA 를 4174 에서 서빙.
// 실제 save·채팅은 전혀 쓰지 않는다. 사전: (cd server && npm run build) && (cd web && npm run build)
// 사용: node scripts/demo/serve-demo.mjs   (DEMO_PORT 로 포트 변경)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const imp = (p) => import(path.join(root, 'server', 'dist', p));

const { writeSource, chat, msg } = await imp('tools/synthetic-source.js');
const { LibraryStore } = await imp('library/store.js');
const { StateStore } = await imp('state/store.js');
const { PocketRisuAdapter } = await imp('source/pocketrisu/adapter.js');
const { Syncer } = await imp('sync/syncer.js');
const { buildApp } = await imp('api/app.js');
const { AppearanceStore } = await imp('state/appearance.js');
const { ExportManager } = await imp('export/jobs.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'page-demo-'));
const srcDir = path.join(tmp, 'src');
const dataDir = path.join(tmp, 'data');

// 직접 지은 짧은 이야기 (실제 채팅 아님)
const lighthouse = [
  ['user', '문을 밀자 종이 냄새가 먼저 쏟아졌다. "여기가 등대 도서관이에요?"'],
  ['char', '계단 위에서 램프를 든 사람이 고개를 내밀었다. 바람에 젖은 머리칼 사이로 웃음이 보였다.\n"맞아요. 불은 이제 배를 비추지 않지만, 책은 아직 여기 있어요."\n그녀는 램프를 낮추고 천천히 내려왔다. 나선 계단의 벽을 따라 책등이 끝없이 이어져 있었다.'],
  ['user', '"이 책들, 전부 누가 모은 거예요?"'],
  ['char', '"등대지기들이요. 한 사람이 떠날 때마다 한 권씩 남기고 갔대요. 일지일 때도 있고, 편지일 때도 있고."\n그녀가 가장 아래 칸에서 얇은 책 한 권을 꺼냈다. 표지에는 날짜만 적혀 있었다.\n"이건 제 앞 사람이 남긴 거예요. 아직 끝까지 못 읽었어요."'],
  ['user', '"왜요?"'],
  ['char', '그녀는 대답 대신 창밖을 봤다. 바다는 낮게 숨을 쉬고 있었다.\n"끝까지 읽으면, 그 사람이 정말 떠난 게 될 것 같아서요."\n잠시 뒤 그녀가 책을 내밀었다. "같이 읽어 줄래요? 한 장씩만."'],
  ['user', '책을 받아 첫 장을 넘겼다. 잉크가 바다 냄새처럼 번져 있었다.'],
  ['char', '"오늘도 안개. 배는 오지 않았다. 대신 갈매기 한 마리가 난간에 앉아 한참을 있다 갔다."\n그녀가 소리 내어 읽고는 작게 웃었다. "이 사람, 매일 갈매기 얘기만 해요."\n"그래도 매일 썼잖아요." 내가 말하자 그녀가 고개를 끄덕였다.\n"맞아요. 매일 썼어요. 아무도 안 읽을 줄 알면서."'],
  ['user', '"그럼 지금 우리가 처음 읽는 사람이네요."'],
  ['char', '그 말에 그녀가 램프를 책 가까이 옮겼다. 불빛이 종이 위에서 흔들렸다.\n"그럼 천천히 읽어야겠네요. 처음 읽는 사람답게."\n우리는 계단에 나란히 앉았다. 파도 소리가 쪽을 넘기는 소리와 섞였다.'],
  ['user', '몇 장을 더 넘기자, 일지 사이에 접힌 쪽지가 끼워져 있었다.'],
  ['char', '그녀가 쪽지를 펼치다 멈췄다. 손끝이 조금 떨렸다.\n"다음 사람에게. 불이 꺼져도 이 탑은 서고로 남을 거야. 누군가 다시 문을 열면, 그 사람에게 이 책을 건네줘."\n그녀는 한동안 말이 없었다. 그러다 쪽지를 내 손바닥 위에 올려놓았다.\n"…그러니까, 이건 원래 당신 몫이었나 봐요."'],
];

const station = [
  ['user', '막차가 끊긴 간이역. 대합실 불만 하나 켜져 있었다.'],
  ['char', '"표 사러 오신 거면 내일 아침에 오셔야 해요." 매표소 창 너머로 누군가 뜨개질을 멈추고 말했다.\n"그냥 비 그칠 때까지만 있어도 돼요. 난로는 공짜니까."'],
  ['user', '"고마워요. 여기 원래 이렇게 조용해요?"'],
  ['char', '"하루에 기차가 세 번 서요. 그 사이엔 계절이 지나가는 소리만 들려요."\n그녀가 주전자를 난로 위에 올렸다. "보리차 괜찮죠?"'],
];

const garden = [
  ['user', '"이 정원, 밤에만 피는 꽃이 있다면서요."'],
  ['char', '"달맞이꽃이요. 해가 지고 한 시간쯤 지나면 하나씩 열려요." 정원사가 호미를 내려놓았다.\n"서두르면 안 보여요. 가만히 있어야 보이는 꽃이거든요."'],
];

const toMsgs = (rows) => rows.map(([role, text]) => msg(role, text));

// 데모 캐릭터 이미지: 단색 64×64 PNG 를 직접 만든다 (외부 이미지 없음).
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(r, g, b, size = 64) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeSource(srcDir, {
  characters: [
    {
      chaId: 'seoyun', name: '서윤', image: 'assets/demo-seoyun.png', chats: [
        { id: 'lighthouse', name: '등대 도서관', message: toMsgs(lighthouse) },
        { id: 'logbook', name: '안개 일지', message: toMsgs(lighthouse.slice(6, 10)) },
        { id: 'letter', name: '쪽지', message: toMsgs([['user', '쪽지를 다시 펼쳤다.'], ['char', '"다음 사람에게." 그 글씨가 아까보다 따뜻해 보였다.']]) },
      ],
    },
    { chaId: 'haneul', name: '하늘', image: 'assets/demo-haneul.png', chats: [{ id: 'station', name: '간이역', message: toMsgs(station) }] },
    { chaId: 'dasom', name: '다솜', chats: [{ id: 'garden', name: '밤의 정원', message: toMsgs(garden) }] },
  ],
  assets: { 'assets/demo-seoyun.png': solidPng(0x6f, 0xb5, 0xa9), 'assets/demo-haneul.png': solidPng(0xc9, 0xa2, 0x7a) },
});

const store = new LibraryStore(dataDir);
const state = new StateStore(dataDir);
const appearance = new AppearanceStore(state.db, dataDir);
const exportManager = new ExportManager({ dir: path.join(dataDir, 'exports'), now: Date.now });
const policy = {
  debounceMs: 0, massDeletionRatio: 0.5, warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9,
  freeSpace: () => ({ freeBytes: 1e12, totalBytes: 2e12 }),
};
const adapter = new PocketRisuAdapter('demo', srcDir);
const syncer = new Syncer({ store, now: Date.now, policy });
await syncer.syncSource(adapter);

// 책상이 비지 않게 몇 권을 읽던 상태로 둔다. 앵커는 web/src/lib/position.ts 의 anchorOf(첫 문단, 0) 과 같은 계산
// (FNV-1a 32bit of `|<앞 16자>`) — 틀리면 리더가 "내용이 바뀌었을 수 있어요" 를 띄운다.
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const startOf = (rows, i) => ({ msgIdx: i, blockIdx: 0, charOffset: 0, anchorHash: fnv1a(`|${rows[i][1].split('\n')[0].trim().slice(0, 16)}`) });
state.putPosition('demo', 'seoyun', 'lighthouse', startOf(lighthouse, 6), Date.now());
state.putPosition('demo', 'haneul', 'station', startOf(station, 1), Date.now() - 60_000);

const app = await buildApp({ adapters: [adapter], store, syncer, policy, now: Date.now, state, appearance, exportManager, webDir: path.join(root, 'web', 'dist') });
await app.listen({ host: '127.0.0.1', port: Number(process.env.DEMO_PORT ?? 4174) });
console.log(`demo server ready on http://127.0.0.1:${process.env.DEMO_PORT ?? 4174}`);
