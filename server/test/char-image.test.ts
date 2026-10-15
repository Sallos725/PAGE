import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PNG, baseSpec, type SynSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

function withImages(): SynSpec {
  const s = baseSpec();
  s.characters[0]!.image = 'assets/face-a.png';
  s.characters[1]!.image = 'assets/face-b.png';
  s.assets = { 'assets/face-a.png': PNG(21), 'assets/face-b.png': PNG(21) }; // 같은 바이트 → 1벌
  return s;
}

describe('character image (D27)', () => {
  it('copies each character image once per content and records it', async () => {
    const h = makeHarness({ spec: withImages() });
    const r = await h.sync();
    const a = h.store.getCharImage('main', 'c1')!;
    const b = h.store.getCharImage('main', 'c2')!;
    expect(a.ref).toBe('assets/face-a.png');
    expect(a.hash).toBe(b.hash);
    expect(fs.readFileSync(h.store.blobPath(a.hash!))).toEqual(PNG(21));
    expect(r.assets.copied).toBeGreaterThanOrEqual(1);
    expect(h.store.assetInfo(a.hash!)!.mime).toBe('image/png');
  });

  it('does not re-read an unchanged image; follows a changed one; clears a removed one', async () => {
    const h = makeHarness({ spec: withImages() });
    await h.sync();
    const first = h.store.getCharImage('main', 'c1')!.hash;
    h.clock.advance(60_000);
    const again = await h.sync({ force: true });
    expect(again.assets.copied).toBe(0);
    h.rewrite((s) => { s.characters[0]!.image = 'assets/face-c.png'; s.assets!['assets/face-c.png'] = PNG(22); });
    h.clock.advance(60_000);
    await h.sync({ force: true });
    const changed = h.store.getCharImage('main', 'c1')!;
    expect(changed.ref).toBe('assets/face-c.png');
    expect(changed.hash).not.toBe(first);
    expect(h.store.hasAsset(first!)).toBe(true); // 옛 blob 은 남는다 (보존)
    h.rewrite((s) => { delete s.characters[0]!.image; });
    h.clock.advance(60_000);
    await h.sync({ force: true });
    expect(h.store.getCharImage('main', 'c1')).toBeNull();
  });

  it('ignores unsafe or non-asset keys and missing bytes', async () => {
    const s = baseSpec();
    s.characters[0]!.image = 'secrets/x.png';
    s.characters[1]!.image = 'assets/../__password';
    const h = makeHarness({ spec: s });
    await h.sync();
    expect(h.store.getCharImage('main', 'c1')).toBeNull();
    expect(h.store.getCharImage('main', 'c2')).toBeNull();
    const s2 = baseSpec();
    s2.characters[0]!.image = 'assets/missing.png';
    const h2 = makeHarness({ spec: s2 });
    await h2.sync();
    expect(h2.store.getCharImage('main', 'c1')).toEqual({ ref: 'assets/missing.png', hash: null });
  });

  it('respects the free-space policy (deferred = no hash)', async () => {
    const h = makeHarness({ spec: withImages(), policy: { stopAssetsFreeBytes: 2e12 } });
    const r = await h.sync();
    expect(h.store.getCharImage('main', 'c1')).toEqual({ ref: 'assets/face-a.png', hash: null });
    expect(r.assets.deferred).toBeGreaterThanOrEqual(1);
  });
});
