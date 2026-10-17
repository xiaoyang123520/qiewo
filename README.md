# 🐧 企鹅窝论坛

跑在 Cloudflare Workers + D1 上的轻量论坛。零依赖后端（纯 Workers 标准 API），前端纯原生 JS 单页。

在线演示：https://linux.lblb.eu

## 功能

**基础**
- 版块 / 主题 / 回帖，分页、搜索（中英文）、排序
- 注册登录（PBKDF2-SHA256 10万次）、邮箱验证、忘记密码
- Turnstile 人机验证、敏感词过滤、举报、禁言
- 通知、@、私信、点赞、收藏、引用（带楼层跳转）
- 暗色模式、History API 干净路径、sitemap

**社区玩法**
- 📅 签到积分（北京时间）、发帖/回帖/被赞/被采纳积分
- 🏆 排行榜（积分/发帖/回帖/活跃 × 总榜/月榜/周榜）
- 🛒 积分商城：置顶卡、改名卡、头像框、自定义头衔、卡密商品（后台可上架）
- Linux 段位测试、中文命令解释器、配置 Diff、发行版推荐、Shell 体检

**管理后台**
- 数据看板、用户管理、版块管理、举报处理
- 广告位管理、友情链接管理、积分手动调整

## 快速开始

### 1. 本地开发

```bash
node build.js
npx wrangler d1 execute forum-db --local --file schema.sql
npx wrangler d1 execute forum-db --local --file migrations/001-xxx.sql  # 按顺序执行 migrations/
npx wrangler dev
```

### 2. 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler d1 create forum-db
# 把 database_id 填进 wrangler.toml

# 建表 + 跑迁移
npx wrangler d1 execute forum-db --remote --file schema.sql
for f in migrations/*.sql; do npx wrangler d1 execute forum-db --remote --file "$f"; done

# 配置密钥
npx wrangler secret put RESEND_API_KEY      # Resend API Key（发邮件用）
npx wrangler secret put TURNSTILE_SECRET    # Turnstile Secret Key

# 部署
npx wrangler deploy
```

### 3. 环境变量

在 `wrangler.toml` 或 Cloudflare 面板设置：

| 变量 | 说明 |
|------|------|
| `TURNSTILE_SITE_KEY` | Turnstile Site Key（公开） |
| `TURNSTILE_SECRET` | Turnstile Secret（密钥） |
| `RESEND_API_KEY` | Resend API Key（密钥，邮件验证用） |
| `FROM_EMAIL` | 发件地址，如 `noreply@yourdomain.com` |

## 项目结构

```
src/
  worker.js     后端 API（路由、鉴权、D1 操作）
  app.html      前端单页应用
  cmd-db.js     命令解释器数据库
  quiz-db.js    段位测试题库
migrations/     D1 迁移脚本（按文件名顺序执行）
schema.sql      初始建表
build.js        构建脚本（内联前端 → dist/index.js）
wrangler.toml   Workers 配置
```

## License

MIT
