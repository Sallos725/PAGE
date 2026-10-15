import { createRequire } from 'node:module';

// 벤더링한 PocketRisu 디코더(CJS). 직접 재구현하지 않는다 (스펙 5.3).
// 경로는 src/ 와 dist/ 양쪽에서 server/vendor 를 가리킨다 (둘 다 server/ 아래 3단계).
const require = createRequire(import.meta.url);

export type VendorUtils = {
  decodeRisuSave(data: Uint8Array, options?: Record<string, unknown>): Promise<unknown>;
  encodeRisuSaveLegacy(data: unknown, compression?: 'noCompression' | 'compression'): Uint8Array;
  checkHeader(data: Uint8Array): string | false;
  hasRemoteBlocks(data: Uint8Array): boolean;
};

export const vendor = require('../../../vendor/pocketrisu/utils.cjs') as VendorUtils;
