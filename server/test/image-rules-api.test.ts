import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { StateStore } from '../src/state/store.js';
import { baseSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

async function setup() {
  const s = baseSpec();
  s.characters[0]!.customscript = [{ comment: '표정', in: '<f=(\\w+)>', out: '<img src="{{raw::$1}}">', type: 'editdisplay' }];
  const h = makeHarness({ spec: s });
  await h.sync();
  const state = new StateStore(h.dataDir);
  const app = await buildApp({ adapters: [h.adapter], store: h.store, syncer: h.syncer, policy: h.policy, now: h.clock.now, state });
  opened.push(app);
  return { h, app };
}
const j = (r: { body: string }) => JSON.parse(r.body);

describe('image rules API', () => {
  it('lists rules enabled by default with slow=false, toggles persist per character', async () => {
    const { app } = await setup();
    const list = j(await app.inject('/api/state/image-rules?source=main&char=c1')).rules as { key: string; name: string; pattern: string; flags: string; images: string[]; enabled: boolean; slow: boolean }[];
    expect(list).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{16}$/), name: '표정', pattern: '<f=(\\w+)>', flags: 'g', images: ['$1'], enabled: true, slow: false }]);
    const key = list[0]!.key;
    const off = await app.inject({ method: 'PUT', url: `/api/state/image-rules/${key}?source=main&char=c1`, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(j(await app.inject('/api/state/image-rules?source=main&char=c1')).rules[0].enabled).toBe(false);
    await app.inject({ method: 'PUT', url: `/api/state/image-rules/${key}?source=main&char=c1`, payload: { enabled: true } });
    expect(j(await app.inject('/api/state/image-rules?source=main&char=c1')).rules[0].enabled).toBe(true);
    expect(j(await app.inject('/api/state/image-rules?source=main&char=c2')).rules).toEqual([]);
  });

  it('validates the target', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/state/image-rules?source=main&char=nope')).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/state/image-rules/0123456789abcdef?source=main&char=c1', payload: { enabled: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/state/image-rules/zz?source=main&char=c1', payload: { enabled: false } })).statusCode).toBe(400);
  });
});
