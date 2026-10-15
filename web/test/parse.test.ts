import { describe, expect, it } from 'vitest';
import { blockText } from '../src/lib/blocks';
import { parseMessage } from '../src/lib/parse';

const AM = 'Alice.__am__.chat.00000001-2222-3333-4444-555555555555';
// storage-notes 7.5 의 저장 원문 구조 (합성 값)
const projection = (name: string, extra = '') =>
  `<div class="am-illustration-projection" data-am-message-id="m1" data-am-slot-id="illustration:m1:slot:001" data-am-chat-history-revision-id="revision:t:1" data-am-asset="${name}">` +
  `<span class="am-image" style="--am-chat-image-width:90%;width:calc(100% - 4px)"><img class="am-image__media" data-am-asset="${name}" src="{{raw::${name}}}" width="832" height="1216" alt="" loading="lazy" style="max-width:100%"></span>${extra}</div>`;

describe('plain text', () => {
  it('splits on newlines into paragraphs and drops blank lines', () => {
    expect(parseMessage('첫째 줄\n\n  둘째 줄  \n')).toEqual([
      { kind: 'paragraph', text: '첫째 줄' },
      { kind: 'paragraph', text: '둘째 줄' },
    ]);
  });

  it('marks fully-quoted lines as dialogue; mixed narration stays a paragraph (text is never lost)', () => {
    const blocks = parseMessage('"안녕하세요."\n“좋은 아침”\n「こんにちは」\n"가," 그가 말했다. "나."\n그는 "응" 이라고 했다');
    expect(blocks.map((b) => b.kind)).toEqual(['dialogue', 'dialogue', 'dialogue', 'paragraph', 'paragraph']);
    expect(blocks.map((b) => blockText(b))).toEqual(['"안녕하세요."', '“좋은 아침”', '「こんにちは」', '"가," 그가 말했다. "나."', '그는 "응" 이라고 했다']);
  });

  it('keeps unknown control syntax as-is (v1: no CBS evaluation)', () => {
    expect(parseMessage('{{char}} says {{getvar::x}}')).toEqual([{ kind: 'paragraph', text: '{{char}} says {{getvar::x}}' }]);
  });

  it('turns a standalone {{raw::NAME}} into an image block between paragraphs', () => {
    expect(parseMessage(`앞\n{{raw::${AM}}}\n뒤`)).toEqual([
      { kind: 'paragraph', text: '앞' },
      { kind: 'image', assetName: AM },
      { kind: 'paragraph', text: '뒤' },
    ]);
  });
});

describe('Asset Maid illustration projection (spike 0: stored text is the finished HTML)', () => {
  it('becomes one image block with size/slot/revision and no style or class', () => {
    const blocks = parseMessage(projection(AM));
    expect(blocks).toEqual([
      { kind: 'image', assetName: AM, width: 832, height: 1216, slotId: 'illustration:m1:slot:001', revisionId: 'revision:t:1' },
    ]);
    expect(JSON.stringify(blocks)).not.toMatch(/style|class|calc\(/);
  });

  it('hidden regeneration history is excluded from the visible blocks', () => {
    const history =
      `<span class="am-illustration-history-sources" style="display:none!important"><img class="am-illustration-history-source" data-am-asset="OLD.__am__.chat.00000009-2222-3333-4444-555555555555" src="{{raw::OLD}}"></span>` +
      `<div class="am-illustration-history-bank" hidden>x</div>`;
    const blocks = parseMessage(projection(AM, history));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'image', assetName: AM });
  });

  it('text around the illustration is preserved in order', () => {
    const blocks = parseMessage(`서두\n${projection(AM)}\n맺음`);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'image', 'paragraph']);
  });
});

describe('untrusted HTML is data, never markup (R7)', () => {
  it('drops script/style/iframe etc. with their content, and external or unknown images', () => {
    const blocks = parseMessage(
      '앞 <script>window.__xss=1</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe>' +
      '<img src="https://evil.example/x.png"><img src=x onerror="window.__xss=2"> 뒤',
    );
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
    expect(blocks.map((b) => blockText(b)).join(' ').replace(/\s+/g, ' ').trim()).toBe('앞 뒤');
    expect(JSON.stringify(blocks)).not.toMatch(/__xss|evil|display:none|<script|onerror/);
  });

  it('never emits HTML in text: tags are stripped to their text content', () => {
    const blocks = parseMessage('<p>문단 <b>굵게</b> <a href="javascript:alert(1)">링크</a></p><blockquote>인용</blockquote>');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: '문단 굵게 링크' },
      { kind: 'paragraph', text: '인용' },
    ]);
  });

  it('br and hr', () => {
    expect(parseMessage('가<br>나<hr>다')).toEqual([
      { kind: 'paragraph', text: '가' },
      { kind: 'paragraph', text: '나' },
      { kind: 'divider' },
      { kind: 'paragraph', text: '다' },
    ]);
  });

  it('an image src that is not a {{raw::}} reference is not honoured even with data-am-asset missing', () => {
    expect(parseMessage('<img src="/api/asset/main/c1/secret">')).toEqual([]);
  });

  it('empty and whitespace-only messages yield no blocks', () => {
    expect(parseMessage('')).toEqual([]);
    expect(parseMessage('  \n \n')).toEqual([]);
  });
});

import { PARSE_CASES } from '../../server/test/fixtures/parse-cases';

describe('shared parse cases (same table as the server parser)', () => {
  for (const c of PARSE_CASES) it(c.name, () => { expect(parseMessage(c.input)).toEqual(c.expected); });
});
