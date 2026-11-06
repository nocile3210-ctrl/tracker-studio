// ==UserScript==
// @name         Tracker Studio Lite
// @namespace    https://github.com/nocile3210-ctrl/tracker-studio
// @version      1.0.0
// @description  在 Transmission Web 界面里批量替换 / 追加 / 删除 tracker：站点聚合、逐条 diff 预览、备份与撤销
// @author       Nocile
// @match        *://*/transmission/web/*
// @match        *://*/transmission/web/
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * RPC
   * ------------------------------------------------------------------ */
  const RPC_URL = (() => {
    const i = location.pathname.indexOf('/transmission/web');
    const root = i >= 0 ? location.pathname.slice(0, i) : '';
    return location.origin + root + '/transmission/rpc';
  })();

  let sessionId = null;
  let rpcVersion = null;

  async function rpc(method, args) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          sessionId ? { 'X-Transmission-Session-Id': sessionId } : {}
        ),
        body: JSON.stringify({ method, arguments: args || {} }),
      });
      if (res.status === 409) {
        sessionId = res.headers.get('X-Transmission-Session-Id');
        continue;
      }
      if (res.status === 401) throw new Error('认证失败：请先登录 Transmission Web');
      const data = await res.json();
      if (data.result !== 'success') throw new Error(data.result);
      return data.arguments || {};
    }
    throw new Error('RPC 409：拿不到 session id');
  }

  /* ------------------------------------------------------------------ *
   * 数据
   * ------------------------------------------------------------------ */
  const state = {
    torrents: [],
    hosts: [],
    host: '',
    plan: null,
    backup: null,
    running: false,
  };

  const hostOf = (url) => {
    try { return new URL(url.includes('://') ? url : 'http://' + url).hostname.toLowerCase(); } catch (e) { return ''; }
  };
  const siteKey = (url) => {
    try {
      const u = new URL(url);
      return u.protocol + '//' + u.host + (u.pathname || '/');
    } catch (e) { return url; }
  };

  function normalizeTrackers(list) {
    return (list || []).map((t, i) =>
      typeof t === 'string'
        ? { id: i, url: t, tier: 0 }
        : { id: t.id !== undefined ? t.id : i, url: t.announce || '', tier: t.tier || 0 }
    );
  }

  async function loadTorrents() {
    const args = await rpc('torrent-get', { fields: ['id', 'name', 'trackers', 'totalSize'] });
    state.torrents = (args.torrents || []).map((t) => ({
      id: t.id,
      name: t.name || '',
      size: t.totalSize || 0,
      trackers: normalizeTrackers(t.trackers),
    }));
    const counter = new Map();
    for (const tor of state.torrents) {
      for (const tr of tor.trackers) {
        const key = siteKey(tr.url);
        counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
    state.hosts = [...counter.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
    if (state.host && !counter.has(state.host)) state.host = '';
  }

  /* ------------------------------------------------------------------ *
   * 计划
   * ------------------------------------------------------------------ */
  function buildPlan(opts) {
    const { mode, match, oldValue, newValue, nameFilter, host, limit } = opts;
    const test = (url) => {
      if (match === 'exact') return url === oldValue;
      if (match === 'contains') return url.includes(oldValue);
      if (match === 'host') return hostOf(url) === hostOf(oldValue);
      if (match === 'regex') {
        try { return new RegExp(oldValue).test(url); } catch (e) { return false; }
      }
      return false;
    };

    const changes = [];
    for (const tor of state.torrents) {
      if (host && !tor.trackers.some((t) => siteKey(t.url) === host)) continue;
      if (nameFilter && !tor.name.toLowerCase().includes(nameFilter.toLowerCase())) continue;

      let hits = [];
      if (mode === 'add') {
        if (tor.trackers.some((t) => t.url === newValue)) continue;
      } else {
        hits = tor.trackers.filter((t) => test(t.url) && t.url !== newValue);
        if (!hits.length) continue;
      }
      if (limit && changes.length >= limit) break;
      changes.push({
        torrentId: tor.id,
        name: tor.name,
        hitIds: hits.map((h) => h.id),
        oldUrls: hits.map((h) => h.url),
        newUrl: newValue,
      });
    }
    return { mode, match, oldValue, newValue, changes };
  }

  function trackerListText(trackers) {
    const tiers = new Map();
    for (const t of trackers) {
      if (!tiers.has(t.tier)) tiers.set(t.tier, []);
      tiers.get(t.tier).push(t.url);
    }
    return [...tiers.keys()].sort((a, b) => a - b).map((k) => tiers.get(k).join('\n')).join('\n\n');
  }

  async function applyChange(torrent, change, mode, newUrl) {
    const base = { ids: [torrent.id] };
    try {
      if (mode === 'replace') {
        await rpc('torrent-set', Object.assign({}, base, {
          trackerReplace: change.hitIds.flatMap((id) => [id, newUrl]),
        }));
      } else if (mode === 'add') {
        await rpc('torrent-set', Object.assign({}, base, { trackerAdd: [newUrl] }));
      } else {
        await rpc('torrent-set', Object.assign({}, base, { trackerRemove: change.hitIds.slice() }));
      }
      return null;
    } catch (err) {
      // 4.1+ 可能拒绝细粒度接口，回退整表重写
      const current = normalizeTrackers((await rpc('torrent-get', { ids: [torrent.id], fields: ['trackers'] })).torrents[0].trackers);
      let rebuilt;
      if (mode === 'replace') {
        rebuilt = current.map((t) => change.hitIds.includes(t.id) ? { ...t, url: newUrl } : t);
      } else if (mode === 'add') {
        rebuilt = current.concat([{ id: 1e6, url: newUrl, tier: 0 }]);
      } else {
        rebuilt = current.filter((t) => !change.hitIds.includes(t.id));
      }
      try {
        await rpc('torrent-set', Object.assign({}, base, { trackerList: trackerListText(rebuilt) }));
        return null;
      } catch (err2) {
        return String(err) + ' / 回退失败: ' + String(err2);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    .fab {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 52px; height: 52px; border-radius: 16px; border: none; cursor: pointer;
      background: linear-gradient(140deg, #4f8cff, #7c5cff); color: #fff; font-size: 22px;
      box-shadow: 0 10px 24px rgba(0,0,0,.4); transition: transform .15s;
    }
    .fab:hover { transform: translateY(-2px); }
    .panel {
      position: fixed; right: 22px; bottom: 86px; z-index: 2147483000;
      width: min(720px, calc(100vw - 44px)); max-height: min(78vh, 820px);
      display: flex; flex-direction: column; overflow: hidden;
      background: #131a22; color: #e6edf3; border: 1px solid #26303c; border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,.55); font-size: 13px;
    }
    .panel[hidden] { display: none; }
    .head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid #26303c; }
    .title { font-weight:600; letter-spacing:.2px; }
    .muted { color:#8b98a6; font-size:12px; }
    .body { padding: 12px 16px; overflow:auto; display:flex; flex-direction:column; gap:12px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    input, select {
      background:#0f1620; color:#e6edf3; border:1px solid #26303c; border-radius:9px;
      padding:7px 9px; font-size:12.5px; outline:none; width:100%;
    }
    input:focus, select:focus { border-color:#4f8cff; box-shadow:0 0 0 3px rgba(79,140,255,.15); }
    button {
      background:#1c2530; color:#e6edf3; border:1px solid #26303c; border-radius:9px;
      padding:7px 14px; font-size:12.5px; cursor:pointer; white-space:nowrap;
    }
    button:hover:not(:disabled) { border-color:#4f8cff; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    button.primary { background:#4f8cff; border-color:#4f8cff; color:#fff; }
    button.danger { background:#f85149; border-color:#f85149; color:#fff; }
    button.seg.on { background:#4f8cff; border-color:#4f8cff; color:#fff; }
    .list { max-height: 190px; overflow:auto; border:1px solid #26303c; border-radius:10px; }
    .item { display:flex; justify-content:space-between; gap:10px; padding:6px 10px; font-size:12px; cursor:pointer; }
    .item:hover { background:#1a2330; }
    .item.on { background:rgba(79,140,255,.14); color:#6ea8ff; }
    .item .k { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .count { color:#8b98a6; font-variant-numeric: tabular-nums; }
    .preview { border:1px solid #26303c; border-radius:10px; max-height:240px; overflow:auto; }
    .prow { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1.1fr); gap:10px; padding:6px 10px; border-bottom:1px solid #1e2732; font-size:11.5px; }
    .prow:last-child { border-bottom:none; }
    .prow .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .prow .u { color:#8b98a6; font-family:ui-monospace,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .warn { background:rgba(210,153,34,.13); border:1px solid rgba(210,153,34,.35); color:#d29922; border-radius:9px; padding:7px 10px; font-size:12px; }
    .ok { color:#3fb950; }
    .err { color:#f85149; }
    .bar { height:6px; background:#1c2530; border-radius:999px; overflow:hidden; }
    .bar > i { display:block; height:100%; width:0; background:linear-gradient(90deg,#4f8cff,#7c5cff); transition:width .2s; }
    .foot { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 16px; border-top:1px solid #26303c; }
    .log { max-height:110px; overflow:auto; font-size:11.5px; color:#f85149; }
  `;

  const template = `
    <button class="fab" id="fab" title="批量 Tracker（Ctrl+Alt+T）">🧭</button>
    <section class="panel" id="panel" hidden>
      <div class="head">
        <div>
          <div class="title">Tracker Studio Lite</div>
          <div class="muted" id="stats">未加载</div>
        </div>
        <div class="row">
          <button id="refresh">刷新</button>
          <button id="close">✕</button>
        </div>
      </div>
      <div class="body">
        <div class="row">
          <input id="hostSearch" placeholder="过滤站点…" style="flex:1" />
          <span class="muted" id="hostCount"></span>
        </div>
        <div class="list" id="hostList"></div>

        <div class="row" id="modeRow">
          <button class="seg on" data-mode="replace">替换</button>
          <button class="seg" data-mode="add">追加</button>
          <button class="seg" data-mode="remove">删除</button>
        </div>
        <div class="grid">
          <select id="match">
            <option value="host">按站点主机名</option>
            <option value="exact">完整 URL</option>
            <option value="contains">包含片段 / passkey</option>
            <option value="regex">正则</option>
          </select>
          <input id="nameFilter" placeholder="种子名过滤（可空）" />
        </div>
        <input id="oldValue" placeholder="旧 tracker：站点主机名或完整 URL" />
        <input id="newValue" placeholder="新 announce URL（http/https/udp）" />
        <div class="row">
          <input id="limit" type="number" min="0" placeholder="最多处理（0=全部）" style="flex:1" />
          <button id="preview" class="primary">预览</button>
        </div>
        <div id="warnings"></div>
        <div class="preview" id="previewBox" hidden></div>
        <div id="progressWrap" hidden>
          <div class="bar"><i id="progressBar"></i></div>
          <div class="muted" id="progressText" style="margin-top:6px">0 / 0</div>
          <div class="log" id="errorLog"></div>
        </div>
      </div>
      <div class="foot">
        <div class="muted" id="footText">改动前自动生成备份，可撤销</div>
        <div class="row">
          <button id="download" hidden>下载备份</button>
          <button id="undo" hidden>撤销上次</button>
          <button id="apply" class="danger" disabled>执行</button>
        </div>
      </div>
    </section>
  `;

  const host = document.createElement('div');
  host.id = 'tracker-studio-lite';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${css}</style>` + template;

  const $ = (id) => shadow.getElementById(id);
  let mode = 'replace';
  let loaded = false;

  function setStats() {
    if (!loaded) return;
    const total = state.torrents.reduce((n, t) => n + t.trackers.length, 0);
    $('stats').textContent = `${state.torrents.length.toLocaleString()} 个种子 · ${total.toLocaleString()} 条 tracker · ${state.hosts.length} 个站点`;
    $('hostCount').textContent = state.hosts.length;
  }

  function renderHosts() {
    const kw = $('hostSearch').value.trim().toLowerCase();
    const rows = state.hosts.filter((h) => !kw || h.key.toLowerCase().includes(kw));
    const list = $('hostList');
    list.innerHTML = '';
    const all = document.createElement('div');
    all.className = 'item' + (state.host === '' ? ' on' : '');
    all.innerHTML = `<span class="k">全部站点</span><span class="count">${state.hosts.reduce((n, h) => n + h.count, 0)}</span>`;
    all.onclick = () => { state.host = ''; renderHosts(); };
    list.appendChild(all);
    rows.slice(0, 300).forEach((h) => {
      const el = document.createElement('div');
      el.className = 'item' + (state.host === h.key ? ' on' : '');
      el.innerHTML = `<span class="k" title="${h.key}">${h.key}</span><span class="count">${h.count}</span>`;
      el.onclick = () => { state.host = h.key; renderHosts(); };
      list.appendChild(el);
    });
  }

  function renderPreview(plan) {
    const box = $('previewBox');
    const warns = $('warnings');
    warns.innerHTML = '';
    box.innerHTML = '';
    if (!plan || !plan.changes.length) {
      box.hidden = true;
      $('apply').disabled = true;
      $('footText').textContent = '没有匹配到需要改动的种子';
      return;
    }
    box.hidden = false;
    const head = document.createElement('div');
    head.className = 'prow';
    head.style.background = '#1a2330';
    head.innerHTML = `<span class="n">种子</span><span class="u">${
      plan.mode === 'remove' ? '将删除的 tracker' : '旧 → 新'
    }</span>`;
    box.appendChild(head);
    plan.changes.slice(0, 300).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'prow';
      const right = plan.mode === 'remove'
        ? c.oldUrls.join('<br>')
        : (c.oldUrls.length ? c.oldUrls.join('<br>') : '（追加）') + '<br><span class="ok">→ ' + c.newUrl + '</span>';
      row.innerHTML = `<span class="n" title="${c.name.replace(/"/g, '&quot;')}">${c.name}</span><span class="u">${right}</span>`;
      box.appendChild(row);
    });
    if (plan.changes.length > 300) {
      const more = document.createElement('div');
      more.className = 'prow';
      more.innerHTML = `<span class="n muted">… 另有 ${plan.changes.length - 300} 个种子</span><span class="u"></span>`;
      box.appendChild(more);
    }
    $('apply').disabled = false;
    $('footText').textContent = `将处理 ${plan.changes.length} 个种子`;
    if (state.host) {
      const w = document.createElement('div');
      w.className = 'warn';
      w.textContent = `已限定站点：${state.host}`;
      warns.appendChild(w);
    }
  }

  async function doRefresh() {
    $('stats').textContent = '加载中…';
    $('refresh').disabled = true;
    try {
      if (rpcVersion === null) {
        const info = await rpc('session-get', { fields: ['rpc-version', 'version'] });
        rpcVersion = info['rpc-version'];
      }
      await loadTorrents();
      loaded = true;
      setStats();
      renderHosts();
      renderPreview(null);
      $('footText').textContent = '改动前自动生成备份，可撤销';
    } catch (err) {
      $('stats').textContent = '加载失败：' + err.message;
    } finally {
      $('refresh').disabled = false;
    }
  }

  async function doApply() {
    const plan = state.plan;
    if (!plan || !plan.changes.length || state.running) return;
    if (!confirm(`确认对 ${plan.changes.length} 个种子执行「${mode}」？`)) return;

    const byId = new Map(state.torrents.map((t) => [t.id, t]));
    const backup = {
      createdAt: new Date().toISOString(),
      mode: plan.mode,
      old: plan.oldValue,
      new: plan.newValue,
      changes: plan.changes.map((c) => ({ torrentId: c.torrentId, hitIds: c.hitIds, oldUrls: c.oldUrls })),
    };
    state.backup = backup;
    state.running = true;
    $('progressWrap').hidden = false;
    $('errorLog').innerHTML = '';
    $('apply').disabled = true;

    const errors = [];
    for (let i = 0; i < plan.changes.length; i++) {
      const change = plan.changes[i];
      const torrent = byId.get(change.torrentId);
      if (!torrent) { errors.push(`#${change.torrentId} 已不存在`); continue; }
      const err = await applyChange(torrent, change, plan.mode, plan.newValue);
      if (err) errors.push(`${torrent.name.slice(0, 40)}：${err}`);
      const pct = Math.round(((i + 1) / plan.changes.length) * 100);
      $('progressBar').style.width = pct + '%';
      $('progressText').textContent = `${i + 1} / ${plan.changes.length}（${pct}%）`;
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    state.running = false;
    $('errorLog').textContent = errors.slice(0, 15).join('\n');
    $('footText').textContent = errors.length ? `完成，${errors.length} 个失败` : '全部完成';
    $('download').hidden = false;
    $('undo').hidden = true;
    await doRefresh();
    $('download').hidden = false;
    $('undo').hidden = false;
  }

  async function doUndo() {
    const backup = state.backup;
    if (!backup || state.running) return;
    if (!confirm(`把 ${backup.changes.length} 个种子恢复成备份里的 tracker？`)) return;
    state.running = true;
    $('progressWrap').hidden = false;
    const byId = new Map(state.torrents.map((t) => [t.id, t]));
    const errors = [];
    for (let i = 0; i < backup.changes.length; i++) {
      const c = backup.changes[i];
      const torrent = byId.get(c.torrentId);
      if (!torrent) continue;
      for (let n = 0; n < c.hitIds.length; n++) {
        const err = await applyChange(
          torrent,
          { hitIds: [c.hitIds[n]] },
          'replace',
          backup.mode === 'add' ? c.oldUrls[n] : c.oldUrls[n]
        );
        if (err) errors.push(`${torrent.name.slice(0, 30)}：${err}`);
      }
      $('progressBar').style.width = Math.round(((i + 1) / backup.changes.length) * 100) + '%';
      $('progressText').textContent = `${i + 1} / ${backup.changes.length}`;
    }
    state.running = false;
    $('errorLog').textContent = errors.slice(0, 10).join('\n');
    $('footText').textContent = errors.length ? `撤销完成，${errors.length} 个失败` : '已撤销';
    await doRefresh();
  }

  function downloadBackup() {
    if (!state.backup) return;
    const blob = new Blob([JSON.stringify(state.backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tracker-backup-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ---------------- 事件 ---------------- */
  $('fab').onclick = async () => {
    const panel = $('panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !loaded) await doRefresh();
  };
  $('close').onclick = () => { $('panel').hidden = true; };
  $('refresh').onclick = doRefresh;
  $('hostSearch').oninput = renderHosts;
  $('download').onclick = downloadBackup;
  $('undo').onclick = doUndo;
  $('apply').onclick = doApply;

  shadow.querySelectorAll('#modeRow button').forEach((btn) => {
    btn.onclick = () => {
      shadow.querySelectorAll('#modeRow button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      mode = btn.dataset.mode;
      $('oldValue').placeholder = mode === 'add'
        ? '追加模式不需要旧 tracker'
        : '旧 tracker：站点主机名或完整 URL';
    };
  });

  $('preview').onclick = () => {
    if (!loaded) return;
    const opts = {
      mode,
      match: $('match').value,
      oldValue: $('oldValue').value.trim(),
      newValue: $('newValue').value.trim(),
      nameFilter: $('nameFilter').value.trim(),
      host: state.host,
      limit: Number($('limit').value || 0),
    };
    if (mode !== 'add' && !opts.oldValue) return alert('请填写旧 tracker');
    if (mode !== 'remove' && !/^(https?|udp):\/\//.test(opts.newValue)) return alert('新 URL 必须以 http:// https:// udp:// 开头');
    state.plan = buildPlan(opts);
    renderPreview(state.plan);
  };

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      $('fab').click();
    }
  });

  // 仅测试用：设置 window.__TS_DEBUG = true 后可拿到内部状态
  if (window.__TS_DEBUG) {
    window.__ts = { state, buildPlan, rpc, normalizeTrackers };
  }
})();
