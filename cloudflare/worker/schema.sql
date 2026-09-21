-- Control-plane database (Cloudflare D1).
--
-- jobs    one row per requested video, the durable record the frontend reads
-- events  an append-only trail per job, so progress survives a refresh and any
--         failure can be reconstructed after the fact

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  topic          TEXT NOT NULL,
  data_url       TEXT,
  layout         TEXT,
  top_n          INTEGER,
  target_minutes REAL,
  status         TEXT NOT NULL DEFAULT 'queued',
  stage          TEXT,
  github_run_id  TEXT,
  github_run_url TEXT,
  input_path     TEXT,
  video_url      TEXT,
  probe_json     TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_job ON events (job_id, id);

-- Session audit trail. The live session check uses KV; this table exists so the
-- history of who signed in when is queryable.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);