import type { SqliteDatabase } from "./sqlite.ts";

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  basis TEXT NOT NULL DEFAULT 'inferred',
  confidence REAL NOT NULL DEFAULT 0.5,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  canonical_key TEXT NOT NULL UNIQUE,
  current_version INTEGER NOT NULL DEFAULT 1,
  author_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  valid_from TEXT,
  valid_to TEXT,
  material_revision_at TEXT,
  auto_inject_eligible INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS node_versions (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  basis TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  author_json TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, version)
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE(from_id, to_id, type)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  locator TEXT NOT NULL,
  content_hash TEXT,
  observed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(type, locator)
);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_version INTEGER NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  locator_json TEXT NOT NULL DEFAULT '{}',
  excerpt TEXT,
  excerpt_hash TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  action TEXT NOT NULL,
  node_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  sampled_by TEXT NOT NULL,
  risk_score REAL NOT NULL DEFAULT 0,
  auditor_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_version INTEGER NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflict_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_a TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_b TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_a_version INTEGER NOT NULL,
  node_b_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  relation TEXT NOT NULL DEFAULT 'contradicts',
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_a, node_b)
);

CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes(status);
CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_updated_idx ON nodes(updated_at);
CREATE INDEX IF NOT EXISTS edges_from_idx ON edges(from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx ON edges(to_id);
CREATE INDEX IF NOT EXISTS citations_node_idx ON citations(node_id, node_version);
CREATE INDEX IF NOT EXISTS sources_type_idx ON sources(type, locator);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);
CREATE INDEX IF NOT EXISTS injections_session_idx ON injections(session_id);
CREATE INDEX IF NOT EXISTS audits_node_idx ON audits(node_id);
CREATE INDEX IF NOT EXISTS conflict_proposals_status_idx ON conflict_proposals(status);
CREATE INDEX IF NOT EXISTS conflict_proposals_a_idx ON conflict_proposals(node_a);
CREATE INDEX IF NOT EXISTS conflict_proposals_b_idx ON conflict_proposals(node_b);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id UNINDEXED,
  title,
  body,
  tags,
  tokenize = 'porter unicode61'
);
`;

export function initSchema(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run("version", String(SCHEMA_VERSION));
}
