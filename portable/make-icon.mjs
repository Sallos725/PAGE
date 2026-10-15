// portable/make-icon.mjs — web/public/favicon.svg → 다중 크기 ICO (PNG 항목). 사용: node portable/make-icon.mjs <out.ico>
// sharp 는 server 의 의존성을 빌려 쓴다 (서버 npm ci 뒤에 실행).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const out = process.argv[2];
if (!out) { console.error('usage: node portable/make-icon.mjs <out.ico>'); process.exit(2); }
const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
const svg = fs.readFileSync(new URL('../web/public/favicon.svg', import.meta.url));
const sizes = [16, 32, 48, 256];
// favicon.svg 는 32×32 — 크기마다 density 를 맞춰 바로 그 크기로 그린다 (256 이 업스케일로 흐려지지 않게)
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: Math.max(72, Math.ceil((72 * s) / 32)) }).resize(s, s).png().toBuffer()));
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const b = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, b); dir.writeUInt8(s >= 256 ? 0 : s, b + 1);
  dir.writeUInt16LE(1, b + 4); dir.writeUInt16LE(32, b + 6);
  dir.writeUInt32LE(pngs[i].length, b + 8); dir.writeUInt32LE(offset, b + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(out, Buffer.concat([head, dir, ...pngs]));
