-- 024: 视频链接兑换 token（方案B：播放器页 + Token 鉴权）
CREATE TABLE IF NOT EXISTS video_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  user_item_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  view_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_tokens_user ON video_tokens(user_id);
