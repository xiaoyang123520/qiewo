#!/usr/bin/env python3
"""Daily D1 backup for cf-forum (forum-db) via Cloudflare D1 export REST API.

Usage:  python3 backup-d1.py            # writes backups/forum-db-<ts>.sql, keeps newest 7
        BACKUP_DIR=/path python3 backup-d1.py

Auth: uses the registered custom.cloudflare credential via the surrogate
helper (same mechanism as custom-connectors/custom.cloudflare/bin/cf.py).
No key/token is stored in this script or its logs.

Flow (per Cloudflare D1 export API docs):
  POST /client/v4/accounts/{acct}/d1/database/{db}/export
    {"output_format": "polling"} -> {"result": {"at_bookmark": ...}}
  poll POST .../export {"output_format": "polling", "current_bookmark": bm}
    until result.signed_url appears (poll continually or export auto-cancels)
  GET signed_url (unsigned, redirects allowed) -> save .sql
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT_ID = "881722e9262bc2922b4056c3fa31dbc2"
DATABASE_ID = "f31aa47b-d643-4dce-b380-e2e06a9e4ab9"  # forum-db (also in wrangler.toml)
KEEP = int(os.environ.get("BACKUP_KEEP", "7"))
BACKUP_DIR = os.environ.get("BACKUP_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "backups"
)
POLL_INTERVAL = 5
POLL_TIMEOUT = 600


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused on authenticated API call")


def api_call(method, path, data=None):
    url = "https://api.cloudflare.com" + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as resp:
        return read_json_response(resp)


def main():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    export_path = (
        f"/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/export"
    )

    # 1. start export (polling mode)
    r = api_call("POST", export_path, {"output_format": "polling"})
    if not r.get("success"):
        print("export start failed:", json.dumps(r.get("errors"), ensure_ascii=False))
        return 1
    result = r["result"] or {}
    if result.get("error"):
        print("export error:", result["error"])
        return 1

    # 2. poll until signed_url appears
    deadline = time.time() + POLL_TIMEOUT
    signed_url = result.get("signed_url")
    bookmark = result.get("at_bookmark")
    while not signed_url and time.time() < deadline:
        time.sleep(POLL_INTERVAL)
        payload = {"output_format": "polling"}
        if bookmark:
            payload["current_bookmark"] = bookmark
        r = api_call("POST", export_path, payload)
        if not r.get("success"):
            print("poll failed:", json.dumps(r.get("errors"), ensure_ascii=False))
            return 1
        result = r["result"] or {}
        if result.get("error"):
            print("export error:", result["error"])
            return 1
        signed_url = result.get("signed_url")
        bookmark = result.get("at_bookmark") or bookmark
    if not signed_url:
        print("export did not finish within %ds; it auto-cancels server-side" % POLL_TIMEOUT)
        return 1

    # 3. download dump (signed URL, no auth header, redirects allowed)
    ts = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y%m%d-%H%M%S")
    out_path = os.path.join(BACKUP_DIR, f"forum-db-{ts}.sql")
    req = urllib.request.Request(signed_url, method="GET")
    with urllib.request.build_opener().open(req, timeout=120) as resp, open(
        out_path, "wb"
    ) as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    size = os.path.getsize(out_path)
    print(f"backup ok: {out_path} ({size} bytes)")

    # 4. rotation: keep newest KEEP
    dumps = sorted(
        f for f in os.listdir(BACKUP_DIR)
        if f.startswith("forum-db-") and f.endswith(".sql")
    )
    for old in dumps[:-KEEP] if len(dumps) > KEEP else []:
        os.remove(os.path.join(BACKUP_DIR, old))
        print("rotated out:", old)
    return 0


if __name__ == "__main__":
    sys.exit(main())
