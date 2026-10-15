import { ApiError } from './api';
import type { EpubOptions, ExportFormat, ExportStatus, ExportWarnings, HideRule, ImageRule } from './types';

// 내보내기 패널의 순수 로직 (스펙 2.5 §3). 기본값은 지금 리더 상태를 따른다.
export function defaultEpubOptions(hide: HideRule[], images: ImageRule[], hideUser: boolean): EpubOptions {
  return {
    includeUser: !hideUser,
    cover: true,
    cardImages: true,
    chatImages: true,
    hideRuleIds: hide.filter((r) => r.enabled).map((r) => r.id),
    imageRuleKeys: images.filter((r) => r.enabled && !r.slow).map((r) => r.key),
    imageMode: 'small',
  };
}

export const toggleId = (list: string[], id: string, on: boolean): string[] =>
  on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);

const ERROR_TEXT: Record<string, string> = {
  internal: '만들지 못했어요.',
  'pdf-busy': 'PDF 를 만드는 중인 작업이 있어요. 잠시 뒤에 다시 해 주세요.',
  'pdf-failed': 'PDF 를 만들지 못했어요.',
};

type ImageMode = EpubOptions['imageMode'];

/**
 * 형식을 바꿀 때 그림 크기를 어떻게 할지. 사용자가 직접 고른 값(chosen)은 건드리지 않는다.
 * PDF 로 가면 기본 small 은 쓸 수 없어 compat 으로, EPUB 으로 돌아오면 직접 고른 게 없을 때 small 로 되돌린다.
 */
export function imageModeOnFormatChange(format: ExportFormat, mode: ImageMode, chosen: boolean): ImageMode {
  if (format === 'pdf') return mode === 'small' ? 'compat' : mode;
  if (format === 'epub' && !chosen && mode === 'compat') return 'small';
  return mode;
}

export function statusText(s: ExportStatus): string {
  switch (s.state) {
    case 'queued': return '차례를 기다리는 중…';
    case 'running': return '만드는 중…';
    case 'done': return '다 됐어요!';
    case 'failed': return ERROR_TEXT[s.error ?? ''] ?? '만들지 못했어요.';
  }
}

/** 시작·상태 확인 요청이 던진 오류 → 문구. 상태 확인에서 404 는 작업이 사라진 것(서버 재시작·만료). */
export function exportErrorText(status: number | null, phase: 'start' | 'poll'): string {
  if (status === 429) return '내보내기가 밀려 있어요. 잠시 뒤에 다시 해 주세요.';
  if (status === 404 && phase === 'poll') return '작업을 찾을 수 없어요. 다시 만들어 주세요.';
  if (phase === 'poll') return '상태를 확인하지 못했어요. 작업은 계속될 수 있으니 잠시 뒤 다시 만들어 주세요.';
  return '시작하지 못했어요.';
}

export function warningLines(w: ExportWarnings | undefined): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.missingImages > 0) out.push(`찾지 못한 그림 ${w.missingImages}개는 빠졌어요.`);
  if (w.skippedImages > 0) out.push(`형식이 맞지 않거나 변환에 실패했거나 용량 한도를 넘어 뺀 그림 ${w.skippedImages}개`);
  if (w.slowRules.length > 0) out.push(`느려서 적용하지 않은 규칙: ${w.slowRules.join(', ')}`);
  return out;
}

const TRANSIENT_STATUS = new Set([502, 503, 504]);
/** 네트워크가 잠깐 끊긴 것(fetch 의 TypeError)이나 프록시·서버 재시작(502/503/504)은 다시 시도할 만하다. */
export const isTransient = (e: unknown): boolean => (e instanceof ApiError ? TRANSIENT_STATUS.has(e.status) : e instanceof TypeError);

type PollOpts = { onStatus: (s: ExportStatus) => void; sleep: (ms: number) => Promise<void>; alive: () => boolean; maxRetries?: number };

/**
 * 작업이 done/failed 가 될 때까지 1초마다 상태를 본다. 일시적 오류는 1·2·4·8초 간격으로 최대 4번 기다렸다 다시 시도하고,
 * 연속 maxRetries(기본 5)번째 실패면 마지막 오류를 던진다. 패널이 닫히면(alive=false) null.
 */
export async function pollExport(get: () => Promise<ExportStatus>, o: PollOpts): Promise<ExportStatus | null> {
  const max = o.maxRetries ?? 5;
  let fails = 0;
  while (o.alive()) {
    let s: ExportStatus;
    try {
      s = await get();
    } catch (e) {
      if (!isTransient(e) || fails >= max - 1) throw e;
      await o.sleep(Math.min(8000, 1000 * 2 ** fails));
      fails += 1;
      continue;
    }
    fails = 0;
    if (!o.alive()) return null;
    o.onStatus(s);
    if (s.state === 'done' || s.state === 'failed') return s;
    await o.sleep(1000);
  }
  return null;
}
