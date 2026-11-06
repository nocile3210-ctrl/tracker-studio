// Tracker Studio 前端（无依赖，原生 JS）
const $ = (id) => document.getElementById(id);
const state = {
  mode: "replace",
  host: "",
  plan: null,
  job: null,
  timer: null,
  summary: null,
};

/* ---------------- 基础 ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function openPanel(id) { $(id).classList.remove("hidden"); }
function closePanel(id) { $(id).classList.add("hidden"); }

document.querySelectorAll("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => closePanel(btn.dataset.close))
);

/* ---------------- 主题 ---------------- */
const savedTheme = localStorage.getItem("ts-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("btn-theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("ts-theme", next);
});

/* ---------------- 连接 ---------------- */
$("btn-connect").addEventListener("click", () => openPanel("connect-panel"));
$("f-kind").addEventListener("change", () => {
  const kind = $("f-kind").value;
  $("f-url").placeholder = kind === "transmission"
    ? "http://127.0.0.1:9091/transmission/rpc"
    : "http://127.0.0.1:8080";
});

$("btn-do-connect").addEventListener("click", async () => {
  const button = $("btn-do-connect");
  button.disabled = true;
  button.textContent = "连接中…";
  try {
    const { connection } = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({
        kind: $("f-kind").value,
        url: $("f-url").value.trim(),
        username: $("f-user").value,
        password: $("f-pass").value,
        insecure: $("f-insecure").checked,
      }),
    });
    const info = connection.info;
    $("conn-badge").textContent = `${info.kind === "transmission" ? "Transmission" : "qBittorrent"} ${info.version || ""}`.trim();
    $("conn-badge").className = "badge ok";
    $("s-version").textContent = info.version || "—";
    closePanel("connect-panel");
    toast("已连接，正在拉取清单…");
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "连接";
  }
});

/* ---------------- 刷新与渲染 ---------------- */
async function refresh() {
  const summary = await api("/api/refresh", { method: "POST", body: "{}" });
  state.summary = summary;
  renderSummary(summary);
  await renderTorrents();
  $("btn-preview").disabled = false;
  $("btn-refresh").disabled = false;
  $("btn-export").disabled = false;
}

function renderSummary(summary) {
  $("s-torrents").textContent = summary.torrents.toLocaleString();
  $("s-trackers").textContent = summary.trackers.toLocaleString();
  $("s-hosts").textContent = summary.hosts.length.toLocaleString();
  $("s-loaded").textContent = summary.loadedAt
    ? summary.loadedAt.replace("T", " ").slice(0, 19)
    : "—";
  renderHosts(summary.hosts);
}

function renderHosts(hosts) {
  const list = $("host-list");
  const keyword = ($("host-search").value || "").toLowerCase();
  const rows = hosts.filter((h) => !keyword || h.key.toLowerCase().includes(keyword));
  $("host-count").textContent = rows.length;
  list.innerHTML = "";
  const all = document.createElement("li");
  all.className = state.host === "" ? "on" : "";
  all.innerHTML = `<span>全部站点</span><span class="num">${(state.summary?.hosts || []).reduce((n, h) => n + h.count, 0)}</span>`;
  all.addEventListener("click", () => { state.host = ""; renderHosts(state.summary.hosts); renderTorrents(); });
  list.appendChild(all);
  rows.slice(0, 400).forEach((h) => {
    const li = document.createElement("li");
    li.className = state.host === h.key ? "on" : "";
    li.innerHTML = `<span title="${h.key}">${h.key}</span><span class="num">${h.count}</span>`;
    li.addEventListener("click", () => { state.host = h.key; renderHosts(state.summary.hosts); renderTorrents(); });
    list.appendChild(li);
  });
}

$("host-search").addEventListener("input", () => state.summary && renderHosts(state.summary.hosts));

let searchTimer = null;
$("torrent-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTorrents, 250);
});

async function renderTorrents() {
  if (!state.summary) return;
  const q = $("torrent-search").value.trim();
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&host=${encodeURIComponent(state.host)}&limit=300`);
  const list = $("torrent-list");
  if (!data.items.length) {
    list.innerHTML = `<p class="empty">没有匹配的种子</p>`;
    return;
  }
  list.innerHTML = "";
  data.items.forEach((tor) => {
    const row = document.createElement("div");
    row.className = "torrent";
    const urls = tor.trackers.map((t) => t.url);
    const first = urls[0] || "（无 tracker）";
    const extra = urls.length > 1 ? `+${urls.length - 1}` : "";
    row.innerHTML = `
      <div>
        <div class="name" title="${tor.name.replace(/"/g, "&quot;")}">${tor.name}</div>
        <div class="meta">${(tor.size / 1073741824).toFixed(2)} GB · ${urls.length} tracker</div>
      </div>
      <div>
        <div class="tracker" title="${first.replace(/"/g, "&quot;")}">${first}</div>
        ${extra ? `<div class="meta"><span class="chip">${extra}</span></div>` : ""}
      </div>`;
    list.appendChild(row);
  });
  if (data.total > data.items.length) {
    const more = document.createElement("p");
    more.className = "empty";
    more.textContent = `共 ${data.total} 个匹配，当前显示前 ${data.items.length} 个（用搜索或站点过滤缩小范围）`;
    list.appendChild(more);
  }
}

/* ---------------- 模式切换 ---------------- */
document.querySelectorAll("#mode-seg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    state.mode = btn.dataset.mode;
    $("o-old").disabled = state.mode === "add";
    $("o-old").placeholder = state.mode === "add" ? "追加模式不需要旧 tracker" : "tracker.example.com 或完整 URL";
    $("o-new").disabled = false;
    $("btn-preview").textContent = state.mode === "remove" ? "预览删除" : "预览改动";
  });
});

/* ---------------- 预览 ---------------- */
$("btn-preview").addEventListener("click", async () => {
  const button = $("btn-preview");
  button.disabled = true;
  button.textContent = "计算中…";
  try {
    const plan = await api("/api/plan", {
      method: "POST",
      body: JSON.stringify({
        mode: state.mode,
        match: $("o-match").value,
        old: $("o-old").value.trim(),
        new: $("o-new").value.trim(),
        nameFilter: $("o-name").value.trim(),
        hostFilter: state.host,
        limit: Number($("o-limit").value || 0),
      }),
    });
    state.plan = plan;
    renderPreview(plan);
    openPanel("preview-drawer");
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = state.mode === "remove" ? "预览删除" : "预览改动";
  }
});

function renderPreview(plan) {
  const modeLabel = { replace: "替换", add: "追加", remove: "删除" }[plan.mode] || plan.mode;
  $("preview-title").textContent = `${modeLabel}预览 · ${plan.changes.length} 个种子`;
  $("preview-sub").textContent = plan.changes.length
    ? `新 URL：${plan.new}`
    : "没有匹配到需要改动的种子";
  $("preview-warnings").innerHTML = (plan.warnings || [])
    .map((w) => `<div class="warn-item">⚠ ${w}</div>`)
    .join("");
  const body = $("preview-rows");
  body.innerHTML = "";
  plan.changes.slice(0, 500).forEach((c) => {
    const tr = document.createElement("tr");
    const olds = c.old.length ? c.old.join("<br>") : "（追加）";
    tr.innerHTML = `
      <td title="${c.name.replace(/"/g, "&quot;")}">${c.name}</td>
      <td class="url">${olds}</td>
      <td class="url new">${plan.mode === "remove" ? "（删除）" : c.new}</td>`;
    body.appendChild(tr);
  });
  if (plan.changes.length > 500) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="url">… 另有 ${plan.changes.length - 500} 条</td>`;
    body.appendChild(tr);
  }
  $("btn-apply").disabled = !plan.changes.length;
}

/* ---------------- 执行与进度 ---------------- */
$("btn-apply").addEventListener("click", async () => {
  if (!state.plan || !state.plan.changes.length) return;
  const count = state.plan.changes.length;
  if (!confirm(`确认对 ${count} 个种子执行改动？执行前会自动备份。`)) return;
  closePanel("preview-drawer");
  try {
    const job = await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({ planId: state.plan.id }),
    });
    watchJob(job);
  } catch (err) {
    toast(err.message, true);
  }
});

function watchJob(job) {
  state.job = job;
  $("progress-modal").classList.remove("hidden");
  $("progress-title").textContent = "执行中…";
  $("progress-errors").innerHTML = "";
  $("btn-close-progress").classList.add("hidden");
  pollJob(job.id);
}

async function pollJob(id) {
  clearTimeout(state.timer);
  try {
    const job = await api(`/api/job/${id}`);
    const percent = job.percent || 0;
    $("progress-bar").style.width = `${percent}%`;
    $("progress-text").textContent = `${job.done} / ${job.total}（${percent}%）`;
    $("progress-errors").innerHTML = (job.errors || [])
      .slice(0, 20)
      .map((e) => `<div>${e.name || e.id}：${e.error}</div>`)
      .join("");
    if (job.status === "running") {
      state.timer = setTimeout(() => pollJob(id), 500);
      return;
    }
    $("progress-title").textContent = job.errors?.length ? "完成（有失败项）" : "完成";
    $("btn-close-progress").classList.remove("hidden");
    $("btn-close-progress").onclick = () => {
      $("progress-modal").classList.add("hidden");
      refresh().catch((err) => toast(err.message, true));
    };
  } catch (err) {
    $("progress-title").textContent = "任务失联";
    $("progress-errors").innerHTML = `<div>${err.message}</div>`;
    $("btn-close-progress").classList.remove("hidden");
  }
}

/* ---------------- 备份 ---------------- */
$("btn-backups").addEventListener("click", async () => {
  try {
    const data = await api("/api/backups");
    const list = $("backup-list");
    list.innerHTML = "";
    if (!data.items.length) {
      list.innerHTML = `<p class="empty">还没有备份</p>`;
    }
    data.items.forEach((b) => {
      const row = document.createElement("div");
      row.className = "backup";
      row.innerHTML = `
        <div>
          <div class="t">${b.createdAt || b.file}</div>
          <div class="s">${b.mode || ""} · ${b.count} 个种子 · ${(b.bytes / 1024).toFixed(1)} KB</div>
          <div class="s">${b.old || ""} → ${b.new || ""}</div>
        </div>`;
      const btn = document.createElement("button");
      btn.className = "btn ghost";
      btn.textContent = "回滚";
      btn.addEventListener("click", () => rollback(b));
      row.appendChild(btn);
      list.appendChild(row);
    });
    openPanel("backups-drawer");
  } catch (err) {
    toast(err.message, true);
  }
});

async function rollback(backup) {
  if (!confirm(`把备份 ${backup.createdAt} 里的 ${backup.count} 个种子恢复成记录中的 tracker？`)) return;
  closePanel("backups-drawer");
  try {
    const job = await api("/api/rollback", {
      method: "POST",
      body: JSON.stringify({ file: backup.file }),
    });
    watchJob(job);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 导出 ---------------- */
$("btn-export").addEventListener("click", () => {
  window.location.href = "/api/export.csv";
});

/* ---------------- 启动 ---------------- */
$("btn-refresh").addEventListener("click", () => refresh().catch((err) => toast(err.message, true)));
api("/api/health").then((h) => {
  $("subtitle").textContent = `本地 tracker 批量管理 · v${h.version}`;
}).catch(() => {});

// 页面刷新后，若后端已有连接/清单，直接把界面恢复到那个状态
api("/api/summary").then((s) => {
  if (s.connection) {
    const info = s.connection.info || {};
    $("conn-badge").textContent = `${info.kind === "transmission" ? "Transmission" : "qBittorrent"} ${info.version || ""}`.trim();
    $("conn-badge").className = "badge ok";
    $("s-version").textContent = info.version || "—";
    $("btn-connect").textContent = "重新连接";
  }
  if (s.loadedAt) {
    state.summary = s;
    renderSummary(s);
    renderTorrents();
    $("btn-preview").disabled = false;
    $("btn-refresh").disabled = false;
    $("btn-export").disabled = false;
  }
}).catch(() => {});
