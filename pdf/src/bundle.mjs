import fs from 'node:fs/promises';
import path from 'node:path';
import { unzip } from 'fflate';

// 묶음 = index.html + images/*. 경로 이탈·절대 경로·예상 밖 파일은 거부한다 (스펙 P4).
// images/ 아래 이름은 '.' 와 '..' 자체가 될 수 없다.
const OK = /^(index\.html|images\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,128})$/;
// 압축 폭탄 방어: 풀었을 때 총 크기·항목 수 상한 (본문 상한과 별개).
const MAX_UNPACKED = Number(process.env.PDF_MAX_UNPACKED_MB ?? 600) * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export class BundleError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// 비동기 unzip 이라 풀기 동안 이벤트 루프(/health)가 막히지 않는다.
// 항목 헤더가 선언한 크기로 먼저 거른다(필터가 false 를 돌려주면 그 항목은 풀지 않는다). 거른 게 있으면 묶음 전체를 거부한다.
export async function unpackBundle(zipBytes, dir, { maxUnpacked = MAX_UNPACKED } = {}) {
  let rejected = false;
  let total = 0;
  let count = 0;
  const files = await new Promise((resolve, reject) => {
    try {
      unzip(zipBytes, {
        filter: (f) => {
          total += f.originalSize;
          if (++count > MAX_ENTRIES || total > maxUnpacked || !OK.test(f.name)) { rejected = true; return false; }
          return true;
        },
      }, (err, out) => (err ? reject(err) : resolve(out)));
    } catch (e) { reject(e); }
  }).catch(() => { throw new BundleError('bad-bundle'); });
  if (rejected) throw new BundleError('bad-bundle');
  const names = Object.keys(files);
  if (!names.includes('index.html')) throw new BundleError('bad-bundle');
  for (const n of names) if (!OK.test(n)) throw new BundleError('bad-bundle');
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });
  for (const n of names) await fs.writeFile(path.join(dir, n), files[n]);
}
