import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { readKv } from './kv.js';

// 에셋 이름 → 바이트 해석. 읽기 전용 (서버의 assetManifestStore 와 달리 kv 에 쓰지 않는다).
// 규칙 (findings §3.1, 소스 assetManifestStore.cjs + 실제 데이터로 검증):
//  - 정본 = asset_manifest_live(owner_kind, owner_id) → asset_manifests.payload (deflateRaw JSON 튜플 [name, path, t2?], sha256(raw)==content_hash)
//  - 캐릭터 에셋 = 매니페스트 ∪ database.bin 인라인 additionalAssets (인라인에만 있는 것이 실제로 존재함), 그다음 모듈 매니페스트
//  - 이름 조회 = toLocaleLowerCase 완전일치. 서버의 퍼지 폴백(편집거리 ≤ 4)은 구현하지 않는다 (p32 에서 불필요했음).
type Tuple = [string, string, ...unknown[]];

const isTuple = (t: unknown): t is Tuple => Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' && typeof t[1] === 'string';
const isNoSuchTable = (e: unknown) => /no such table/i.test(String((e as Error | null)?.message ?? ''));

export type CharacterLike = { chaId?: unknown; additionalAssets?: unknown; modules?: unknown };

export function createAssetResolver(db: DatabaseSync) {
  const cache = new Map<string, Tuple[] | null>();
  let manifestsAvailable = true;

  function manifestItems(kind: 'character' | 'module', ownerId: string): Tuple[] | null {
    const k = `${kind}/${ownerId}`;
    if (cache.has(k)) return cache.get(k) ?? null;
    let items: Tuple[] | null = null;
    if (manifestsAvailable) {
      try {
        const row = db
          .prepare(
            `SELECT m.payload AS p, m.content_hash AS h FROM asset_manifest_live l
             JOIN asset_manifests m ON m.manifest_id = l.manifest_id
             WHERE l.owner_kind = ? AND l.owner_id = ?`,
          )
          .get(kind, ownerId) as { p: Uint8Array; h: string } | undefined;
        if (row) {
          const raw = inflateRawSync(Buffer.from(row.p));
          if (createHash('sha256').update(raw).digest('hex') !== row.h) throw new Error('manifest hash mismatch');
          items = (JSON.parse(raw.toString('utf8')) as unknown[]).filter(isTuple);
        }
      } catch (e) {
        if (isNoSuchTable(e)) manifestsAvailable = false;
        else throw e;
      }
    }
    cache.set(k, items);
    return items;
  }

  function tuplesFor(c: CharacterLike): Tuple[][] {
    const inline = Array.isArray(c.additionalAssets) ? c.additionalAssets.filter(isTuple) : [];
    const own = [...(manifestItems('character', String(c.chaId)) ?? []), ...inline];
    const mods = (Array.isArray(c.modules) ? c.modules : [])
      .map((id) => manifestItems('module', String(id)))
      .filter((x): x is Tuple[] => x !== null);
    return [own, ...mods];
  }

  const names = (c: CharacterLike): string[] => tuplesFor(c).flat().map((t) => t[0]);

  function resolvePath(c: CharacterLike, name: string): string | null {
    const want = name.toLocaleLowerCase();
    for (const items of tuplesFor(c)) {
      for (const t of items) if (t[0].toLocaleLowerCase() === want) return t[1];
    }
    return null;
  }

  function resolveAsset(c: CharacterLike, name: string): Uint8Array | null {
    const p = resolvePath(c, name);
    return p ? readKv(db, p, { verify: false }) : null;
  }

  return { names, resolvePath, resolveAsset };
}

export function assetMime(buf: Uint8Array): string {
  const b = Buffer.from(buf.subarray(0, 12));
  const head = b.subarray(0, 4);
  if (head.toString('hex') === '89504e47') return 'image/png';
  if (head.toString('hex').startsWith('ffd8ff')) return 'image/jpeg';
  if (head.toString('latin1') === 'GIF8') return 'image/gif';
  if (head.toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
