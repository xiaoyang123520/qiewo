#!/usr/bin/env python3
"""apichat: 静态聊天页 + 受限转发代理（仅标准库，无第三方依赖）

- GET /            -> 聊天页
- GET /channels    -> 预置渠道模板（不含 key）
- POST /proxy      -> 转发到白名单内的上游 API（解决浏览器 CORS 问题），支持流式
"""
import json
import os
import urllib.parse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
        return json.load(f)


CONFIG = load_config()
PORT = int(os.environ.get("PORT", CONFIG.get("port", 18790)))
WHITELIST = set(CONFIG.get("proxy_whitelist", []))
CHANNELS = CONFIG.get("channels", [])
WWW = os.path.join(BASE, "www")


class Handler(BaseHTTPRequestHandler):
    server_version = "apichat/1.0"

    def log_message(self, fmt, *args):  # 安静一点，只打关键日志
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/channels":
            self._json({"channels": CHANNELS})
            return
        if parsed.path == "/health":
            self._json({"status": "ok"})
            return
        rel = parsed.path.lstrip("/") or "index.html"
        fpath = os.path.normpath(os.path.join(WWW, rel))
        if not fpath.startswith(WWW) or not os.path.isfile(fpath):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        ctype = "text/html; charset=utf-8" if fpath.endswith(".html") \
            else "text/css" if fpath.endswith(".css") \
            else "application/javascript" if fpath.endswith(".js") \
            else "application/octet-stream"
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length > 10 * 1024 * 1024:
            self.send_response(413)
            self._cors()
            self.end_headers()
            return
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_response(400)
            self._cors()
            self.end_headers()
            return

        url = req.get("url", "")
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or u.hostname not in WHITELIST:
            self.send_response(403)
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(b"host not allowed")
            except Exception:
                pass
            return

        method = str(req.get("method", "POST")).upper()
        if method not in ("GET", "POST"):
            method = "POST"
        headers = {}
        for k, v in (req.get("headers") or {}).items():
            if k.lower() in ("content-type", "authorization"):
                headers[k] = v
        body = req.get("body")
        if isinstance(body, dict):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")

        try:
            if u.scheme == "https":
                conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=180)
            else:
                conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=180)
            target = u.path or "/"
            if u.query:
                target += "?" + u.query
            conn.request(method, target, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.getheader("Content-Type", "application/json"))
            self._cors()
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
            conn.close()
        except Exception:
            try:
                self.send_response(502)
                self._cors()
                self.end_headers()
            except Exception:
                pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"apichat listening on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
