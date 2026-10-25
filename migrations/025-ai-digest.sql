-- AI 每日精选：抓取/去重记录表 + 总开关 + 精选版块
CREATE TABLE IF NOT EXISTS ai_ingest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'seen',
  post_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_ingest_created ON ai_ingest(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_ingest_status ON ai_ingest(status, created_at);
-- 总开关：'1' 开启（默认），'0' 关闭后 Cron 自动跳过
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_digest_enabled', '1');
-- 每日精选版块（已有同名版块则跳过）
INSERT INTO boards (name, descr, sort)
SELECT '📰 每日精选', '精选君每日自动精选：VPS / 服务器 / 建站 / Linux / AI 工具优质帖（附摘要与原文链接）', 5
WHERE NOT EXISTS (SELECT 1 FROM boards WHERE name LIKE '%每日精选%');
