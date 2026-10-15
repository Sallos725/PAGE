import { describe, expect, it } from 'vitest';
import { vendor } from '../src/source/pocketrisu/vendor.js';

describe('vendored PocketRisu decoder', () => {
  it('round-trips a legacy (raw header) blob', async () => {
    const blob = vendor.encodeRisuSaveLegacy({ formatversion: 5, characters: [{ chaId: 'x', chats: [] }] });
    expect(vendor.checkHeader(blob)).toBe('raw');
    expect(vendor.hasRemoteBlocks(blob)).toBe(false);
    const dec = (await vendor.decodeRisuSave(blob)) as { formatversion: number; characters: { chaId: string }[] };
    expect(dec.formatversion).toBe(5);
    expect(dec.characters[0]?.chaId).toBe('x');
  });
});
