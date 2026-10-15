// 실제 save 를 라이브러리로 동기화하고 *숫자만* 출력한다. 채팅·캐릭터·에셋 이름과 내용은 출력하지 않는다.
// API(Fastify)는 이 스크립트에 필요 없다 — 컨테이너 이미지에 fastify 가 없어도 돈다.
import fs from 'node:fs';
import { LibraryStore } from '../library/store.js';
import { normalizeMessage } from '../source/normalize.js';
import { PocketRisuAdapter } from '../source/pocketrisu/adapter.js';
import { Syncer } from '../sync/syncer.js';
import { emit } from './safe-report.js';

const sourceDir = process.env.SMOKE_SOURCE_DIR ?? '/save';
const dataDir = process.env.SMOKE_DATA_DIR ?? '/data';
const SOURCE = 'smoke';

const store = new LibraryStore(dataDir);
const adapter = new PocketRisuAdapter(SOURCE, sourceDir);
const free = fs.statfsSync(dataDir);
const policy = {
  debounceMs: 0, massDeletionRatio: 0.5, warnFreePct: 20, warnFreeBytes: 10e9, stopAssetsFreeBytes: 2e9,
  freeSpace: () => ({ freeBytes: Number(free.bavail) * Number(free.bsize), totalBytes: Number(free.blocks) * Number(free.bsize) }),
};
const syncer = new Syncer({ store, now: Date.now, policy });

const t0 = performance.now();
const r1 = await syncer.syncSource(adapter);
emit('first.outcome', r1.outcome);
emit('first.ms', Math.round(performance.now() - t0));
emit('first.errors', r1.errors);
for (const [k, v] of Object.entries(r1.chats)) emit(`first.chats.${k}`, v);
for (const [k, v] of Object.entries(r1.assets)) emit(`first.assets.${k}`, v);
emit('first.chars.seen', r1.chars.seen);

// 두 번째 동기화는 지문으로 건너뛰어야 한다 (소스가 그대로이고 이월·대기가 없을 때)
const r2 = await syncer.syncSource(adapter);
emit('second.outcome', r2.outcome);

const st = store.stats(SOURCE);
for (const [k, v] of Object.entries(st)) emit(`library.${k}`, v);
const totals = store.assetTotals();
emit('library.asset_count', totals.count);
emit('library.asset_bytes', totals.bytes);
emit('library.db_bytes', store.dbBytes());

// 목록 → 메시지 구간 → 에셋 바이트가 라이브러리만으로 나오는가 (내용은 출력하지 않는다)
let chatsWithMessages = 0, windowOk = 0, windowBad = 0, assetRows = 0, assetFilesOk = 0, assetFilesBad = 0, unresolved = 0;
for (const c of store.listChars(SOURCE, false)) {
  for (const ch of store.listChats(SOURCE, c.charId, false)) {
    if (!ch.headVersion) continue;
    const v = store.getVersion(ch.headVersion)!;
    const hashes = store.getManifest(v.manifestHash)!;
    if (hashes.length > 0) {
      chatsWithMessages++;
      const slice = hashes.slice(0, 5);
      const msgs = store.getMsgJson(slice).map((j, i) => normalizeMessage(adapter.kind, JSON.parse(j), i));
      if (msgs.length === slice.length && msgs.every((m) => typeof m.text === 'string')) windowOk++;
      else windowBad++;
    }
    for (const a of store.getVersionAssets(v.versionId)) {
      assetRows++;
      if (a.status === 'unresolved') unresolved++;
      if (a.hash) {
        const p = store.blobPath(a.hash);
        if (fs.existsSync(p) && fs.statSync(p).size === store.assetInfo(a.hash)?.size) assetFilesOk++;
        else assetFilesBad++;
      }
    }
  }
}
emit('check.chats_with_messages', chatsWithMessages);
emit('check.message_window_ok', windowOk);
emit('check.message_window_bad', windowBad);
emit('check.head_asset_rows', assetRows);
emit('check.head_asset_files_ok', assetFilesOk);
emit('check.head_asset_files_bad', assetFilesBad);
emit('check.head_assets_unresolved', unresolved);
emit('maxrss_mb', Math.round(process.resourceUsage().maxRSS / 1024));
const h = await adapter.health();
emit('health.status', h.status);
emit('health.reasons', h.reasons.length);
store.close();
