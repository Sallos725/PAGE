import { buildApp } from './api/app.js';
import fs from 'node:fs';
import path from 'node:path';
import { loggerOptions } from './api/logging.js';
import { loadConfig, makePolicy } from './config.js';
import { LibraryStore } from './library/store.js';
import { PocketRisuAdapter } from './source/pocketrisu/adapter.js';
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
const adapters = config.sources.map((s) => new PocketRisuAdapter(s.id, s.dir));
const syncer = new Syncer({ store, now: Date.now, policy });
const exportManager = new ExportManager({ dir: path.join(config.dataDir, 'exports'), now: Date.now, onError: (code) => app.log.error({ code }, 'export failed') });
const app = await buildApp({ adapters, store, state, appearance, syncer, policy, exportManager, exportImageBudgetBytes: config.exportImageBudgetBytes, pdfUrl: config.pdfUrl, webDir: config.webDir, now: Date.now, logger: loggerOptions(process.env.LOG_LEVEL ?? 'info') });
const scheduler = new Scheduler({
  syncer, adapters, intervalMs: config.syncIntervalMs,
  onError: (id) => app.log.error({ source: id }, 'scheduled sync failed'),
});

await app.listen({ host: config.bind, port: config.port });
scheduler.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    scheduler.stop();
    void app.close().then(() => { store.close(); state.close(); process.exit(0); });
  });
}
