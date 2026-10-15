import { describe, expect, it } from 'vitest';
import { applyHideRules, compileRules } from '../../web/src/lib/hide-rules';
import { applyImageRules } from '../../web/src/lib/image-rules';
import type { HideRule, ImageRule } from '../../web/src/lib/types';
import { transformInWorker, transformTexts, type TRule } from '../src/export/epub/transform.js';

const hide = (name: string, pattern: string, flags = 'g'): HideRule =>
  ({ id: name, scope: 'char', charId: 'c1', name, pattern, flags, enabled: true, origin: 'manual', createdAt: 1, updatedAt: 1 });
const img = (name: string, pattern: string, images: string[], flags = 'g'): ImageRule => ({ key: name, name, pattern, flags, images, enabled: true, slow: false });
const asT = (h: HideRule[], i: ImageRule[]): TRule[] => [
  ...h.map((r) => ({ kind: 'hide' as const, name: r.name, pattern: r.pattern, flags: r.flags })),
  ...i.map((r) => ({ kind: 'image' as const, name: r.name, pattern: r.pattern, flags: r.flags, images: r.images })),
];

const TEXTS = [
  '앞 <st>HP 1</st> 가운데 <표정=웃음> 끝',
  '<f=a><f=b> 두 개',
  '그대로인 문장',
  '이름 <n=마루> 과 $ 기호',
  'x'.repeat(200_001) + '<표정=웃음>',
];
const HIDE = [hide('상태', '<st>[\\s\\S]*?</st>'), hide('대소문자', 'HP', 'gi')];
const IMG = [img('표정', '<표정=([^>]+)>', ['$1', '고정']), img('f', '<f=(\\w)>', ['face-$1']), img('이름', '<n=(?<who>[^>]+)>', ['$<who>', '$&', '$$', '$0'])];

describe('transform (same results as the web reader)', () => {
  it('matches web applyHideRules → applyImageRules for every text', () => {
    const web = TEXTS.map((t) => applyImageRules(applyHideRules(t, compileRules(HIDE)), IMG));
    expect(transformTexts(TEXTS, asT(HIDE, IMG), () => {})).toEqual(web);
  });

  it('skips rules that do not compile or match the empty string, like the web', () => {
    const bad = [img('깨짐', '(', ['x']), img('빈', 'a*', ['x'])];
    expect(transformTexts(['aaa (b)'], asT([], bad), () => {})).toEqual([applyImageRules('aaa (b)', bad)]);
  });

  it('skips invalid hide rules like web compileRules (empty match, bad flags, bad name)', () => {
    const rules = [hide('빈', 'a*'), hide('깨짐', '('), hide('플래그', 'b', 'gx'), hide('', 'c'), hide('정상', 'd')];
    const t = ['abcd aaa'];
    expect(transformTexts(t, asT(rules, []), () => {})).toEqual(t.map((x) => applyHideRules(x, compileRules(rules))));
  });

  it('normalises hide flags like web normalizeFlags (dedupe), leaves image flags raw', () => {
    const h = [hide('중복', 'abc', 'ii'), hide('순서', 'x', 'sig')];
    const i = [img('그림', 'Q', ['q-pic'], 'g')];
    const t = ['ABC abc X x\nQ'];
    expect(transformTexts(t, asT(h, i), () => {})).toEqual(t.map((x) => applyImageRules(applyHideRules(x, compileRules(h)), i)));
    const bad = [img('깨짐', 'a', ['p'], 'ii')]; // 웹 그림 규칙은 정규화하지 않아 컴파일이 실패하고 건너뛴다
    expect(transformTexts(['aa'], asT([], bad), () => {})).toEqual([applyImageRules('aa', bad)]);
  });

  it('runs in a worker and returns the same texts', async () => {
    const r = await transformInWorker(TEXTS.slice(0, 4), asT(HIDE, IMG), 5_000);
    expect(r).toEqual({ texts: transformTexts(TEXTS.slice(0, 4), asT(HIDE, IMG), () => {}), slowRules: [] });
  });

  it('drops a rule that exceeds its time budget, keeps the others, and reports its name', async () => {
    const evil = { kind: 'hide' as const, name: '느린 규칙', pattern: '(a+)+$', flags: 'g' };
    const ok = { kind: 'hide' as const, name: '빠른 규칙', pattern: '끝', flags: 'g' };
    const r = await transformInWorker([`${'a'.repeat(40)}b 끝`], [evil, ok], 300);
    expect(r.slowRules).toEqual(['느린 규칙']);
    expect(r.texts).toEqual([`${'a'.repeat(40)}b `]);
  });

  it('stops retrying after 3 slow rules: original texts, every rule reported as not applied', async () => {
    const evil = (n: string) => ({ kind: 'hide' as const, name: n, pattern: '(a+)+$', flags: 'g' });
    const ok = { kind: 'hide' as const, name: '빠른 규칙', pattern: '끝', flags: 'g' };
    const texts = [`${'a'.repeat(40)}b 끝`];
    const r = await transformInWorker(texts, [evil('느림1'), evil('느림2'), evil('느림3'), ok], 200);
    expect(r.texts).toEqual(texts);
    expect(r.slowRules).toEqual(['느림1', '느림2', '느림3', '빠른 규칙']);
  });

  it('no texts → returned without a worker', async () => {
    expect(await transformInWorker([], [{ kind: 'hide', name: 'x', pattern: 'a', flags: 'g' }], 10)).toEqual({ texts: [], slowRules: [] });
  });

  it('no rules → texts unchanged without a worker', async () => {
    expect(await transformInWorker(['그대로'], [], 10)).toEqual({ texts: ['그대로'], slowRules: [] });
  });
});
