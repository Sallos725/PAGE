import sharp from 'sharp';

// EPUB 그림 변환 (스펙 X8). 라이브러리 원본은 그대로 두고 내보낼 때만 변환한다.
export type ImageMode = 'small' | 'compat' | 'original';
export const IMAGE_MODES: ImageMode[] = ['small', 'compat', 'original'];
export type ConvertedImage = { bytes: Uint8Array; mime: string; ext: string };

/** 넣을 수 있는 입력 형식. SVG 등은 넣지 않는다. */
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** 변환·삽입할 수 있는 입력 형식인가 (SVG 등은 아니다). */
export const isConvertible = (mime: string): boolean => Object.hasOwn(EXT, mime);
const MAX_SIDE = 1600;
// 그림은 내보낼 때마다 한 번씩만 쓰므로 libvips 연산 캐시는 필요 없다 (메모리만 잡아먹는다).
sharp.cache(false);
// 40M 픽셀 상한: 디코드된 RGBA 가 그림 하나당 약 160MB 를 넘지 않게 한다 (실제 그림은 약 1M 픽셀).
const SHARP_INPUT = { failOn: 'none', limitInputPixels: 40_000_000 } as const;

/**
 * small = 긴 변 ≤1600 WebP q82 (투명 유지), compat = 긴 변 ≤1600 흰 바탕 flatten 후 JPEG q85 mozjpeg,
 * original = 그대로. GIF 는 첫 프레임만. 입력 형식이 아니면 null, 변환 실패는 throw (호출 쪽이 센다).
 */
export async function convertImage(input: Uint8Array, mime: string, mode: ImageMode): Promise<ConvertedImage | null> {
  const ext = EXT[mime];
  if (!ext) return null;
  if (mode === 'original') return { bytes: input, mime, ext };
  const img = sharp(input, SHARP_INPUT).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
  if (mode === 'small') {
    return { bytes: await img.webp({ quality: 82 }).toBuffer(), mime: 'image/webp', ext: 'webp' };
  }
  return { bytes: await img.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer(), mime: 'image/jpeg', ext: 'jpg' };
}
