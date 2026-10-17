-- 积分流水表：审计所有积分增减
CREATE TABLE IF NOT EXISTS point_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  related_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs(user_id, created_at DESC);
