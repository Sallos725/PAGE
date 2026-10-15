import { describe, expect, it } from 'vitest';
import { computeRuleNames, ruleNamesInWorker } from '../src/sync/image-rule-names.js';

const rule = (o: Partial<{ in: string; flag: string; images: string[] }> = {}) => ({ key: 'k', name: 'n', in: '<f=(\\w+)>', flag: 'g', images: ['$1'], ...o });

describe('computeRuleNames (same rules as the web)', () => {
  it('expands $n, $<name>, $& and $$ per match, per chat', () => {
    const chats = [['a <f=smile> b <f=sad>', '없음'], ['<f=wink>']];
    expect(computeRuleNames(chats, [rule()])).toEqual([['smile', 'sad'], ['wink']]);
    expect(computeRuleNames([['<n=al>']], [rule({ in: '<n=(?<who>\\w+)>', images: ['$<who>_face', 'fixed'] })])).toEqual([['al_face', 'fixed']]);
    expect(computeRuleNames([['<x>']], [rule({ in: '<x>', images: ['p$&q', 'a$$b'] })])).toEqual([['p<x>q', 'a$b']]);
  });
  it('drops invalid names, empty-match and broken patterns, and oversized messages', () => {
    expect(computeRuleNames([['<f=a>']], [rule({ images: ['{$1}', '  ', 'ok'] })])).toEqual([['ok']]);
    expect(computeRuleNames([['abc']], [rule({ in: 'x*' }), rule({ in: '(' })])).toEqual([[]]);
    expect(computeRuleNames([[`<f=a>${'x'.repeat(200_000)}`]], [rule()])).toEqual([[]]);
  });
  it('is self-contained (can be stringified into a worker)', () => {
    const fn = new Function(`return (${computeRuleNames.toString()})`)() as typeof computeRuleNames;
    expect(fn([['<f=a>']], [rule()])).toEqual([['a']]);
  });
});

describe('ruleNamesInWorker', () => {
  it('returns names from a worker thread', async () => {
    expect(await ruleNamesInWorker([['<f=a>']], [rule()], 2000)).toEqual({ names: [['a']] });
  });
  it('reports slow when the time budget runs out', async () => {
    const evil = rule({ in: '(a+)+$', images: ['x'] });
    const r = await ruleNamesInWorker([[`${'a'.repeat(40)}!`]], [evil], 100);
    expect(r).toEqual({ slow: true });
  });
});
