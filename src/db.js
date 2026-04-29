const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.reposDir, { recursive: true });
fs.mkdirSync(config.epgCacheDir, { recursive: true });
fs.mkdirSync(config.listsCacheDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -32000');
db.pragma('mmap_size = 268435456');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('git','url')),
  location TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_path TEXT,
  tvg_id TEXT,
  tvg_name TEXT,
  tvg_logo TEXT,
  group_title TEXT,
  display_name TEXT,
  url TEXT NOT NULL,
  raw_attrs TEXT,
  extra_lines TEXT,
  duration TEXT DEFAULT '-1',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id);
CREATE INDEX IF NOT EXISTS idx_channels_tvg_name ON channels(tvg_name);
CREATE INDEX IF NOT EXISTS idx_channels_group_title ON channels(group_title);
CREATE INDEX IF NOT EXISTS idx_channels_tvg_logo ON channels(tvg_logo) WHERE tvg_logo IS NOT NULL AND tvg_logo != '';

CREATE TABLE IF NOT EXISTS epgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_status TEXT,
  last_error TEXT,
  cached_file TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS epg_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epg_id INTEGER NOT NULL REFERENCES epgs(id) ON DELETE CASCADE,
  tvg_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epg_channels_epg ON epg_channels(epg_id);
CREATE INDEX IF NOT EXISTS idx_epg_channels_norm ON epg_channels(epg_id, normalized);
CREATE INDEX IF NOT EXISTS idx_epg_channels_tvg ON epg_channels(epg_id, tvg_id);

CREATE TABLE IF NOT EXISTS epg_priorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epg_id INTEGER NOT NULL REFERENCES epgs(id) ON DELETE CASCADE,
  tvg_id TEXT NOT NULL,
  display_name TEXT,
  combinator TEXT NOT NULL DEFAULT 'AND' CHECK (combinator IN ('AND','OR')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_epg_priorities_epg ON epg_priorities(epg_id, position);

CREATE TABLE IF NOT EXISTS epg_priority_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority_id INTEGER NOT NULL REFERENCES epg_priorities(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('tvg_id','tvg_name','tvg_logo','group_title','display_name','url')),
  operator TEXT NOT NULL CHECK (operator IN ('contains','equals','regex','starts_with')),
  value TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_epg_priority_rules_pri ON epg_priority_rules(priority_id, position);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  norm_case TEXT NOT NULL DEFAULT 'none',
  norm_strip_specials INTEGER NOT NULL DEFAULT 0,
  epg_id INTEGER REFERENCES epgs(id) ON DELETE SET NULL,
  basic_auth_user TEXT,
  basic_auth_password TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lists_epg ON lists(epg_id);

CREATE TABLE IF NOT EXISTS list_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('include','exclude')),
  combinator TEXT NOT NULL DEFAULT 'OR' CHECK (combinator IN ('AND','OR')),
  position INTEGER NOT NULL DEFAULT 0,
  group_name TEXT,
  append_quality INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_groups_list ON list_groups(list_id, position);

CREATE TABLE IF NOT EXISTS list_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES list_groups(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('tvg_id','tvg_name','tvg_logo','group_title','display_name','url')),
  operator TEXT NOT NULL CHECK (operator IN ('contains','equals','regex','starts_with')),
  value TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_rules_list ON list_rules(list_id);
CREATE INDEX IF NOT EXISTS idx_list_rules_group ON list_rules(group_id, position);

CREATE TABLE IF NOT EXISTS list_replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('tvg_id','tvg_name','tvg_logo','group_title','display_name','url')),
  find TEXT NOT NULL,
  replace TEXT NOT NULL DEFAULT '',
  is_regex INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_replacements_list ON list_replacements(list_id, position);

CREATE TABLE IF NOT EXISTS list_sources (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, source_id)
);

CREATE TABLE IF NOT EXISTS image_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  source_url TEXT,
  target_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_image_overrides_source ON image_overrides(source_url) WHERE source_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS image_override_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL REFERENCES image_overrides(id) ON DELETE CASCADE,
  field TEXT NOT NULL DEFAULT 'display_name' CHECK (field IN ('tvg_id','tvg_name','tvg_logo','group_title','display_name','url')),
  operator TEXT NOT NULL CHECK (operator IN ('contains','equals','regex','starts_with')),
  value TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_image_override_rules_image ON image_override_rules(image_id, position);

CREATE TABLE IF NOT EXISTS broken_images (
  url TEXT PRIMARY KEY,
  broken INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_broken_images_broken ON broken_images(broken) WHERE broken = 1;

CREATE TABLE IF NOT EXISTS broken_urls (
  url TEXT PRIMARY KEY,
  broken INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_broken_urls_broken ON broken_urls(broken) WHERE broken = 1;

CREATE TABLE IF NOT EXISTS compiled_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tvg_id TEXT,
  tvg_name TEXT,
  tvg_logo TEXT,
  group_title TEXT,
  display_name TEXT,
  url TEXT NOT NULL,
  extra_lines TEXT,
  duration TEXT DEFAULT '-1'
);
CREATE INDEX IF NOT EXISTS idx_compiled_list ON compiled_channels(list_id, position);
`);

function close() {
  try { db.close(); } catch (_) { /* noop */ }
}

module.exports = db;
module.exports.close = close;
