import { describe, expect, it } from 'vitest';
import { PNG, baseSpec, chat, type SynSpec } from './helpers/synthetic-source.js';
import { makeHarness } from './helpers/harness.js';

const FACE = { comment: '표정', in: '<f=(\\w+)>', out: '<div><img src="{{raw::$1}}"></div>', type: 'editdisplay' };
function spec(): SynSpec {
  const s = baseSpec();
  s.characters[0]!.chats.push(chat('face', ['안녕', '그녀가 웃었다 <f=smile> 끝']));
  s.manifests = [{ kind: 'character', ownerId: 'c1', items: [['smile', 'assets/smile.png', 'png'], ['sad', 'assets/sad.png', 'png']] }];
  s.assets = { 'assets/smile.png': PNG(41), 'assets/sad.png': PNG(42) };
  return s;
}

describe('card image rules in sync', () => {
  it('puts imageRules in the character meta (no out HTML)', async () => {
    const s = spec();
    s.characters[0]!.customscript = [FACE];
    const h = makeHarness({ spec: s });
    await h.sync();
    const meta = h.store.getCharMeta('main', 'c1')!;
    expect(meta.imageRules).toEqual([expect.objectContaining({ name: '표정', images: ['$1'] })]);
    expect(JSON.stringify(meta)).not.toContain('<div>');
  });

  it('preserves images referenced only through a rule', async () => {
    const s = spec();
    s.characters[0]!.customscript = [FACE];
    const h = makeHarness({ spec: s });
    await h.sync();
    const hash = h.store.findAssetHash('main', 'c1', 'smile');
    expect(hash).not.toBeNull();
    expect(h.store.hasAsset(hash!)).toBe(true);
    expect(h.store.findAssetHash('main', 'c1', 'sad')).toBeNull(); // 쓰이지 않은 그림은 복사하지 않는다
  });

  it('fills the current version when a rule appears later without a new chat version', async () => {
    const h = makeHarness({ spec: spec() });
    await h.sync();
    expect(h.store.findAssetHash('main', 'c1', 'smile')).toBeNull();
    h.rewrite((x) => { x.characters[0]!.customscript = [FACE]; });
    h.clock.advance(60_000);
    const r = await h.sync({ force: true });
    expect(r.chats.edited + r.chats.appended).toBe(0); // 채팅은 그대로
    expect(h.store.findAssetHash('main', 'c1', 'smile')).not.toBeNull();
  });

  it('marks a character slow when its rules run out of time, and sync still finishes', async () => {
    const s = spec();
    s.characters[0]!.customscript = [{ ...FACE, in: '(a+)+$', out: '<img src="{{raw::smile}}">' }];
    s.characters[0]!.chats.push(chat('evil', [`${'a'.repeat(40)}!`]));
    const h = makeHarness({ spec: s, policy: {} });
    (h.syncer as unknown as { imageRuleBudgetMs: number }).imageRuleBudgetMs = 100;
    const r = await h.sync();
    expect(r.errors).toBe(0);
    const keys = (h.store.getCharMeta('main', 'c1')!.imageRules as { key: string }[]).map((x) => x.key);
    expect(h.store.imageRulesSlow('main', 'c1')).toEqual(new Set(keys));
  });
});
