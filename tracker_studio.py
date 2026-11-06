#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tracker Studio —— 本地 Web 界面的 BT 客户端 tracker 批量管理工具

设计目标
  * 一眼看清：把 14000 个种子压成"站点 → 种子数"的清单，而不是让你翻表格
  * 改之前先看：所有改动先生成计划（逐条 old → new），确认后才写
  * 可回滚：每次写入自动落盘备份，界面上一键回滚
  * 不碰危险的东西：只做 tracker 的 add / replace / remove，不动种子、不动文件

支持客户端
  * Transmission 2.10+ (RPC)。4.0 起 trackerList 优先；细粒度接口失败会自动回退
  * qBittorrent 4.x/5.x (Web API)。注意：qb 侧只处理每个种子的主 tracker，
    多 tracker 的种子请在客户端里核对（后端会提示）

只依赖 Python 3.9+ 标准库，不需要 pip install。
"""

import argparse
import base64
import csv
import io
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "Tracker Studio"
APP_VERSION = "1.0.0"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# --------------------------------------------------------------------------
# 通用小工具
# --------------------------------------------------------------------------

def now_stamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def host_of(url):
    try:
        parsed = urllib.parse.urlsplit(url if "://" in url else "http://" + url)
        return (parsed.hostname or "").lower()
    except ValueError:
        return ""


def tracker_key(url):
    """把 announce URL 归一成"站点"：协议 + 主机 + 路径，去掉 query。"""
    try:
        p = urllib.parse.urlsplit(url if "://" in url else "http://" + url)
    except ValueError:
        return url
    path = p.path or "/"
    return f"{p.scheme}://{p.netloc}{path}"


def mask_secret(text):
    """把 URL 里的 passkey/authkey 打码，便于截图分享。"""
    if not text:
        return text
    import re
    return re.sub(r"((?:passkey|authkey|torrent_pass)=)([A-Za-z0-9]{4})[A-Za-z0-9]+", r"\1\2****", text)


class RpcError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Transmission 适配器
# --------------------------------------------------------------------------

class Transmission:
    kind = "transmission"
    label = "Transmission"

    def __init__(self, url, username=None, password=None, insecure=False, timeout=60):
        self.url = url
        self.timeout = timeout
        self.session_id = None
        self.auth = None
        if username:
            token = base64.b64encode(f"{username}:{password or ''}".encode()).decode("ascii")
            self.auth = "Basic " + token
        self.ctx = ssl.create_default_context()
        if insecure:
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE
        self.version = None
        self.rpc_version = None

    def rpc(self, method, arguments=None):
        payload = json.dumps({"method": method, "arguments": arguments or {}}).encode()
        for _ in range(3):
            req = urllib.request.Request(self.url, data=payload, method="POST")
            req.add_header("Content-Type", "application/json")
            if self.auth:
                req.add_header("Authorization", self.auth)
            if self.session_id:
                req.add_header("X-Transmission-Session-Id", self.session_id)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as resp:
                    body = json.loads(resp.read().decode())
            except urllib.error.HTTPError as exc:
                if exc.code == 409:
                    self.session_id = exc.headers.get("X-Transmission-Session-Id")
                    continue
                if exc.code == 401:
                    raise RpcError("认证失败（401）：用户名或密码不对")
                raise RpcError(f"HTTP {exc.code}：{exc.reason}")
            except urllib.error.URLError as exc:
                raise RpcError(f"连不上 {self.url}：{exc.reason}")
            if body.get("result") != "success":
                raise RpcError(f"{method} 失败：{body.get('result')!r}")
            return body.get("arguments") or {}
        raise RpcError("多次 409 未拿到 session id")

    def probe(self):
        info = self.rpc("session-get", {"fields": ["version", "rpc-version"]})
        self.version = info.get("version")
        self.rpc_version = info.get("rpc-version")
        stats = self.rpc("session-stats", {})
        return {
            "kind": self.kind,
            "version": self.version,
            "rpcVersion": self.rpc_version,
            "torrentCount": stats.get("torrentCount"),
            "downloadSpeed": stats.get("downloadSpeed"),
            "uploadSpeed": stats.get("uploadSpeed"),
        }

    def torrents(self):
        args = self.rpc("torrent-get", {"fields": ["id", "name", "hashString", "trackers", "totalSize"]})
        out = []
        for item in args.get("torrents") or []:
            trackers = []
            for index, tr in enumerate(item.get("trackers") or []):
                if isinstance(tr, str):
                    trackers.append({"id": index, "url": tr, "tier": 0})
                else:
                    trackers.append({
                        "id": tr.get("id", index),
                        "url": tr.get("announce") or "",
                        "tier": tr.get("tier", 0),
                    })
            out.append({
                "id": item.get("id"),
                "hash": item.get("hashString"),
                "name": item.get("name") or "",
                "size": item.get("totalSize") or 0,
                "trackers": trackers,
            })
        return out

    def apply_change(self, torrent, mode, new_url, hit_ids):
        """返回 (ok, note)。优先细粒度接口，失败回退 trackerList。"""
        trackers = torrent["trackers"]
        payload = {"ids": [torrent["id"]]}
        if mode == "replace":
            payload["trackerReplace"] = [v for tid in hit_ids for v in (tid, new_url)]
            drop = set(hit_ids)
            rebuilt = [{"id": t["id"], "url": new_url if t["id"] in drop else t["url"], "tier": t["tier"]}
                       for t in trackers]
        elif mode == "add":
            payload["trackerAdd"] = [new_url]
            rebuilt = trackers + [{"id": 10 ** 6 + len(trackers), "url": new_url, "tier": 0}]
        else:
            payload["trackerRemove"] = list(hit_ids)
            drop = set(hit_ids)
            rebuilt = [t for t in trackers if t["id"] not in drop]

        first_error = None
        try:
            self.rpc("torrent-set", payload)
            return True, "ok"
        except RpcError as exc:
            first_error = str(exc)

        if self.rpc_version is not None and self.rpc_version < 17:
            return False, first_error

        try:
            self.rpc("torrent-set", {"ids": [torrent["id"]], "trackerList": tracker_list_text(rebuilt)})
            return True, "ok (trackerList)"
        except RpcError as exc:
            return False, f"{first_error} / list fallback: {exc}"


def tracker_list_text(trackers):
    tiers = {}
    for tr in trackers:
        tiers.setdefault(tr.get("tier", 0), []).append(tr["url"])
    return "\n\n".join("\n".join(tiers[t]) for t in sorted(tiers))


# --------------------------------------------------------------------------
# qBittorrent 适配器（只处理主 tracker，界面上会标注）
# --------------------------------------------------------------------------

class QBittorrent:
    kind = "qbittorrent"
    label = "qBittorrent"

    def __init__(self, url, username=None, password=None, insecure=False, timeout=60, max_torrents=2000):
        self.base = url.rstrip("/")
        self.timeout = timeout
        self.max_torrents = max_torrents
        self.jar = CookieJar()
        self.ctx = ssl.create_default_context()
        if insecure:
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=self.ctx),
        )
        self.username = username
        self.password = password
        self.version = None

    def _req(self, path, data=None, headers=None):
        url = f"{self.base}{path}"
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
        if body is not None:
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                return resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise RpcError("认证失败：qBittorrent 用户名或密码不对")
            raise RpcError(f"HTTP {exc.code}：{exc.reason}")
        except urllib.error.URLError as exc:
            raise RpcError(f"连不上 {self.base}：{exc.reason}")

    def probe(self):
        text = self._req("/api/v2/app/version")
        self.version = (text or "").strip().lstrip("v")
        login = self._req("/api/v2/auth/login", {"username": self.username or "", "password": self.password or ""})
        if "ok" not in (login or "").lower():
            raise RpcError("qBittorrent 登录失败：检查用户名/密码，或是否启用了 Web UI")
        info = json.loads(self._req("/api/v2/torrents/info") or "[]")
        return {
            "kind": self.kind,
            "version": self.version,
            "rpcVersion": None,
            "torrentCount": len(info),
            "downloadSpeed": 0,
            "uploadSpeed": 0,
        }

    def torrents(self):
        info = json.loads(self._req("/api/v2/torrents/info") or "[]")
        if len(info) > self.max_torrents:
            info = info[: self.max_torrents]
        out = []
        for item in info:
            url = item.get("tracker") or ""
            out.append({
                "id": item.get("hash"),
                "hash": item.get("hash"),
                "name": item.get("name") or "",
                "size": item.get("size") or 0,
                "trackers": [{"id": 0, "url": url, "tier": 0}] if url else [],
            })
        return out

    def apply_change(self, torrent, mode, new_url, hit_ids):
        h = torrent["hash"]
        old = torrent["trackers"][0]["url"] if torrent["trackers"] else ""
        try:
            if mode == "replace":
                self._req("/api/v2/torrents/editTracker", {"hash": h, "origUrl": old, "newUrl": new_url})
            elif mode == "add":
                self._req("/api/v2/torrents/addTrackers", {"hash": h, "urls": new_url})
            else:
                self._req("/api/v2/torrents/removeTrackers", {"hash": h, "urls": old})
            return True, "ok"
        except RpcError as exc:
            return False, str(exc)


# --------------------------------------------------------------------------
# 状态与业务逻辑
# --------------------------------------------------------------------------

class Studio:
    def __init__(self):
        self.lock = threading.Lock()
        self.client = None
        self.conn = None
        self.inventory = []
        self.loaded_at = None
        self.jobs = {}
        os.makedirs(BACKUP_DIR, exist_ok=True)

    # ---- 连接 ----
    def connect(self, payload):
        kind = (payload.get("kind") or "transmission").lower()
        url = (payload.get("url") or "").strip()
        if not url:
            raise RpcError("请填写客户端地址")
        if kind == "qbittorrent" and not url.rstrip("/").startswith("http"):
            url = "http://" + url
        user = payload.get("username") or None
        secret = payload.get("password") or None
        insecure = bool(payload.get("insecure"))
        client = Transmission(url, user, secret, insecure) if kind == "transmission" \
            else QBittorrent(url, user, secret, insecure)
        info = client.probe()
        with self.lock:
            self.client = client
            self.conn = {"kind": kind, "url": url, "info": info,
                         "connectedAt": datetime.now().isoformat(timespec="seconds")}
            self.inventory = []
            self.loaded_at = None
        return self.conn

    def require_client(self):
        if not self.client:
            raise RpcError("尚未连接客户端")
        return self.client

    # ---- 清单 ----
    def refresh(self):
        client = self.require_client()
        items = client.torrents()
        with self.lock:
            self.inventory = items
            self.loaded_at = datetime.now().isoformat(timespec="seconds")
        return self.summary()

    def summary(self):
        hosts = {}
        for tor in self.inventory:
            for tr in tor["trackers"]:
                hosts.setdefault(tracker_key(tr["url"]), 0)
                hosts[tracker_key(tr["url"])] += 1
        ranked = sorted(hosts.items(), key=lambda kv: -kv[1])
        return {
            "torrents": len(self.inventory),
            "trackers": sum(len(t["trackers"]) for t in self.inventory),
            "hosts": [{"key": k, "count": c} for k, c in ranked],
            "loadedAt": self.loaded_at,
            "connection": self.conn,
        }

    def search(self, query="", host="", limit=500, offset=0):
        query = (query or "").strip().lower()
        rows = []
        for tor in self.inventory:
            if host and not any(tracker_key(t["url"]) == host for t in tor["trackers"]):
                continue
            if query and query not in tor["name"].lower():
                continue
            rows.append(tor)
        total = len(rows)
        page = rows[offset: offset + limit]
        return {"total": total, "offset": offset, "limit": limit,
                "items": [{"id": t["id"], "name": t["name"], "size": t["size"],
                           "trackers": t["trackers"]} for t in page]}

    # ---- 计划 ----
    def build_plan(self, payload):
        mode = payload.get("mode") or "replace"
        match = payload.get("match") or "host"
        old = (payload.get("old") or "").strip()
        new = (payload.get("new") or "").strip()
        name_filter = (payload.get("nameFilter") or "").strip().lower()
        host_filter = (payload.get("hostFilter") or "").strip()
        limit = int(payload.get("limit") or 0)

        if mode not in ("replace", "add", "remove"):
            raise RpcError("未知模式")
        if mode != "add" and not old:
            raise RpcError("请填写要匹配的旧 tracker")
        if mode != "remove" and not new:
            raise RpcError("请填写新的 announce URL")
        if mode != "remove" and not new.startswith(("http://", "https://", "udp://")):
            raise RpcError("新的 announce URL 必须以 http:// https:// 或 udp:// 开头")

        def hit(url):
            if match == "exact":
                return url == old
            if match == "contains":
                return old in url
            if match == "host":
                return host_of(url) == host_of(old)
            if match == "regex":
                import re
                return re.search(old, url) is not None
            return False

        changes, warnings, seen_hosts = [], [], set()
        for tor in self.inventory:
            if name_filter and name_filter not in tor["name"].lower():
                continue
            if host_filter and not any(tracker_key(t["url"]) == host_filter for t in tor["trackers"]):
                continue
            if mode == "add":
                if any(t["url"] == new for t in tor["trackers"]):
                    continue
                hits = []
            else:
                hits = [t for t in tor["trackers"] if hit(t["url"]) and t["url"] != new]
                if not hits:
                    continue
            if limit and len(changes) >= limit:
                warnings.append(f"已达到上限 {limit}，其余未纳入本次计划")
                break
            seen_hosts.add(host_of(hits[0]["url"]) if hits else "")
            changes.append({
                "torrentId": tor["id"],
                "name": tor["name"],
                "hitIds": [h["id"] for h in hits],
                "old": [h["url"] for h in hits],
                "new": new,
                "mode": mode,
            })

        if mode == "add" and changes:
            total_with_new = sum(1 for t in self.inventory if any(x["url"] == new for x in t["trackers"]))
            if total_with_new:
                warnings.append(f"已有 {total_with_new} 个种子包含该 URL，这些种子会被跳过")
        if mode == "replace" and changes:
            overlap = sum(1 for t in self.inventory
                          if any(x["url"] == new for x in t["trackers"])
                          and any(t is not None for x in []))
            if overlap:
                warnings.append(f"有 {overlap} 个种子已经包含新 URL")

        plan = {
            "id": uuid.uuid4().hex[:12],
            "mode": mode,
            "match": match,
            "old": old,
            "new": new,
            "createdAt": datetime.now().isoformat(timespec="seconds"),
            "changes": changes,
            "warnings": warnings,
            "hosts": sorted(h for h in seen_hosts if h),
        }
        with self.lock:
            self.jobs.setdefault("_plans", {})[plan["id"]] = plan
        return plan

    # ---- 执行 ----
    def apply_plan(self, plan_id):
        plans = self.jobs.get("_plans") or {}
        plan = plans.get(plan_id)
        if not plan:
            raise RpcError("计划已过期，请重新预览")
        client = self.require_client()
        backup_path = os.path.join(BACKUP_DIR, f"backup-{now_stamp()}.json")
        with open(backup_path, "w", encoding="utf-8") as fh:
            json.dump({"createdAt": plan["createdAt"], "mode": plan["mode"],
                       "old": plan["old"], "new": plan["new"],
                       "changes": plan["changes"]}, fh, ensure_ascii=False, indent=2)

        job = {"id": uuid.uuid4().hex[:12], "status": "running", "done": 0,
               "total": len(plan["changes"]), "errors": [], "startedAt": time.time(),
               "backup": os.path.basename(backup_path), "mode": plan["mode"]}
        with self.lock:
            self.jobs[job["id"]] = job

        by_id = {t["id"]: t for t in self.inventory}

        def run():
            for change in plan["changes"]:
                tor = by_id.get(change["torrentId"])
                if not tor:
                    job["errors"].append({"id": change["torrentId"], "error": "种子已不存在"})
                    continue
                current = {t["id"]: t["url"] for t in tor["trackers"]}
                if plan["mode"] != "add":
                    if not any(current.get(i) == change["old"][n] for n, i in enumerate(change["hitIds"])):
                        job["errors"].append({"id": tor["id"], "name": tor["name"],
                                              "error": "tracker 已变化，跳过"})
                        continue
                ok, note = client.apply_change(tor, plan["mode"], plan["new"], change["hitIds"])
                if not ok:
                    job["errors"].append({"id": tor["id"], "name": tor["name"], "error": note})
                job["done"] += 1
                time.sleep(0.01 if client.kind == "qbittorrent" else 0.05)
            job["status"] = "done"
            try:
                self.refresh()          # 改动后立刻回读，避免清单停留在改动前
            except RpcError:
                pass

        threading.Thread(target=run, daemon=True).start()
        return job

    def job(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            raise RpcError("没有这个任务")
        payload = dict(job)
        if job["status"] == "running" and job["total"]:
            payload["percent"] = round(job["done"] * 100 / job["total"], 1)
        else:
            payload["percent"] = 100 if job["status"] == "done" else 0
        return payload

    # ---- 备份 ----
    def backups(self):
        rows = []
        if os.path.isdir(BACKUP_DIR):
            for name in sorted(os.listdir(BACKUP_DIR), reverse=True):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(BACKUP_DIR, name)
                try:
                    with open(path, encoding="utf-8") as fh:
                        data = json.load(fh)
                    rows.append({"file": name, "createdAt": data.get("createdAt"),
                                 "mode": data.get("mode"), "count": len(data.get("changes") or []),
                                 "old": mask_secret(data.get("old") or ""),
                                 "new": mask_secret(data.get("new") or ""),
                                 "bytes": os.path.getsize(path)})
                except (OSError, ValueError):
                    continue
        return rows

    def rollback(self, filename):
        path = os.path.join(BACKUP_DIR, os.path.basename(filename))
        if not os.path.isfile(path):
            raise RpcError("备份不存在")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        client = self.require_client()
        by_id = {t["id"]: t for t in self.inventory}
        job = {"id": uuid.uuid4().hex[:12], "status": "running", "done": 0,
               "total": len(data.get("changes") or []), "errors": [],
               "startedAt": time.time(), "backup": os.path.basename(path), "mode": "rollback"}
        with self.lock:
            self.jobs[job["id"]] = job

        def run():
            for change in data.get("changes") or []:
                tor = by_id.get(change["torrentId"])
                if not tor:
                    job["errors"].append({"id": change["torrentId"], "error": "种子已不存在"})
                    job["done"] += 1
                    continue
                for index, tracker_id in enumerate(change["hitIds"]):
                    original = change["old"][index]
                    ok, note = client.apply_change(tor, "replace", original, [tracker_id])
                    if not ok:
                        job["errors"].append({"id": tor["id"], "name": tor["name"], "error": note})
                job["done"] += 1
            job["status"] = "done"
            try:
                self.refresh()
            except RpcError:
                pass

        threading.Thread(target=run, daemon=True).start()
        return job


STUDIO = Studio()


# --------------------------------------------------------------------------
# HTTP 层
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"TrackerStudio/{APP_VERSION}"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ----
    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise RpcError("请求体不是合法 JSON")

    def _static(self, path):
        name = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._send(404, {"error": "not found"})
            return
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                 "css": "text/css; charset=utf-8", "svg": "image/svg+xml",
                 "png": "image/png", "ico": "image/x-icon"}.get(full.rsplit(".", 1)[-1], "application/octet-stream")
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    # ---- routes ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route, query = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if route in ("/", "/index.html"):
                return self._static("index.html")
            if route.startswith("/static/"):
                return self._static(route[len("/static/"):])
            if route == "/api/health":
                return self._send(200, {"ok": True, "version": APP_VERSION})
            if route == "/api/summary":
                return self._send(200, STUDIO.summary())
            if route == "/api/search":
                return self._send(200, STUDIO.search(
                    query=(query.get("q") or [""])[0],
                    host=(query.get("host") or [""])[0],
                    limit=int((query.get("limit") or ["200"])[0]),
                    offset=int((query.get("offset") or ["0"])[0]),
                ))
            if route.startswith("/api/job/"):
                return self._send(200, STUDIO.job(route.rsplit("/", 1)[-1]))
            if route == "/api/backups":
                return self._send(200, {"items": STUDIO.backups()})
            if route == "/api/export.csv":
                return self._export_csv()
            return self._send(404, {"error": "not found"})
        except RpcError as exc:
            return self._send(400, {"error": str(exc)})

    def do_POST(self):
        route = urllib.parse.urlparse(self.path).path
        try:
            body = self._json_body()
            if route == "/api/connect":
                return self._send(200, {"connection": STUDIO.connect(body)})
            if route == "/api/refresh":
                return self._send(200, STUDIO.refresh())
            if route == "/api/plan":
                return self._send(200, STUDIO.build_plan(body))
            if route == "/api/apply":
                return self._send(200, STUDIO.apply_plan(body.get("planId") or ""))
            if route == "/api/rollback":
                return self._send(200, STUDIO.rollback(body.get("file") or ""))
            return self._send(404, {"error": "not found"})
        except RpcError as exc:
            return self._send(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - 界面要看到真实原因
            return self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def _export_csv(self):
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["torrent_id", "name", "tracker_tier", "announce"])
        for tor in STUDIO.inventory:
            for tr in tor["trackers"]:
                writer.writerow([tor["id"], tor["name"], tr["tier"], mask_secret(tr["url"])])
        data = buf.getvalue().encode("utf-8-sig")
        self._send(200, data, "text/csv; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="trackers-{now_stamp()}.csv"'})


def main():
    parser = argparse.ArgumentParser(description=f"{APP_NAME} {APP_VERSION}")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"{APP_NAME} {APP_VERSION} 已启动：{url}")
    print("按 Ctrl+C 停止")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
