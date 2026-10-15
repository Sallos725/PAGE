import { buildApp } from './api/app.js';
import fs from 'node:fs';
import path from 'node:path';
import { loggerOptions } from './api/logging.js';
import { loadConfig, makePolicy } from './config.js';
import { ImportStore } from './import/store.js';
import { LibraryStore } from './library/store.js';
import { makeBrowser } from './portable/browse.js';
import { RESTART_CODE } from './portable/settings.js';
import { makeShutdown } from './portable/shutdown.js';
import { ImportAdapter } from './source/import/adapter.js';
import { PocketRisuAdapter } from './source/pocketrisu/adapter.js';
import type { SourceAdapter } from './source/types.js';
import { Scheduler } from './sync/scheduler.js';
import { AppearanceStore } from './state/appearance.js';
import { StateStore } from './state/store.js';
import { Syncer } from './sync/syncer.js';
import { ExportManager } from './export/jobs.js';

const config = loadConfig(process.env);
if (config.webDir && !fs.existsSync(path.join(config.webDir, 'index.html'))) {
  throw new Error('PAGE_WEB_DIR has no index.html (run the web build)');
}
const store = new LibraryStore(config.dataDir);
const state = new StateStore(config.dataDir);
const appearance = new AppearanceStore(state.db, config.dataDir);
const policy = makePolicy(config);
const imports = config.importEnabled ? new ImportStore(config.dataDir) : null;
const adapters: SourceAdapter[] = [
  ...config.sources.map((s) => new PocketRisuAdapter(s.id, s.dir)),
  ...(imports ? [new ImportAdapter(imports)] : []),
];
const syncer = new Syncer({ store, now: Date.now, policy });
const exportManager = new ExportManager({ dir: path.join(config.dataDir, 'exports'), now: Date.now, onError: (code) => app.log.error({ code }, 'export failed') });
const app = await buildApp({ adapters, imports: imports ?? undefined, store, state, appearance, syncer, policy, exportManager, exportImageBudgetBytes: config.exportImageBudgetBytes, pdfUrl: config.pdfUrl, webDir: config.webDir, allowedHosts: config.allowedHosts, portable: config.portable,
  portableApi: config.portable ? { dataDir: config.dataDir, platform: process.platform, browse: makeBrowser({ platform: process.platform }), restart: () => shutdown(RESTART_CODE) } : undefined,
  now: Date.now, logger: loggerOptions(process.env.LOG_LEVEL ?? 'info') });
const scheduler = new Scheduler({
  syncer, adapters, intervalMs: config.syncIntervalMs,
  onError: (id) => app.log.error({ source: id }, 'scheduled sync failed'),
});

// 한 번만 닫는다. 닫기가 실패하거나 4초(timeoutMs)를 넘기면 그냥 끝낸다
const shutdown = makeShutdown({
  close: async () => {
    scheduler.stop();
    try { await app.close(); } finally { try { store.close(); } finally { state.close(); } }
  },
  exit: (code) => process.exit(code),
  timeoutMs: 4000,
});

await app.listen({ host: config.bind, port: config.port });
scheduler.start();

// SIGHUP: Windows 에서 콘솔 창을 닫을 때 온다
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(0));
if (config.settingsBroken) app.log.warn('portable settings unreadable; starting without a source'); // 경로는 남기지 않는다
