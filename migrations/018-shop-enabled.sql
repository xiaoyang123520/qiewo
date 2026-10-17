-- 为商品表加启用/禁用字段
ALTER TABLE shop_items ADD COLUMN enabled INTEGER DEFAULT 1;
