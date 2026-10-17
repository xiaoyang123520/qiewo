-- v1.6: 收藏
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id, created_at DESC);
