# 💬 APIChat

![License](https://img.shields.io/badge/license-MIT-green)
![Python](https://img.shields.io/badge/python-3.8%2B-blue)
![No Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

通用 OpenAI 兼容 API 网页聊天室。纯 Python 标准库后端 + 单文件前端，零第三方依赖。

在线演示：https://api1.lblb.eu/chat/

## ✨ 功能

- 🔌 **多渠道管理**：添加多个 API 渠道（OpenAI 兼容接口），一键切换
- 💬 **多对话管理**：每个渠道独立对话历史，互不串味
- 📡 **群发模式**：同时向多个渠道/模型发送，回复并行返回
- 🌊 **流式输出**：SSE 流式打字机效果
- 🔒 **CORS 代理**：后端按白名单转发，解决浏览器跨域问题
- 💾 **本地存储**：渠道配置和对话历史存浏览器 localStorage，服务端不存密钥

## 🚀 快速开始

### 1. 配置

```bash
cp config.example.json config.json
# 编辑 config.json，把你的上游 API 域名加进 proxy_whitelist
```

### 2. 运行

```bash
python3 server.py
```

访问 http://localhost:18790。

### 3. 添加渠道

在页面右上角点"渠道管理"，填写：
- 名称：如 `deepseek`
- Base URL：如 `https://api.deepseek.com/v1`
- API Key：你的 key（只存浏览器本地，不上传）

## 🔧 配置说明

`config.json`：

| 字段 | 说明 |
|------|------|
| `port` | 监听端口，默认 18790（可用 `PORT` 环境变量覆盖） |
| `proxy_whitelist` | 允许转发的上游域名白名单 |
| `channels` | 预置渠道模板（不含 key） |

## 🌐 反代部署（Nginx）

```nginx
location /chat/ {
    proxy_pass http://127.0.0.1:18790/;
    proxy_buffering off;
    proxy_read_timeout 600s;
}
location = /chat {
    return 301 /chat/;
}
```

注意：SSE 流式需要关 `proxy_buffering`。

## 📁 项目结构

```
server.py              后端（Python 标准库，无第三方依赖）
www/index.html         前端（单文件，872 行原生 JS）
config.example.json    配置模板
apichat.service.example  systemd 服务模板
```

## 🔌 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 聊天页面 |
| GET | `/health` | 健康检查 |
| GET | `/channels` | 预置渠道模板 |
| POST | `/proxy` | 转发到白名单上游（解决 CORS） |

## 📄 License

MIT
