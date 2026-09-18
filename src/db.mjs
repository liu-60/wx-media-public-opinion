import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'RUNNING',
  raw_account_count INTEGER NOT NULL DEFAULT 0,
  unique_account_count INTEGER NOT NULL DEFAULT 0,
  duplicate_account_count INTEGER NOT NULL DEFAULT 0,
  invalid_account_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  wx_biz TEXT,
  wx_name TEXT NOT NULL DEFAULT '',
  verify TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  read_median REAL,
  read_max REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sync_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_wx_biz_unique
  ON accounts(wx_biz) WHERE wx_biz IS NOT NULL AND wx_biz <> '';
CREATE INDEX IF NOT EXISTS accounts_updated_at_idx ON accounts(updated_at, account_id);

CREATE TABLE IF NOT EXISTS account_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  wx_user TEXT,
  avatar TEXT,
  wx_type TEXT,
  region TEXT,
  tags_json TEXT,
  last_pub_time TEXT,
  stat_date TEXT,
  pub_count INTEGER,
  active_days INTEGER,
  read_avg REAL,
  read_median REAL,
  read_max REAL,
  burst_count INTEGER,
  burst_rate REAL,
  ori_count INTEGER,
  ori_rate REAL,
  look_avg REAL,
  look_median REAL,
  look_max REAL,
  like_avg REAL,
  like_median REAL,
  like_max REAL,
  share_avg REAL,
  share_median REAL,
  share_max REAL,
  comment_avg REAL,
  comment_median REAL,
  comment_max REAL,
  wci_index REAL,
  collected_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  article_id TEXT PRIMARY KEY,
  article_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  publish_time TEXT NOT NULL DEFAULT '',
  wx_biz TEXT,
  account_id TEXT REFERENCES accounts(account_id),
  publisher TEXT NOT NULL DEFAULT '',
  read_num INTEGER NOT NULL DEFAULT 0,
  like_num INTEGER NOT NULL DEFAULT 0,
  look_num INTEGER NOT NULL DEFAULT 0,
  share_num INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'RAW',
  filter_rule_id TEXT NOT NULL DEFAULT '',
  filter_reason TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS articles_status_idx ON articles(status, updated_at);
CREATE INDEX IF NOT EXISTS articles_wx_biz_idx ON articles(wx_biz, publish_time);

CREATE TABLE IF NOT EXISTS article_filter_audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  account_id TEXT,
  rule_id TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL DEFAULT '',
  matched_value TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS article_filter_audit_article_idx ON article_filter_audit(article_id, created_at);

CREATE TABLE IF NOT EXISTS hotwords (
  word TEXT NOT NULL,
  token_type TEXT NOT NULL,
  gram INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER NOT NULL DEFAULT 0,
  read_sum INTEGER NOT NULL DEFAULT 0,
  weighted_count REAL NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  examples_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(word, stat_date)
);
CREATE INDEX IF NOT EXISTS hotwords_score_idx ON hotwords(stat_date, score DESC);
`

function ensureParent(filePath) {
  if (filePath === ':memory:') return
  mkdirSync(dirname(resolve(filePath)), { recursive: true })
}

export function ensureSchema(db) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('db must be a node:sqlite DatabaseSync')
  db.exec(SCHEMA)
  return db
}

export function openDatabase(filePath = ':memory:') {
  ensureParent(filePath)
  return ensureSchema(new DatabaseSync(filePath))
}

export function nowIso() {
  return new Date().toISOString()
}

export { SCHEMA }
