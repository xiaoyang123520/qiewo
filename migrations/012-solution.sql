ALTER TABLE posts ADD COLUMN is_solution INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_posts_solution ON posts(thread_id, is_solution);
