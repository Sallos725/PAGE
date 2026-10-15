import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AM, PNG, baseSpec, type SynSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

function assetSpec(): SynSpec {
  const s = baseSpec();
  const c1 = s.characters[0]!;
  c1.chats[0]!.message[0]!.data = `a {{raw::${AM(1)}}} b {{raw::${AM(2)}}} {{raw::${AM(9)}}} {{raw::plain-missing}} {{raw::loose}}`;
  s.manifests = [{ kind: 'character', ownerId: 'c1', items: [[AM(1), 'assets/p1.png', 'png'], [AM(2), 'assets/p2.png', 'png'], ['loose', 'assets/p3.png', 'png']] }];
  // p1 과 p2 는 같은 바이트 → 내용 주소로 1벌만 저장되어야 한다
  s.assets = { 'assets/p1.png': PNG(1), 'assets/p2.png': PNG(1), 'assets/p3.png': PNG(3) };
  return s;
}

describe('Syncer — assets', () => {
  it('copies referenced assets once per content, records unresolved Asset Maid names, ignores untracked misses', async () => {
    const h = makeHarness({ spec: assetSpec() });
    const r = await h.sync();
    expect(r.assets).toMatchObject({ copied: 2, deduped: 1, unresolved: 1, deferred: 0 });
    expect(h.store.assetTotals()).toEqual({ count: 2, bytes: 16 });
    const head = h.store.getChat('main', 'c1', 'a1')!.headVersion!;
    const rows = h.store.getVersionAssets(head);
    expect(rows.map((x) => [x.ref === AM(9) ? 'dangling' : x.ref === AM(1) ? 'am1' : x.ref === AM(2) ? 'am2' : x.ref, x.status])).toEqual(
      expect.arrayContaining([['am1', 'ok'], ['am2', 'ok'], ['dangling', 'unresolved'], ['loose', 'ok']]),
    );
    expect(rows.find((x) => x.ref === 'plain-missing')).toBeUndefined(); // 추적 대상 이름이 아닌 미해결은 기록하지 않는다
    const h1 = rows.find((x) => x.ref === AM(1))!.hash!;
    expect(rows.find((x) => x.ref === AM(2))!.hash).toBe(h1);
    expect(fs.readFileSync(h.store.blobPath(h1))).toEqual(PNG(1));
    expect(h.store.findAssetHash('main', 'c1', AM(1))).toBe(h1);
  });

  it('a new version reuses head hashes for names already resolved (no re-read)', async () => {
    const h = makeHarness({ spec: assetSpec() });
    await h.sync();
    h.rewrite((s) => { s.characters[0]!.chats[0]!.message.push({ role: 'user', data: 'more' }); });
    const r = await h.syncer.syncSource(h.adapter, { only: { charId: 'c1', chatId: 'a1' }, force: true });
    expect(r.chats.appended).toBe(1);
    expect(r.assets).toMatchObject({ copied: 0, deduped: 0 }); // ok 항목은 바이트를 다시 읽지 않았다
    const rows = h.store.getVersionAssets(h.store.getChat('main', 'c1', 'a1')!.headVersion!);
    expect(rows.filter((x) => x.status === 'ok')).toHaveLength(3);
  });

  it('low free space defers new asset copies (text still syncs); a later sync backfills them', async () => {
    const h = makeHarness({ spec: assetSpec() });
    h.free.freeBytes = 1e9; // stopAssetsFreeBytes(2e9) 미만
    const r = await h.sync();
    expect(r.chats.created).toBe(3); // 텍스트는 계속
    expect(r.assets).toMatchObject({ copied: 0, deferred: 3 });
    expect(h.store.assetTotals().count).toBe(0);
    expect(h.store.hasPendingOrDeferred('main')).toBe(true);
    expect(h.store.getState('main', 'last_fp')).not.toBeNull();

    // 소스는 그대로이고 여유가 회복됨 → 지문이 같아도 이월분이 있어 건너뛰지 않는다
    h.free.freeBytes = 1e12;
    const r2 = await h.sync();
    expect(r2.outcome).toBe('synced');
    expect(r2.assets).toMatchObject({ copied: 2, deduped: 1, filled: 3 });
    expect(h.store.hasPendingOrDeferred('main')).toBe(false);
    const rows = h.store.getVersionAssets(h.store.getChat('main', 'c1', 'a1')!.headVersion!);
    expect(rows.filter((x) => x.status === 'ok')).toHaveLength(3);
    expect(h.store.listVersions('main', 'c1', 'a1')).toHaveLength(1); // 보충은 새 버전을 만들지 않는다
  });

  it('the incoming asset size counts against the stop threshold', async () => {
    const h = makeHarness({ spec: assetSpec(), policy: { stopAssetsFreeBytes: 2e9 } });
    h.free.freeBytes = 2e9 + 4; // PNG 8바이트를 복사하면 임계값 아래로 내려간다
    const r = await h.sync();
    expect(r.assets.copied).toBe(0);
    expect(r.assets.deferred).toBeGreaterThan(0);
  });
});
