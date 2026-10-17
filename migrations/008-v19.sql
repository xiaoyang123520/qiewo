-- v1.9: 举报/精华/敏感词
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

ALTER TABLE threads ADD COLUMN is_digest INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sensitive_words (
  word TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
