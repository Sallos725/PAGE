import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { defaultEpubOptions, exportErrorText, imageModeOnFormatChange, pollExport, statusText, toggleId, warningLines } from '../src/lib/export-options';
import type { ExportStatus, HideRule, ImageRule } from '../src/lib/types';

const hide = (id: string, enabled: boolean): HideRule => ({ id, scope: 'char', charId: 'c1', name: id, pattern: 'x', flags: 'g', enabled, origin: 'manual', createdAt: 1, updatedAt: 1 });
const img = (key: string, enabled: boolean, slow = false): ImageRule => ({ key, name: key, pattern: 'x', flags: 'g', images: ['$1'], enabled, slow });

describe('export options', () => {
  it('defaults: every image toggle on, rules checked as the reader has them, user messages follow the hide setting', () => {
    expect(defaultEpubOptions([hide('h1', true), hide('h2', false)], [img('a', true), img('b', false), img('c', true, true)], false)).toEqual({
      includeUser: true, cover: true, cardImages: true, chatImages: true, hideRuleIds: ['h1'], imageRuleKeys: ['a'], imageMode: 'small',
    });
    expect(defaultEpubOptions([], [], true).includeUser).toBe(false);
  });

  it('toggleId adds once and removes', () => {
    expect(toggleId(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  it('status and warning text', () => {
    expect(statusText({ jobId: 'j', state: 'queued', format: 'json' })).toBe('차례를 기다리는 중…');
    expect(statusText({ jobId: 'j', state: 'running', format: 'epub' })).toBe('만드는 중…');
    expect(statusText({ jobId: 'j', state: 'done', format: 'epub' })).toBe('다 됐어요!');
    expect(statusText({ jobId: 'j', state: 'failed', format: 'epub', error: 'internal' })).toBe('만들지 못했어요.');
    expect(statusText({ jobId: 'j', state: 'failed', format: 'epub', error: 'whatever' })).toBe('만들지 못했어요.');
    expect(statusText({ jobId: 'j', state: 'failed', format: 'pdf', error: 'pdf-busy' })).toBe('PDF 를 만드는 중인 작업이 있어요. 잠시 뒤에 다시 해 주세요.');
    expect(statusText({ jobId: 'j', state: 'failed', format: 'pdf', error: 'pdf-failed' })).toBe('PDF 를 만들지 못했어요.');
    expect(warningLines(undefined)).toEqual([]);
    expect(warningLines({ missingImages: 0, skippedImages: 0, slowRules: [] })).toEqual([]);
    expect(warningLines({ missingImages: 2, skippedImages: 1, slowRules: ['규칙A', '규칙B'] })).toEqual([
      '찾지 못한 그림 2개는 빠졌어요.',
      '형식이 맞지 않거나 변환에 실패했거나 용량 한도를 넘어 뺀 그림 1개',
      '느려서 적용하지 않은 규칙: 규칙A, 규칙B',
    ]);
  });

  it('error text: 429 is busy, a vanished job (404 while polling) is its own message, the rest is a generic start failure', () => {
    expect(exportErrorText(429, 'start')).toBe('내보내기가 밀려 있어요. 잠시 뒤에 다시 해 주세요.');
    expect(exportErrorText(429, 'poll')).toBe('내보내기가 밀려 있어요. 잠시 뒤에 다시 해 주세요.');
    expect(exportErrorText(404, 'poll')).toBe('작업을 찾을 수 없어요. 다시 만들어 주세요.');
    expect(exportErrorText(404, 'start')).toBe('시작하지 못했어요.');
    expect(exportErrorText(500, 'start')).toBe('시작하지 못했어요.');
    expect(exportErrorText(null, 'start')).toBe('시작하지 못했어요.');
    // 상태 확인(poll)이 재시도 끝에 실패한 경우
    expect(exportErrorText(500, 'poll')).toBe('상태를 확인하지 못했어요. 작업은 계속될 수 있으니 잠시 뒤 다시 만들어 주세요.');
    expect(exportErrorText(503, 'poll')).toBe('상태를 확인하지 못했어요. 작업은 계속될 수 있으니 잠시 뒤 다시 만들어 주세요.');
    expect(exportErrorText(null, 'poll')).toBe('상태를 확인하지 못했어요. 작업은 계속될 수 있으니 잠시 뒤 다시 만들어 주세요.');
  });

  it('image size on format change: PDF has no 줄이기 (small → compat); back to EPUB restores small unless the user chose', () => {
    // PDF 로: small 이면 compat, 이미 compat/original 이면 그대로
    expect(imageModeOnFormatChange('pdf', 'small', false)).toBe('compat');
    expect(imageModeOnFormatChange('pdf', 'compat', false)).toBe('compat');
    expect(imageModeOnFormatChange('pdf', 'original', true)).toBe('original');
    // EPUB 으로 복귀: 직접 고른 게 없으면 compat → small, 고른 값은 보존
    expect(imageModeOnFormatChange('epub', 'compat', false)).toBe('small');
    expect(imageModeOnFormatChange('epub', 'compat', true)).toBe('compat');
    expect(imageModeOnFormatChange('epub', 'original', false)).toBe('original');
    expect(imageModeOnFormatChange('epub', 'small', false)).toBe('small');
    // JSON 은 그림 옵션이 없으니 건드리지 않는다
    expect(imageModeOnFormatChange('json', 'small', false)).toBe('small');
    expect(imageModeOnFormatChange('json', 'compat', false)).toBe('compat');
  });
});

const st = (state: ExportStatus['state']): ExportStatus => ({ state } as ExportStatus);

describe('pollExport', () => {
  it('polls until done, reporting each status', async () => {
    const seq = [st('queued'), st('running'), st('done')];
    const seen: string[] = [];
    const sleeps: number[] = [];
    const r = await pollExport(async () => seq.shift()!, { onStatus: (s) => seen.push(s.state), sleep: async (ms) => { sleeps.push(ms); }, alive: () => true });
    expect(r?.state).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('retries network errors and 502/503/504 with backoff, then continues', async () => {
    const calls: (() => Promise<ExportStatus>)[] = [
      async () => { throw new TypeError('Failed to fetch'); },
      async () => { throw new ApiError(503); },
      async () => st('done'),
    ];
    const sleeps: number[] = [];
    const r = await pollExport(() => calls.shift()!(), { onStatus: () => {}, sleep: async (ms) => { sleeps.push(ms); }, alive: () => true });
    expect(r?.state).toBe('done');
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('gives up after 5 transient failures in a row and rethrows the last', async () => {
    const r = pollExport(async () => { throw new TypeError('Failed to fetch'); }, { onStatus: () => {}, sleep: async () => {}, alive: () => true });
    await expect(r).rejects.toThrow('Failed to fetch');
  });

  it('does not retry other API errors (a vanished job is 404)', async () => {
    let n = 0;
    const r = pollExport(async () => { n += 1; throw new ApiError(404); }, { onStatus: () => {}, sleep: async () => {}, alive: () => true });
    await expect(r).rejects.toMatchObject({ status: 404 });
    expect(n).toBe(1);
  });

  it('stops quietly when the panel is gone', async () => {
    let alive = true;
    const r = await pollExport(async () => { alive = false; return st('running'); }, { onStatus: () => {}, sleep: async () => {}, alive: () => alive });
    expect(r).toBeNull();
  });
});
