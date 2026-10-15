// 스펙 5.2 + 계획의 추가분(lib_chats 확장 4컬럼, lib_version_assets.status, lib_sync_state).
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lib_chars(
  source TEXT NOT NULL, char_id TEXT NOT NULL, name TEXT NOT NULL, meta_json TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY(source, char_id));

CREATE TABLE IF NOT EXISTS lib_chats(
  source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, deleted_at INTEGER,
  head_version INTEGER, src_fingerprint TEXT,
  last_date INTEGER, pending_fp TEXT, pending_since INTEGER, last_error TEXT,
  PRIMARY KEY(source, char_id, chat_id));

CREATE TABLE IF NOT EXISTS lib_versions(
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL, char_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, msg_count INTEGER NOT NULL, manifest_hash TEXT NOT NULL, meta_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('initial','appended','edited','deleted-marker')));
CREATE INDEX IF NOT EXISTS idx_versions_chat ON lib_versions(source, char_id, chat_id, version_id);

CREATE TABLE IF NOT EXISTS lib_manifests(manifest_hash TEXT PRIMARY KEY, msg_hashes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS lib_msgs(msg_hash TEXT PRIMARY KEY, body BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS lib_assets(asset_hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, first_seen INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS lib_version_assets(
  version_id INTEGER NOT NULL, asset_ref TEXT NOT NULL, asset_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('ok','unresolved','deferred')),
  PRIMARY KEY(version_id, asset_ref));
CREATE INDEX IF NOT EXISTS idx_version_assets_ref ON lib_version_assets(asset_ref);

CREATE TABLE IF NOT EXISTS lib_sync_state(source TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source, key));

CREATE TABLE IF NOT EXISTS lib_char_images(
  source TEXT NOT NULL, char_id TEXT NOT NULL, image_ref TEXT NOT NULL, asset_hash TEXT,
  PRIMARY KEY(source, char_id));

CREATE TABLE IF NOT EXISTS lib_image_rule_slow(
  source TEXT NOT NULL, char_id TEXT NOT NULL, rule_key TEXT NOT NULL,
  PRIMARY KEY(source, char_id, rule_key));
`;
