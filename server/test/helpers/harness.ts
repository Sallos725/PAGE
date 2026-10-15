import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore } from '../../src/library/store.js';
import { PocketRisuAdapter } from '../../src/source/pocketrisu/adapter.js';
import { Syncer, type SyncPolicy } from '../../src/sync/syncer.js';
import { baseSpec, writeSource, type SynSpec } from './synthetic-source.js';

export const MIN = 60_000;

export function makeHarness(opts: { spec?: SynSpec; policy?: Partial<SyncPolicy> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-h-'));
  const srcDir = path.join(root, 'src');
  const dataDir = path.join(root, 'data');
  const spec = opts.spec ?? baseSpec();
  writeSource(srcDir, spec);

  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const free = { freeBytes: 1e12, totalBytes: 2e12 };
  const policy: SyncPolicy = {
    debounceMs: 10 * MIN,
    massDeletionRatio: 0.5,
    warnFreePct: 20,
    warnFreeBytes: 10e9,
    stopAssetsFreeBytes: 2e9,
    freeSpace: () => ({ ...free }),
    ...opts.policy,
  };
  const store = new LibraryStore(dataDir);
  const adapter = new PocketRisuAdapter('main', srcDir, async () => {});
  const syncer = new Syncer({ store, now: clock.now, policy });
  const rewrite = (mutate?: (s: SynSpec) => void, o?: { corruptChunk?: boolean }) => {
    mutate?.(spec);
    return writeSource(srcDir, spec, o);
  };
  return { root, srcDir, dataDir, spec, store, adapter, syncer, clock, free, policy, rewrite, sync: (o = {}) => syncer.syncSource(adapter, o) };
}
