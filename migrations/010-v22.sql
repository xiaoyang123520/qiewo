-- v2.2: 私信
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_receiver ON dm_messages(receiver_id, is_read, created_at DESC);
