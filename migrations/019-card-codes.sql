-- 商品参数（JSON，如置顶时长）+ 卡密表
ALTER TABLE shop_items ADD COLUMN params TEXT DEFAULT '{}';

CREATE TABLE IF NOT EXISTS card_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  used_by INTEGER,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_codes_item ON card_codes(item_id, used_by);
