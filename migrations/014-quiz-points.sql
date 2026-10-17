-- 答题积分：记录用户是否已领取过段位测试积分（防刷）
ALTER TABLE users ADD COLUMN quiz_claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quiz_best_score INTEGER NOT NULL DEFAULT 0;
