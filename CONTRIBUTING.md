# 贡献指南

感谢你对企鹅窝论坛的兴趣！

## 如何贡献

1. Fork 本仓库
2. 创建你的分支：`git checkout -b feature/你的功能名`
3. 提交修改：`git commit -m "描述你的修改"`
4. 推送到分支：`git push origin feature/你的功能名`
5. 提交 Pull Request

## 开发规范

- **改 JS 后必查**：每次改 `src/app.html` 里的 JavaScript 后，必须跑 `node --check` 验证语法，并检查没有重复定义的函数
- **构建验证**：跑 `node build.js` 确认能正常生成 `dist/index.js`
- **数据库变更**：所有表结构变更必须写成迁移文件放在 `migrations/`，按序号命名（如 `022-xxx.sql`），不要直接改 `schema.sql`
- **请求体只解析一次**：Worker 入口已经 `readBody` 解析过 body，handler 里不要再 `await req.json()`，直接用外层 `body`

## 本地开发

```bash
node build.js
npx wrangler d1 execute forum-db --local --file migrations/001-init.sql
# 按顺序执行 migrations/ 下的其他文件
npx wrangler dev
```

## 报告 Bug

请用 Issue 模板提交，附上复现步骤和截图。
