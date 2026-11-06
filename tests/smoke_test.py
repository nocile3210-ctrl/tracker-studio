# -*- coding: utf-8 -*-
"""端到端冒烟测试：假 Transmission RPC + 真 Studio HTTP 服务。

覆盖：连接 → 刷新清单 → 预览计划 → 执行 → 校验 → 回滚 → 再次校验。
运行：python tests/smoke_test.py      （无第三方依赖，不连接任何真实客户端）
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import tracker_studio as ts  # noqa: E402

SID = "smoke-session"
OLD = "https://tracker.demo.org/announce.php?passkey=OLD"
NEW = "https://tracker.demo.org/announce.php?passkey=NEW"
KEEP = "udp://keep.example:6969/announce"

TORRENTS = [
    {"id": 1, "name": "影片 A", "hashString": "a1", "totalSize": 1 << 30,
     "trackers": [{"id": 11, "announce": OLD, "tier": 0},
                  {"id": 12, "announce": KEEP, "tier": 1}]},
    {"id": 2, "name": "影片 B", "hashString": "b2", "totalSize": 2 << 30,
     "trackers": [{"id": 21, "announce": OLD, "tier": 0}]},
    {"id": 3, "name": "别的站", "hashString": "c3", "totalSize": 3 << 30,
     "trackers": [{"id": 31, "announce": "https://other.example/announce", "tier": 0}]},
]


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.headers.get("X-Transmission-Session-Id") != SID:
            self.send_response(409)
            self.send_header("X-Transmission-Session-Id", SID)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        method, args, result = body.get("method"), body.get("arguments") or {}, "success"

        if method == "session-get":
            out = {"version": "4.0.6", "rpc-version": 17}
        elif method == "session-stats":
            out = {"torrentCount": len(TORRENTS), "downloadSpeed": 0, "uploadSpeed": 0}
        elif method == "torrent-get":
            ids = args.get("ids")
            out = {"torrents": [t for t in TORRENTS if not ids or t["id"] in ids]}
        elif method == "torrent-set":
            for tid in args.get("ids") or []:
                tor = next((t for t in TORRENTS if t["id"] == tid), None)
                if not tor:
                    continue
                flat = args.get("trackerReplace")
                changed = False
                i = 0
                while flat and i + 1 < len(flat):
                    for tr in tor["trackers"]:
                        if tr["id"] == flat[i] and tr["announce"] != flat[i + 1]:
                            tr["announce"] = flat[i + 1]
                            changed = True
                    i += 2
                if flat and not changed:
                    result = "error setting announce list"
                if "trackerList" in args:
                    urls = [u for u in args["trackerList"].split("\n") if u.strip()]
                    tier, rebuilt = 0, []
                    for line in args["trackerList"].split("\n"):
                        if not line.strip():
                            tier += 1
                            continue
                        rebuilt.append({"id": 900 + len(rebuilt), "announce": line.strip(), "tier": tier})
                    tor["trackers"] = rebuilt
            out = {}
        else:
            result = "method not recognized"
            out = {}

        payload = json.dumps({"result": result, "arguments": out}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def call(base, path, data=None):
    req = urllib.request.Request(base + path, method="POST" if data is not None else "GET",
                                 data=json.dumps(data).encode() if data is not None else None)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def wait_job(base, job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = call(base, f"/api/job/{job_id}")
        if job["status"] != "running":
            return job
        time.sleep(0.1)
    raise AssertionError("任务超时")


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    mock_url = f"http://127.0.0.1:{mock.server_address[1]}/transmission/rpc"

    api = ThreadingHTTPServer(("127.0.0.1", 0), ts.Handler)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{api.server_address[1]}"

    checks = []

    def check(label, condition, extra=""):
        checks.append((label, bool(condition), extra))
        print(("PASS  " if condition else "FAIL  ") + label + (f"  [{extra}]" if extra else ""))

    conn = call(base, "/api/connect", {"kind": "transmission", "url": mock_url})["connection"]
    check("连接成功", conn["info"]["kind"] == "transmission", conn["info"]["version"])

    summary = call(base, "/api/refresh", {})
    check("清单条数", summary["torrents"] == 3, f'{summary["torrents"]} 个种子')
    check("站点聚合", len(summary["hosts"]) == 3, str([h["key"] for h in summary["hosts"]]))

    plan = call(base, "/api/plan", {"mode": "replace", "match": "host",
                                    "old": "tracker.demo.org", "new": NEW})
    check("预览命中 2 个", len(plan["changes"]) == 2, str(len(plan["changes"])))

    backups_before = len(call(base, "/api/backups")["items"])
    job = wait_job(base, call(base, "/api/apply", {"planId": plan["id"]})["id"])
    check("执行无错误", not job["errors"], str(job["errors"]))
    check("执行进度完整", job["done"] == 2, f'{job["done"]}/{job["total"]}')

    torrents = call(base, "/api/search?limit=10")["items"]
    by_id = {t["id"]: t for t in torrents}
    check("新 URL 已写入", any(x["url"] == NEW for x in by_id[1]["trackers"]))
    check("旁路 tracker 保留", any(x["url"] == KEEP for x in by_id[1]["trackers"]))
    check("tier 结构保留",
          sorted((x["url"], x["tier"]) for x in by_id[1]["trackers"]) == sorted([(NEW, 0), (KEEP, 1)]))
    check("未命中的种子未变", by_id[3]["trackers"][0]["url"] == "https://other.example/announce")

    backups = call(base, "/api/backups")["items"]
    check("自动备份已生成", len(backups) == backups_before + 1, backups[0]["file"] if backups else "—")

    rb = wait_job(base, call(base, "/api/rollback", {"file": backups[0]["file"]})["id"])
    check("回滚无错误", not rb["errors"], str(rb["errors"]))

    torrents = call(base, "/api/search?limit=10")["items"]
    by_id = {t["id"]: t for t in torrents}
    check("回滚恢复旧 URL", any(x["url"] == OLD for x in by_id[1]["trackers"]),
          str([x["url"] for x in by_id[1]["trackers"]]))

    mock.shutdown()
    api.shutdown()

    failed = [c for c in checks if not c[1]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
