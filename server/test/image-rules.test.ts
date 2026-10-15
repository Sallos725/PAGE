import { describe, expect, it } from 'vitest';
import { extractImageRules } from '../src/source/pocketrisu/image-rules.js';

const ds = (o: Record<string, unknown>) => ({ type: 'editdisplay', in: '<f=(\\w+)>', out: '', ...o });

describe('extractImageRules', () => {
  it('keeps <img src={{raw::…}}> outside CBS blocks with literal or capture templates, never the out HTML', () => {
    const rules = extractImageRules([
      ds({ comment: '표정', out: '<div class="x"><img src="{{raw::$1}}"></div>' }),
      ds({ comment: '고정', in: '<g>', out: "<img class='a' src='{{img::face}}' alt=''>" }),
      ds({ comment: '이름 그룹', in: '<n=(?<who>\\w+)>', out: '<img src="{{asset::$<who>}}">' }),
    ]);
    expect(rules.map((r) => [r.name, r.images])).toEqual([['표정', ['$1']], ['고정', ['face']], ['이름 그룹', ['$<who>']]]);
    expect(JSON.stringify(rules)).not.toContain('class');
    expect(rules[0]!.flag).toBe('g');
    expect(rules[0]!.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('skips images inside {{#…}} blocks, CBS names, CSS backgrounds and non-display scripts', () => {
    const rules = extractImageRules([
      ds({ out: '{{#if {{getvar::x}}}}<img src="{{raw::a}}">{{/if}}<img src="{{raw::b}}">' }),
      ds({ in: '<c>', out: '<img src="{{raw::{{char}}_face}}">' }),
      ds({ in: '<d>', out: '<div style="background:url({{raw::bg}})"></div>' }),
      { type: 'editoutput', in: 'x', out: '<img src="{{raw::z}}">' },
      ds({ in: '', out: '<img src="{{raw::e}}">' }),
      ds({ in: 'x'.repeat(501), out: '<img src="{{raw::e}}">' }),
      'garbage',
    ]);
    expect(rules.map((r) => r.images)).toEqual([['b']]);
  });

  it('key is stable for the same rule and changes when the rule changes', () => {
    const a = extractImageRules([ds({ out: '<img src="{{raw::$1}}">' })])[0]!;
    const b = extractImageRules([ds({ out: '<img src="{{raw::$1}}">' })])[0]!;
    const c = extractImageRules([ds({ out: '<img src="{{raw::$1}}"><img src="{{raw::x}}">' })])[0]!;
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });

  it('respects limits (50 rules, 10 images each) and flag normalization', () => {
    const many = Array.from({ length: 60 }, (_, i) => ds({ in: `<a${i}>`, out: '<img src="{{raw::x}}">' }));
    expect(extractImageRules(many)).toHaveLength(50);
    const imgs = '<img src="{{raw::x}}">'.repeat(12);
    expect(extractImageRules([ds({ out: imgs })])[0]!.images).toHaveLength(10);
    expect(extractImageRules([ds({ ableFlag: true, flag: 'is<order 1>', out: '<img src="{{raw::x}}">' })])[0]!.flag).toBe('is');
  });
});
