-- 积分商城
CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  descr TEXT NOT NULL,
  price INTEGER NOT NULL,
  icon TEXT NOT NULL,
  item_type TEXT NOT NULL,
  sort INTEGER DEFAULT 99,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  used_at INTEGER,
  extra TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_items_user ON user_items(user_id);
-- 用户扩展字段：自定义头衔、头像框
-- (D1 不支持 ADD COLUMN IF NOT EXISTS，用代码里 try/catch 处理)
