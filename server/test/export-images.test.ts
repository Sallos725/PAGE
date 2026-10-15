import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage, IMAGE_MODES } from '../src/export/epub/images.js';

// 합성 그림만 쓴다 (실제 그림·내용은 쓰지 않는다).
const transparentPng = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

describe('convertImage', () => {
  it('lists the three modes', () => {
    expect(IMAGE_MODES).toEqual(['small', 'compat', 'original']);
  });

  it('small: WebP, long side capped at 1600, alpha kept', async () => {
    const out = await convertImage(await transparentPng(2400, 1200), 'image/png', 'small');
    expect(out).toMatchObject({ mime: 'image/webp', ext: 'webp' });
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(meta.hasAlpha).toBe(true);
    const { data } = await sharp(out!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // 첫 픽셀은 여전히 투명
  });

  it('compat: JPEG, transparent pixels flattened to white, long side capped at 1600', async () => {
    const out = await convertImage(await transparentPng(1200, 2400), 'image/png', 'compat');
    expect(out).toMatchObject({ mime: 'image/jpeg', ext: 'jpg' });
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(meta.hasAlpha).toBe(false);
    const { data } = await sharp(out!.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((v) => v >= 250)).toBe(true); // 흰색
  });

  it('does not enlarge small images', async () => {
    for (const mode of ['small', 'compat'] as const) {
      const out = await convertImage(await transparentPng(100, 50), 'image/png', mode);
      const meta = await sharp(out!.bytes).metadata();
      expect([meta.width, meta.height]).toEqual([100, 50]);
    }
  });

  it('converts a GIF (first frame) and a JPEG input', async () => {
    const gif = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).gif().toBuffer();
    expect((await convertImage(gif, 'image/gif', 'small'))!.mime).toBe('image/webp');
    const jpg = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();
    expect((await convertImage(jpg, 'image/jpeg', 'compat'))!.mime).toBe('image/jpeg');
  });

  it('original: bytes untouched with the extension from the mime table', async () => {
    const png = await transparentPng(30, 30);
    const out = await convertImage(png, 'image/png', 'original');
    expect(out).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(Buffer.from(out!.bytes).equals(png)).toBe(true);
    expect((await convertImage(new Uint8Array([1, 2]), 'image/jpeg', 'original'))!.ext).toBe('jpg');
  });

  it('returns null for formats outside png/jpeg/gif/webp (SVG), in every mode', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const mode of IMAGE_MODES) expect(await convertImage(svg, 'image/svg+xml', mode)).toBeNull();
  });

  it('throws on corrupt bytes when it has to decode', async () => {
    await expect(convertImage(new Uint8Array([1, 2, 3, 4, 5]), 'image/png', 'small')).rejects.toThrow();
    await expect(convertImage(new Uint8Array([1, 2, 3, 4, 5]), 'image/png', 'compat')).rejects.toThrow();
  });

  it('refuses images over the 40M-pixel input limit and converts ones under it', async () => {
    const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#000' } }).png().toBuffer();
    await expect(convertImage(await solid(8000, 6000), 'image/png', 'small')).rejects.toThrow(); // 48M 픽셀
    const out = await convertImage(await solid(6000, 6000), 'image/png', 'small'); // 36M 픽셀
    expect(out!.mime).toBe('image/webp');
  });
});
