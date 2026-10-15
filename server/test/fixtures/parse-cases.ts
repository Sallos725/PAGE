import type { Block } from '../../src/shared/blocks.js';

// 파서 기대값 표 — 웹(happy-dom DOMParser)과 서버(linkedom)가 같은 결과를 내야 한다 (스펙 2.5 X6). 내용은 합성.
export const AM = 'Alice.__am__.chat.00000001-2222-3333-4444-555555555555';
const projection = (name: string, extra = '') =>
  `<div class="am-illustration-projection" data-am-message-id="m1" data-am-slot-id="illustration:m1:slot:001" data-am-chat-history-revision-id="revision:t:1" data-am-asset="${name}">` +
  `<span class="am-image" style="--am-chat-image-width:90%;width:calc(100% - 4px)"><img class="am-image__media" data-am-asset="${name}" src="{{raw::${name}}}" width="832" height="1216" alt="" loading="lazy" style="max-width:100%"></span>${extra}</div>`;
const amImage: Block = { kind: 'image', assetName: AM, width: 832, height: 1216, slotId: 'illustration:m1:slot:001', revisionId: 'revision:t:1' };

export const PARSE_CASES: { name: string; input: string; expected: Block[] }[] = [
  { name: 'newlines split paragraphs, blank lines dropped', input: '첫째 줄\n\n  둘째 줄  \n', expected: [{ kind: 'paragraph', text: '첫째 줄' }, { kind: 'paragraph', text: '둘째 줄' }] },
  {
    name: 'fully quoted lines are dialogue, mixed narration stays a paragraph',
    input: '"안녕하세요."\n“좋은 아침”\n「こんにちは」\n"가," 그가 말했다. "나."\n그는 "응" 이라고 했다',
    expected: [
      { kind: 'dialogue', text: '"안녕하세요."' }, { kind: 'dialogue', text: '“좋은 아침”' }, { kind: 'dialogue', text: '「こんにちは」' },
      { kind: 'paragraph', text: '"가," 그가 말했다. "나."' }, { kind: 'paragraph', text: '그는 "응" 이라고 했다' },
    ],
  },
  { name: 'control syntax kept as text', input: '{{char}} says {{getvar::x}}', expected: [{ kind: 'paragraph', text: '{{char}} says {{getvar::x}}' }] },
  { name: 'standalone raw marker becomes an image', input: `앞\n{{raw::${AM}}}\n뒤`, expected: [{ kind: 'paragraph', text: '앞' }, { kind: 'image', assetName: AM }, { kind: 'paragraph', text: '뒤' }] },
  { name: 'Asset Maid projection → one image with size, slot, revision', input: projection(AM), expected: [amImage] },
  {
    name: 'hidden regeneration history excluded',
    input: projection(AM, '<span class="am-illustration-history-sources" style="display:none!important"><img class="am-illustration-history-source" data-am-asset="OLD.__am__.chat.00000009-2222-3333-4444-555555555555" src="{{raw::OLD}}"></span><div class="am-illustration-history-bank" hidden>x</div>'),
    expected: [amImage],
  },
  { name: 'text around the illustration in order', input: `서두\n${projection(AM)}\n맺음`, expected: [{ kind: 'paragraph', text: '서두' }, amImage, { kind: 'paragraph', text: '맺음' }] },
  {
    name: 'script/style/iframe and external images dropped',
    input: '앞 <script>window.__xss=1</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><img src="https://evil.example/x.png"><img src=x onerror="window.__xss=2"> 뒤',
    expected: [{ kind: 'paragraph', text: '앞' }, { kind: 'paragraph', text: '뒤' }],
  },
  {
    name: 'tags stripped to text',
    input: '<p>문단 <b>굵게</b> <a href="javascript:alert(1)">링크</a></p><blockquote>인용</blockquote>',
    expected: [{ kind: 'paragraph', text: '문단 굵게 링크' }, { kind: 'paragraph', text: '인용' }],
  },
  { name: 'br and hr', input: '가<br>나<hr>다', expected: [{ kind: 'paragraph', text: '가' }, { kind: 'paragraph', text: '나' }, { kind: 'divider' }, { kind: 'paragraph', text: '다' }] },
  { name: 'non-raw image src ignored', input: '<img src="/api/asset/main/c1/secret">', expected: [] },
  { name: 'empty', input: '', expected: [] },
  { name: 'whitespace only', input: '  \n \n', expected: [] },
  { name: 'implied block closing', input: 'a <p>b <div>c</div> d', expected: [{ kind: 'paragraph', text: 'a' }, { kind: 'paragraph', text: 'b' }, { kind: 'paragraph', text: 'c' }, { kind: 'paragraph', text: 'd' }] },
  { name: 'escaped entities become text', input: '&lt;tag&gt; &amp; 끝', expected: [{ kind: 'paragraph', text: '<tag> & 끝' }] },
  { name: 'non-ASCII after < is text, not a tag', input: '[c1] 웃었다 <표정=웃음> 끝', expected: [{ kind: 'paragraph', text: '[c1] 웃었다 <표정=웃음> 끝' }] },
  { name: 'a lone < with a space is text', input: 'a < b 그리고 c<3', expected: [{ kind: 'paragraph', text: 'a < b 그리고 c<3' }] },
  { name: 'bare CR separates paragraphs', input: 'line1\rline2', expected: [{ kind: 'paragraph', text: 'line1' }, { kind: 'paragraph', text: 'line2' }] },
];
