import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vendor } from '../src/source/pocketrisu/vendor.js';
import { ChunkIntegrityError, fingerprintKv, peekKv, readKv } from '../src/source/pocketrisu/kv.js';
import { openSourceDb } from '../src/sqlite.js';
import { baseSpec, chat, writeSource } from './helpers/synthetic-source.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'page-kv-'));

describe('kv chunk reader', () => {
  it('reassembles a chunked value byte-exactly', () => {
    const dir = tmp();
    const spec = baseSpec();
    const file = writeSource(dir, spec);
    const db = openSourceDb(file);
    const expected = vendor.encodeRisuSaveLegacy({ formatversion: 5, characters: spec.characters, botPresets: [] });
    expect(Buffer.from(expected).equals(readKv(db, 'database/database.bin')!)).toBe(true);
    expect(readKv(db, 'nope')).toBeNull();
    db.close();
  });

  it('detects a corrupted chunk', () => {
    const db = openSourceDb(writeSource(tmp(), baseSpec(), { corruptChunk: true }));
    expect(() => readKv(db, 'database/database.bin')).toThrow(ChunkIntegrityError);
    db.close();
  });

  it('peeks the first bytes without reading every chunk', () => {
    const db = openSourceDb(writeSource(tmp(), baseSpec()));
    const head = peekKv(db, 'database/database.bin', 11)!;
    expect(vendor.checkHeader(head)).toBe('raw');
    db.close();
  });

  it('fingerprint changes when content changes and is stable otherwise', () => {
    const dir = tmp();
    const spec = baseSpec();
    const fp = () => { const db = openSourceDb(writeSource(dir, spec)); const v = fingerprintKv(db, 'database/database.bin'); db.close(); return v; };
    const a = fp();
    expect(fp()).toBe(a);
    spec.characters[0]!.chats.push(chat('a3', ['new']));
    expect(fp()).not.toBe(a);
  });
});
