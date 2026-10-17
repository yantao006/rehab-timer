-- Additive schema: keep original records and apply revocations separately.
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT OR IGNORE INTO app_state (id, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS sessions (
  program TEXT NOT NULL CHECK (program IN ('five-stage-v1', 'lower-limb-joints-v1')),
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  writer_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (program, id)
);

CREATE TABLE IF NOT EXISTS records (
  program TEXT NOT NULL CHECK (program IN ('five-stage-v1', 'lower-limb-joints-v1')),
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('training', 'manual', 'legacy')),
  time_zone TEXT,
  created_at TEXT NOT NULL,
  import_id TEXT,
  PRIMARY KEY (program, id),
  CHECK (source = 'manual' OR finished_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS records_date ON records (program, date);

CREATE TABLE IF NOT EXISTS calendar_adjustments (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'revoke')),
  program TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program, record_id) REFERENCES records (program, id)
);
CREATE INDEX IF NOT EXISTS adjustments_target ON calendar_adjustments (program, record_id, kind);

CREATE TABLE IF NOT EXISTS operation_log (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL CHECK (json_valid(response)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_imports (
  operation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  raw_payload TEXT NOT NULL CHECK (json_valid(raw_payload)),
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  legacy_key TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL
);

-- A failed compare-and-swap must abort the whole D1 batch, not silently affect zero rows.
CREATE TABLE IF NOT EXISTS write_guards (
  operation_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

CREATE TABLE IF NOT EXISTS login_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at INTEGER NOT NULL
);
