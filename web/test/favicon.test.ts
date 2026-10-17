// 파비콘: 탭·북마크용 SVG + 32px ICO, 아이폰 홈 화면용 180px PNG, 안드로이드 홈 화면(manifest)용 192·512px PNG.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..');
const pub = (f: string) => fs.readFileSync(path.join(ROOT, 'public', f));

describe('favicon', () => {
  it('index.html links the icons', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('the manifest makes the app installable (홈 화면에 추가) with opaque 192/512 icons', () => {
    const m = JSON.parse(pub('manifest.webmanifest').toString('utf8')) as {
      name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string }[];
    };
    expect(m).toMatchObject({ name: 'PAGE', start_url: '/', display: 'standalone' });
    expect(m.icons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    for (const i of m.icons) {
      const png = pub(i.src.replace(/^\//, ''));
      const n = Number(i.sizes.split('x')[0]);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([n, n]);
      expect(png[25]).toBe(2); // 불투명: maskable 아이콘이 투명 모서리 없이 꽉 차게
    }
  });

  it('the SVG is static artwork only (no script, links or external refs)', () => {
    const svg = pub('favicon.svg').toString('utf8');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">')).toBe(true);
    expect(svg).not.toMatch(/<script|href=|url\(|\son[a-z]+=/i);
  });

  it('the touch icon is an opaque 180×180 PNG; the ICO wraps a 32×32 PNG', () => {
    const t = pub('apple-touch-icon.png');
    expect(t.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([t.readUInt32BE(16), t.readUInt32BE(20)]).toEqual([180, 180]);
    expect(t[25]).toBe(2); // RGB(알파 없음) — iOS 가 투명 부분을 검게 채우지 않게
    const ico = pub('favicon.ico');
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1]);
    expect([ico[6], ico[7]]).toEqual([32, 32]);
    expect(ico.subarray(23, 26).toString('latin1')).toBe('PNG'); // 본문은 오프셋 22 에서 시작
  });
});
