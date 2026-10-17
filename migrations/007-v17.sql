-- v1.7: 站点设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_name', '论坛');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_logo', '💬');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_desc', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('announcement', '');
