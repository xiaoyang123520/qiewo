-- 签到积分系统
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 5,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id, checkin_date DESC);

-- 用户积分字段
ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN checkin_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_checkin_date TEXT;

-- 工具访问统计
CREATE TABLE IF NOT EXISTS tool_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  user_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_visits ON tool_visits(tool, created_at);
