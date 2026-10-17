# 🐧 企鹅窝论坛

![License](https://img.shields.io/badge/license-MIT-green)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![D1](https://img.shields.io/badge/Database-D1-blue)
![No Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

跑在 Cloudflare Workers + D1 上的轻量论坛。零依赖后端（纯 Workers 标准 API），前端纯原生 JS 单页应用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaoyang123520/qiewo)

在线演示：https://linux.lblb.eu

## 📑 目录

- [📸 截图](#-截图)
- [✨ 功能](#-功能)
- [🚀 一键部署](#-一键部署)
- [🛠️ 手动部署](#️-手动部署)
- [💻 本地开发](#-本地开发)
- [📁 项目结构](#-项目结构)
- [🏗️ 架构](#️-架构)
- [🔌 API 概览](#-api-概览)
- [💰 成本](#-成本)
- [🤝 贡献](#-贡献)
- [📄 License](#-license)

## ✨ 功能

**基础功能**
- 📝 版块 / 主题 / 回帖，分页、搜索（中英文）、多种排序
- 👤 注册登录（PBKDF2-SHA256 10 万次哈希）、邮箱验证、忘记密码
- 🛡️ Turnstile 人机验证、敏感词过滤、举报、禁言
- 🔔 通知、@ 提及、私信、点赞、收藏、引用（带楼层跳转）
- 🌙 暗色模式、History API 干净路径、sitemap.xml

**社区玩法**
- 📅 每日签到积分（北京时间，连续签到有加成）
- 🏆 排行榜（积分 / 发帖 / 回帖 / 活跃 × 总榜 / 月榜 / 周榜）
- 🛒 积分商城：置顶卡、改名卡、头像框、自定义头衔、卡密商品（后台可自助上架）
- 🎮 Linux 段位测试、中文命令解释器、配置 Diff、发行版推荐、Shell 体检

**管理后台**
- 📊 数据看板、用户管理、版块管理、举报处理
- 📢 广告位管理、友情链接管理、积分手动调整

## 🚀 一键部署

点击上方的 **Deploy to Cloudflare** 按钮，Cloudflare 会自动：

1. Fork 本仓库到你的 GitHub 账号
2. 创建 D1 数据库并执行所有迁移
3. 部署 Worker 到你的 `workers.dev` 域名

部署完成后，还需要在 Cloudflare 面板设置两个密钥：

| 密钥 | 说明 | 必填 |
|------|------|------|
| `RESEND_API_KEY` | Resend API Key，用于发送验证邮件 | 建议 |
| `TURNSTILE_SECRET` | Turnstile Secret Key，用于人机验证 | 建议 |

设置路径：Workers → cf-forum → 设置 → 变量和机密。

> 不设置也能跑，但注册时的邮箱验证和 Turnstile 验证会被跳过。

## 🛠️ 手动部署

### 1. 准备

```bash
git clone https://github.com/xiaoyang123520/qiewo.git
cd qiewo
```

### 2. 创建 D1 数据库

```bash
npx wrangler login
npx wrangler d1 create forum-db
# 把输出的 database_id 填进 wrangler.toml
```

### 3. 初始化数据库

```bash
npx wrangler d1 execute forum-db --remote --file migrations/001-init.sql
for f in migrations/00*.sql migrations/01*.sql migrations/02*.sql; do
  npx wrangler d1 execute forum-db --remote --file "$f"
done
```

### 4. 配置变量和密钥

在 `wrangler.toml` 的 `[vars]` 里填：
- `TURNSTILE_SITE_KEY`：Cloudflare Turnstile 的 Site Key
- `FROM_EMAIL`：发件地址，如 `noreply@yourdomain.com`

设置密钥：
```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET
```

### 5. 构建并部署

```bash
node build.js
npx wrangler deploy
```

### 6. 绑定自定义域名（可选）

Cloudflare 面板 → Workers → cf-forum → 设置 → 域和路由 → 添加自定义域。

## 💻 本地开发

```bash
node build.js
npx wrangler d1 execute forum-db --local --file migrations/001-init.sql
# 按顺序执行 migrations/ 下的其他文件
npx wrangler dev
```

访问 http://localhost:8787。第一个注册的用户自动成为管理员。

## 📁 项目结构

```
src/
  worker.js     后端 API（路由、鉴权、D1 操作，约 1800 行）
  app.html      前端单页应用（约 2000 行原生 JS）
  cmd-db.js     中文命令解释器数据库
  quiz-db.js    Linux 段位测试题库
migrations/     D1 迁移脚本（按文件名顺序执行）
schema.sql      初始建表语句（同 migrations/001-init.sql）
build.js        构建脚本（内联前端 → dist/index.js）
wrangler.toml   Workers 配置
```

## 💰 成本

Cloudflare 免费额度内完全够用：
- Workers：每天 10 万次请求
- D1：每天 500 万行读取、10 万行写入、5GB 存储

日活几千的论坛都跑得动，不花一分钱。

## 🏗️ 架构

```
浏览器 (原生 JS SPA)
    ↓ HTTPS
Cloudflare Workers (worker.js)
    ↓ D1 Binding
Cloudflare D1 (SQLite)
```

- **零依赖**：后端只用 Workers 标准 API（`crypto.subtle` 做 PBKDF2、`fetch` 调 Resend/Turnstile），前端零框架
- **单文件部署**：`node build.js` 把前端内联进 Worker，打包成一个 `dist/index.js`
- **构建时注入**：命令数据库和题库在构建时注入到 HTML 的 `<script>` 开头，避免运行时请求

## 🔌 API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录 |
| GET | `/api/boards` | 版块列表 |
| GET | `/api/boards/:id/threads` | 主题列表 |
| POST | `/api/threads` | 发主题 |
| GET | `/api/threads/:id` | 主题详情+回帖 |
| POST | `/api/threads/:id/posts` | 回帖 |
| POST | `/api/checkin` | 签到 |
| GET | `/api/rankings` | 排行榜 |
| GET | `/api/shop/items` | 商城商品 |
| POST | `/api/shop/buy/:id` | 购买商品 |

完整接口见 `src/worker.js`。

## 🤝 贡献

欢迎提 Issue 和 PR！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 License

MIT
