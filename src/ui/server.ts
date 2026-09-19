import http from 'http';
import fs from 'fs';
import path from 'path';
import { benchEmitter } from '../core/emitter.js';
import type { BenchEvent } from '../core/types.js';

export { emitBenchEvent } from '../core/emitter.js';
export type { BenchEvent };

// ─── UC1 Dashboard ───────────────────────────────────────────────────────────

const UC1_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Benchmark Live</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0D1117;--surface:#161B22;--surface2:#1C2128;--border:#30363D;--text:#E6EDF3;--muted:#8B949E;--teal:#02D1AD;--teal-dim:#0D2E2A;--amber:#F59E0B;--violet:#818CF8;--violet-dim:#1E1B4B;--green:#4ADE80;--red:#F87171;}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh;padding:32px 24px 48px}
.page{max-width:900px;margin:0 auto}
header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;gap:16px;flex-wrap:wrap}
.header-left .eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
h1{font-size:20px;font-weight:600;letter-spacing:-.02em}
.repo-tag{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-top:4px}
.status-pill{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;padding:5px 12px;border-radius:20px;display:flex;align-items:center;gap:6px;align-self:flex-start;margin-top:4px}
.status-pill.running{background:var(--violet-dim);color:var(--violet);border:1px solid var(--violet)}
.status-pill.done{background:var(--teal-dim);color:var(--teal);border:1px solid var(--teal)}
.status-pill.waiting{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.dot.pulse{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.tile-label{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:5px}
.tile-val{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile-val.teal{color:var(--teal)}.tile-val.amber{color:var(--amber)}.tile-val.neutral{color:var(--text)}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:500}
th.teal{color:var(--teal)} th.amber{color:var(--amber)}
tbody tr{border-bottom:1px solid var(--border);transition:background .2s}
tbody tr.active{background:var(--surface2)}
td{padding:10px 12px;vertical-align:middle}
.sha{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted)}
.msg{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.time-cell{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600}
.time-cell.teal{color:var(--teal)}.time-cell.amber{color:var(--amber)}
.badge{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;letter-spacing:.03em}
.badge.pass{background:#0D2E1A;color:var(--green)}.badge.fail{background:#2D0F0F;color:var(--red)}.badge.skip{background:var(--surface2);color:var(--muted)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--violet);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.speedup-col{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600}
.empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}
.conn{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-top:24px;text-align:center}
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="header-left">
      <div class="eyebrow">UC1 · Live Benchmark</div>
      <h1>Sidecar vs Traditional CI</h1>
      <div class="repo-tag" id="repo-tag">waiting for run…</div>
    </div>
    <div class="status-pill waiting" id="status-pill"><span class="dot"></span> <span id="status-text">Waiting</span></div>
  </header>
  <div class="tiles">
    <div class="tile"><div class="tile-label">Avg Sidecar</div><div class="tile-val teal" id="avg-sidecar">—</div></div>
    <div class="tile"><div class="tile-label">Avg Traditional</div><div class="tile-val amber" id="avg-trad">—</div></div>
    <div class="tile"><div class="tile-label">Speedup</div><div class="tile-val neutral" id="speedup">—</div></div>
    <div class="tile"><div class="tile-label">Progress</div><div class="tile-val neutral" id="progress">0 / ?</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>SHA</th><th>Message</th><th class="teal">Sidecar</th><th class="teal">Status</th><th class="amber">Traditional</th><th class="amber">Status</th><th>Speedup</th></tr></thead>
      <tbody id="tbody"><tr><td colspan="7" class="empty">Run the benchmark to see live results</td></tr></tbody>
    </table>
  </div>
  <div class="conn" id="conn">● connecting to localhost:4321…</div>
</div>
<script>
const fmtMs=ms=>{if(!ms&&ms!==0)return'—';if(ms<1000)return ms+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return Math.floor(ms/60000)+'m '+Math.round((ms%60000)/1000)+'s'};
const rows={};let total=0,done=0,sidecarTimes=[],tradTimes=[];
const tbody=document.getElementById('tbody'),pill=document.getElementById('status-pill'),statusText=document.getElementById('status-text'),conn=document.getElementById('conn');
function setStatus(s){pill.className='status-pill '+s;pill.querySelector('.dot').className='dot'+(s==='running'?' pulse':'')}
function updateTiles(){if(!sidecarTimes.length)return;const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;document.getElementById('avg-sidecar').textContent=fmtMs(Math.round(avg(sidecarTimes)));document.getElementById('avg-trad').textContent=fmtMs(Math.round(avg(tradTimes)));document.getElementById('speedup').textContent=(avg(tradTimes)/avg(sidecarTimes)).toFixed(1)+'×';document.getElementById('progress').textContent=done+' / '+(total||'?')}
function getOrCreateRow(sha){if(rows[sha])return rows[sha];if(tbody.querySelector('.empty'))tbody.innerHTML='';const tr=document.createElement('tr');tr.id='row-'+sha;tr.className='active';tr.innerHTML=\`<td class="sha">\${sha.slice(0,7)}</td><td class="msg" id="msg-\${sha}">…</td><td class="time-cell teal" id="sc-time-\${sha}"><span class="spinner"></span></td><td id="sc-status-\${sha}"></td><td class="time-cell amber" id="tr-time-\${sha}"><span class="spinner"></span></td><td id="tr-status-\${sha}"></td><td class="speedup-col" id="speedup-\${sha}">—</td>\`;tbody.appendChild(tr);rows[sha]=tr;return tr}
const es=new EventSource('/events');
es.onopen=()=>{conn.textContent='● connected';conn.style.color='var(--teal)'};
es.onerror=()=>{conn.textContent='● disconnected';conn.style.color='var(--red)'};
es.onmessage=e=>{
  const ev=JSON.parse(e.data);
  if(ev.type==='run:start'){total=ev.total;document.getElementById('repo-tag').textContent=ev.repo;document.getElementById('progress').textContent='0 / '+total;setStatus('running');statusText.textContent='Running'}
  if(ev.type==='commit:start'){getOrCreateRow(ev.sha);document.getElementById('msg-'+ev.sha).textContent=ev.message.slice(0,55)}
  if(ev.type==='commit:sidecar'){const c=document.getElementById('sc-time-'+ev.sha),b=document.getElementById('sc-status-'+ev.sha);if(c)c.textContent=fmtMs(ev.durationMs);if(b)b.innerHTML=\`<span class="badge \${ev.status==='pass'?'pass':'fail'}">\${ev.status}</span>\`;sidecarTimes.push(ev.durationMs);updateTiles()}
  if(ev.type==='commit:traditional'){const c=document.getElementById('tr-time-'+ev.sha),b=document.getElementById('tr-status-'+ev.sha);if(c)c.textContent=fmtMs(ev.durationMs);if(b)b.innerHTML=\`<span class="badge \${ev.status==='success'?'pass':'fail'}">\${ev.status}</span>\`;tradTimes.push(ev.durationMs);done++;const si=sidecarTimes[sidecarTimes.length-1],sp=document.getElementById('speedup-'+ev.sha);if(sp&&si)sp.textContent=(ev.durationMs/si).toFixed(1)+'×';const row=rows[ev.sha];if(row)row.classList.remove('active');updateTiles()}
  if(ev.type==='commit:skip'){const row=getOrCreateRow(ev.sha);row.innerHTML=\`<td class="sha">\${ev.sha.slice(0,7)}</td><td colspan="6"><span class="badge skip">skipped — \${ev.reason}</span></td>\`;row.classList.remove('active')}
  if(ev.type==='run:done'){setStatus('done');statusText.textContent='Done';document.getElementById('speedup').textContent=ev.speedupFactor.toFixed(1)+'×';document.getElementById('avg-sidecar').textContent=fmtMs(ev.avgSidecarMs);document.getElementById('avg-trad').textContent=fmtMs(ev.avgTraditionalMs)}
};
</script></body></html>`;

// ─── UC2 Control Panel ────────────────────────────────────────────────────────

const UC2_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UC2 · Skills Benchmark</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0D1117;--surface:#161B22;--surface2:#1C2128;--border:#30363D;
  --text:#E6EDF3;--muted:#8B949E;--muted2:#444D56;
  --teal:#02D1AD;--teal-dim:#0D2E2A;
  --violet:#818CF8;--violet-dim:#1E1B4B;
  --green:#4ADE80;--green-dim:#0D2E1A;
  --red:#F87171;--red-dim:#2D0F0F;
  --amber:#F59E0B;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--surface);gap:12px;flex-shrink:0}
.topbar-left{display:flex;align-items:center;gap:12px}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.topbar h1{font-size:16px;font-weight:600;letter-spacing:-.01em}
.status-pill{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;display:flex;align-items:center;gap:5px}
.status-pill.idle{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.status-pill.running{background:var(--violet-dim);color:var(--violet);border:1px solid var(--violet)}
.status-pill.done{background:var(--teal-dim);color:var(--teal);border:1px solid var(--teal)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dot.pulse{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

.layout{display:flex;flex:1;min-height:0;overflow:hidden}
.sidebar{width:260px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--surface)}
.sidebar-section{padding:16px;border-bottom:1px solid var(--border)}
.section-title{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.check-list{display:flex;flex-direction:column;gap:6px}
.check-item{display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:5px;transition:background .15s}
.check-item:hover{background:var(--surface2)}
.check-item input[type=checkbox]{accent-color:var(--violet);width:14px;height:14px;cursor:pointer;flex-shrink:0}
.check-item label{font-size:13px;cursor:pointer;line-height:1.3;flex:1}
.check-item .tag{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-left:auto}
.toggle-all{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--violet);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.toggle-all:hover{color:var(--teal)}

.switch-row{display:flex;align-items:center;justify-content:space-between;padding:4px 0}
.switch-row label{font-size:13px;color:var(--text)}
.switch{position:relative;width:34px;height:18px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--surface2);border:1px solid var(--border);border-radius:18px;cursor:pointer;transition:.2s}
.slider::before{content:'';position:absolute;width:12px;height:12px;background:var(--muted);border-radius:50%;left:2px;top:2px;transition:.2s}
input:checked+.slider{background:var(--violet-dim);border-color:var(--violet)}
input:checked+.slider::before{transform:translateX(16px);background:var(--violet)}

.run-btn{margin:16px;padding:10px;background:var(--violet);color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .2s;letter-spacing:-.01em}
.run-btn:hover:not(:disabled){opacity:.85}
.run-btn:disabled{background:var(--surface2);color:var(--muted);cursor:not-allowed}
.run-btn .spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface);padding:0 16px;gap:2px;flex-shrink:0;overflow-x:auto}
.tab{font-family:'JetBrains Mono',monospace;font-size:11px;padding:10px 14px;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--violet);border-bottom-color:var(--violet)}
.tab-empty{padding:12px 16px;color:var(--muted);font-size:13px}

.cases-area{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.cases-placeholder{display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;text-align:center;line-height:1.6}

.case-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.case-header{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;user-select:none}
.case-header:hover{background:var(--surface2)}
.case-id{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);flex:1;font-weight:500}
.case-status{font-family:'JetBrains Mono',monospace;font-size:11px;display:flex;align-items:center;gap:5px}
.case-status.idle{color:var(--muted2)}
.case-status.running{color:var(--violet)}
.case-status.pass{color:var(--green)}
.case-status.fail{color:var(--red)}
.case-chevron{font-size:10px;color:var(--muted);transition:transform .2s;margin-left:4px}
.case-card.expanded .case-chevron{transform:rotate(90deg)}

.case-body{display:none;border-top:1px solid var(--border);padding:0}
.case-card.expanded .case-body{display:block}

.prompt-row{padding:10px 14px;background:var(--surface2);display:flex;gap:8px;align-items:flex-start}
.role-badge{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:1px}
.role-badge.user{background:#1C2A1C;color:#6EE7B7}
.role-badge.assistant{background:var(--violet-dim);color:var(--violet)}
.prompt-text{font-size:13px;color:var(--muted);line-height:1.5}

.turn-block{border-top:1px solid var(--border);padding:10px 14px}
.turn-header{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.turn-header .turn-num{color:var(--violet);font-weight:600}
.turn-header .tok{color:var(--muted2)}
.tool-call{background:var(--surface2);border:1px solid var(--border);border-radius:5px;margin-bottom:6px;overflow:hidden}
.tool-call-header{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer}
.tool-call-header:hover{background:#1C2128}
.tool-name{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--amber);font-weight:600}
.tool-chevron{font-size:9px;color:var(--muted);margin-left:auto;transition:transform .2s}
.tool-call.open .tool-chevron{transform:rotate(90deg)}
.tool-detail{display:none;padding:8px 10px;border-top:1px solid var(--border)}
.tool-call.open .tool-detail{display:block}
.tool-detail pre{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-all;line-height:1.5;max-height:180px;overflow-y:auto}
.assistant-text{font-size:13px;color:var(--text);line-height:1.6;margin-top:6px;white-space:pre-wrap}
.turn-spinner{display:inline-block;width:11px;height:11px;border:2px solid var(--border);border-top-color:var(--violet);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}

.bottombar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;gap:12px;flex-wrap:wrap}
.result-info{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}
.save-btn{padding:7px 14px;background:var(--teal-dim);color:var(--teal);border:1px solid var(--teal);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:opacity .2s}
.save-btn:hover{opacity:.8}
.save-btn:disabled{opacity:.4;cursor:not-allowed}
.conn{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}

@media(max-width:700px){
  .layout{flex-direction:column}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border)}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <span class="eyebrow">UC2</span>
    <h1>Skills Benchmark</h1>
  </div>
  <div class="status-pill idle" id="status-pill">
    <span class="dot" id="status-dot"></span>
    <span id="status-text">Idle</span>
  </div>
</div>

<div class="layout">
  <!-- Sidebar: configuration -->
  <aside class="sidebar">

    <div class="sidebar-section">
      <div class="section-title">
        Use Cases
        <span class="toggle-all" id="toggle-cases">all</span>
      </div>
      <div class="check-list" id="cases-list">
        <div style="color:var(--muted);font-size:12px">Loading…</div>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="section-title">Tools</div>
      <div class="check-list">
        <label class="check-item">
          <input type="checkbox" name="tool" value="mcp-remote" checked>
          <label>MCP Hosted</label>
          <span class="tag">remote</span>
        </label>
        <label class="check-item">
          <input type="checkbox" name="tool" value="mcp-builtin" checked>
          <label>CircleCI CLI</label>
          <span class="tag">builtin</span>
        </label>
        <label class="check-item">
          <input type="checkbox" name="tool" value="all" checked>
          <label>All combined</label>
          <span class="tag">all</span>
        </label>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="section-title">Options</div>
      <div class="switch-row">
        <label for="with-skill">With CircleCI Skill</label>
        <label class="switch">
          <input type="checkbox" id="with-skill">
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <button class="run-btn" id="run-btn" disabled>
      <span id="run-btn-icon">▶</span>
      <span id="run-btn-label">Run Benchmark</span>
    </button>
  </aside>

  <!-- Main: results -->
  <div class="main">
    <div class="tabs" id="tabs">
      <div class="tab-empty">Configure and run the benchmark to see results</div>
    </div>
    <div class="cases-area" id="cases-area">
      <div class="cases-placeholder" id="placeholder">
        Select use cases and tools, then click <strong style="color:var(--violet)">Run Benchmark</strong>.
      </div>
    </div>
  </div>
</div>

<div class="bottombar">
  <span class="result-info" id="result-info"></span>
  <div style="display:flex;align-items:center;gap:12px">
    <button class="save-btn" id="save-btn" disabled>
      ↓ Save Results
    </button>
    <span class="conn" id="conn">● connecting…</span>
  </div>
</div>

<script>
const fmtMs = ms => {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
};
const fmtK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── State ──────────────────────────────────────────────────────────────────
let running = false;
let currentResultFile = null;
let activeTab = null;
// tabData[config] = { cases: { [caseId]: { turns:[], status, metrics } } }
const tabData = {};

// ── Suite loading ──────────────────────────────────────────────────────────
async function loadSuite() {
  try {
    const res = await fetch('/api/suite');
    const suite = await res.json();
    const list = document.getElementById('cases-list');
    list.innerHTML = '';
    for (const c of suite.cases) {
      const item = document.createElement('label');
      item.className = 'check-item';
      item.innerHTML = \`
        <input type="checkbox" name="case" value="\${c.id}" checked>
        <label title="\${esc(c.prompt)}">\${c.id.replace(/-/g,' ')}</label>
      \`;
      list.appendChild(item);
    }
    updateRunBtn();
  } catch(e) {
    document.getElementById('cases-list').innerHTML = '<div style="color:var(--red);font-size:12px">Failed to load suite</div>';
  }
}

// ── Toggle all ─────────────────────────────────────────────────────────────
document.getElementById('toggle-cases').addEventListener('click', () => {
  const boxes = document.querySelectorAll('input[name=case]');
  const anyUnchecked = Array.from(boxes).some(b => !b.checked);
  boxes.forEach(b => b.checked = anyUnchecked);
  updateRunBtn();
});
document.addEventListener('change', e => {
  if (e.target.name === 'case' || e.target.name === 'tool') updateRunBtn();
});

function updateRunBtn() {
  const cases = Array.from(document.querySelectorAll('input[name=case]:checked'));
  const tools = Array.from(document.querySelectorAll('input[name=tool]:checked'));
  const btn = document.getElementById('run-btn');
  btn.disabled = running || cases.length === 0 || tools.length === 0;
}

// ── Status pill ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const pill = document.getElementById('status-pill');
  const dot = document.getElementById('status-dot');
  pill.className = 'status-pill ' + state;
  dot.className = 'dot' + (state === 'running' ? ' pulse' : '');
  document.getElementById('status-text').textContent = text;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function buildTabs(configs) {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const cfg of configs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (cfg === activeTab ? ' active' : '');
    tab.textContent = cfg;
    tab.dataset.cfg = cfg;
    tab.addEventListener('click', () => switchTab(cfg));
    tabs.appendChild(tab);
  }
}

function switchTab(cfg) {
  activeTab = cfg;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.cfg === cfg));
  renderCases(cfg);
}

function renderCases(cfg) {
  const area = document.getElementById('cases-area');
  const placeholder = document.getElementById('placeholder');
  if (!tabData[cfg]) { area.innerHTML = ''; area.appendChild(placeholder); return; }
  area.innerHTML = '';
  for (const [caseId, data] of Object.entries(tabData[cfg].cases)) {
    area.appendChild(buildCaseCard(cfg, caseId, data));
  }
}

// ── Case cards ─────────────────────────────────────────────────────────────
function buildCaseCard(cfg, caseId, data) {
  const card = document.createElement('div');
  card.className = 'case-card' + (data.expanded ? ' expanded' : '');
  card.id = 'card-' + cfg + '-' + caseId;

  // status label
  let statusHtml = '<span class="turn-spinner"></span> running';
  if (data.status === 'idle') statusHtml = '—';
  else if (data.status === 'pass') statusHtml = \`✓ \${data.turns}t · \${fmtK(data.totalTokens)}tok · \${fmtMs(data.durationMs)}\`;
  else if (data.status === 'fail') statusHtml = \`✗ \${data.turns}t · \${fmtK(data.totalTokens)}tok\`;

  card.innerHTML = \`
    <div class="case-header">
      <span class="case-id">\${caseId}</span>
      <span class="case-status \${data.status}">\${statusHtml}</span>
      <span class="case-chevron">▶</span>
    </div>
    <div class="case-body" id="body-\${cfg}-\${caseId}"></div>
  \`;

  card.querySelector('.case-header').addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  // populate body
  if (data.prompt || data.turns?.length) {
    populateCaseBody(card.querySelector('.case-body'), data);
  }

  return card;
}

function populateCaseBody(body, data) {
  body.innerHTML = '';
  if (data.prompt) {
    body.innerHTML += \`<div class="prompt-row"><span class="role-badge user">user</span><span class="prompt-text">\${esc(data.prompt)}</span></div>\`;
  }
  for (const turn of (data.turns || [])) {
    const block = document.createElement('div');
    block.className = 'turn-block';
    let toolsHtml = '';
    for (const tc of (turn.toolCalls || [])) {
      const inputStr = JSON.stringify(tc.input, null, 2);
      toolsHtml += \`
        <div class="tool-call">
          <div class="tool-call-header" onclick="this.closest('.tool-call').classList.toggle('open')">
            <span class="tool-name">\${esc(tc.name)}</span>
            <span class="tool-chevron">▶</span>
          </div>
          <div class="tool-detail"><pre>\${esc(inputStr)}</pre></div>
        </div>\`;
    }
    const textHtml = turn.assistantText
      ? \`<div class="assistant-text">\${esc(turn.assistantText)}</div>\`
      : '';
    block.innerHTML = \`
      <div class="turn-header">
        <span class="turn-num">Turn \${turn.turn}</span>
        <span class="tok">\${fmtK(turn.inputTokens + turn.outputTokens)}tok</span>
      </div>
      \${toolsHtml}\${textHtml}\`;
    body.appendChild(block);
  }
  if (data.status === 'running') {
    const spin = document.createElement('div');
    spin.className = 'turn-block';
    spin.id = 'spin-' + data._cfg + '-' + data._caseId;
    spin.innerHTML = \`<div class="turn-header"><span class="turn-spinner"></span> <span class="tok" id="tok-\${data._cfg}-\${data._caseId}">waiting…</span></div>\`;
    body.appendChild(spin);
  }
}

// ── SSE event handling ─────────────────────────────────────────────────────
function getCaseData(cfg, caseId) {
  if (!tabData[cfg]) tabData[cfg] = { cases: {} };
  if (!tabData[cfg].cases[caseId]) {
    tabData[cfg].cases[caseId] = {
      _cfg: cfg, _caseId: caseId,
      status: 'idle', turns: [], prompt: null,
      expanded: false, turns_count: 0, totalTokens: 0, durationMs: 0,
    };
  }
  return tabData[cfg].cases[caseId];
}

function updateCard(cfg, caseId) {
  if (activeTab !== cfg) return;
  const area = document.getElementById('cases-area');
  const existing = document.getElementById('card-' + cfg + '-' + caseId);
  const data = getCaseData(cfg, caseId);
  const card = buildCaseCard(cfg, caseId, data);
  if (existing) area.replaceChild(card, existing);
  else area.appendChild(card);
}

const es = new EventSource('/events');
es.onopen = () => { const c = document.getElementById('conn'); c.textContent = '● connected'; c.style.color = 'var(--teal)'; };
es.onerror = () => { const c = document.getElementById('conn'); c.textContent = '● disconnected'; c.style.color = 'var(--red)'; };

es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (!ev.type?.startsWith('uc2:')) return;

  if (ev.type === 'uc2:run:start') {
    setStatus('running', 'Running');
    activeTab = ev.configs[0];
    for (const cfg of ev.configs) tabData[cfg] = { cases: {} };
    buildTabs(ev.configs);
    renderCases(activeTab);
  }

  if (ev.type === 'uc2:case:start') {
    const data = getCaseData(ev.config, ev.caseId);
    data.status = 'running';
    data.expanded = true;
    updateCard(ev.config, ev.caseId);
  }

  if (ev.type === 'uc2:case:turn') {
    const data = getCaseData(ev.config, ev.caseId);
    data.status = 'running';
    data.turns_count = ev.turn;
    data.totalTokens = ev.totalTokens;
    data.turns.push({
      turn: ev.turn,
      inputTokens: Math.round(ev.totalTokens * 0.8),
      outputTokens: Math.round(ev.totalTokens * 0.2),
      toolCalls: ev.toolCalls || [],
      assistantText: ev.assistantText || '',
    });
    updateCard(ev.config, ev.caseId);
  }

  if (ev.type === 'uc2:case:done') {
    const data = getCaseData(ev.config, ev.caseId);
    data.status = ev.success ? 'pass' : 'fail';
    data.turns_count = ev.turns;
    data.turns = data.turns; // already populated by turn events
    data.totalTokens = ev.totalTokens;
    data.durationMs = ev.durationMs;
    updateCard(ev.config, ev.caseId);
  }

  if (ev.type === 'uc2:run:done') {
    setStatus('done', 'Done');
    running = false;
    updateRunBtn();
    if (ev.resultFile) {
      currentResultFile = ev.resultFile;
      const fn = ev.resultFile.split('/').pop();
      document.getElementById('result-info').textContent = fn;
      document.getElementById('save-btn').disabled = false;
    }
  }
};

// ── Run ────────────────────────────────────────────────────────────────────
document.getElementById('run-btn').addEventListener('click', async () => {
  const cases = Array.from(document.querySelectorAll('input[name=case]:checked')).map(b => b.value);
  const tools = Array.from(document.querySelectorAll('input[name=tool]:checked')).map(b => b.value);
  const withSkill = document.getElementById('with-skill').checked;

  if (!cases.length || !tools.length) return;

  running = true;
  currentResultFile = null;
  document.getElementById('save-btn').disabled = true;
  document.getElementById('result-info').textContent = '';
  document.getElementById('tabs').innerHTML = '<div class="tab-empty">Starting…</div>';
  document.getElementById('cases-area').innerHTML = '';
  updateRunBtn();

  document.getElementById('run-btn-icon').innerHTML = '<span class="spinner"></span>';
  document.getElementById('run-btn-label').textContent = 'Running…';

  try {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cases, tools, withSkill }),
    });
  } catch(e) {
    setStatus('idle', 'Error');
    running = false;
    document.getElementById('run-btn-icon').textContent = '▶';
    document.getElementById('run-btn-label').textContent = 'Run Benchmark';
    updateRunBtn();
  }
});

// ── Save ───────────────────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', () => {
  if (!currentResultFile) return;
  const fn = currentResultFile.split('/').pop();
  window.open('/api/results/' + encodeURIComponent(fn), '_blank');
});

// ── Init ───────────────────────────────────────────────────────────────────
loadSuite();
</script>
</body>
</html>`;

// ─── Server ───────────────────────────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

export function startUIServer(port = 4321): () => void {
  const clients = new Set<http.ServerResponse>();
  let suiteCache: unknown = null;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    // SSE
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Suite data
    if (url === '/api/suite') {
      if (!suiteCache) {
        try {
          const p = path.resolve('suites/circleci-uc2.json');
          suiteCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Could not load suite' }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(suiteCache));
      return;
    }

    // Trigger run
    if (url === '/api/run' && req.method === 'POST') {
      const body = await parseBody(req) as { cases?: string[]; tools?: string[]; withSkill?: boolean };
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'started' }));

      // Kick off asynchronously — import lazily to avoid circular dep at module load time
      setImmediate(async () => {
        try {
          const { runSkillsBenchmark } = await import('../benchmarks/skills/runner.js');
          const { loadJSON } = await import('../core/storage.js');
          const suite = loadJSON<import('../core/types.js').PromptSuite>('suites/circleci-uc2.json');
          const circleciToken = process.env.CIRCLECI_TOKEN ?? '';
          const toolConfigs = (body.tools ?? ['mcp-remote', 'mcp-builtin', 'all'])
            .map((t) => [t as import('../core/types.js').ToolConfig]);
          await runSkillsBenchmark({
            suite,
            toolConfigs,
            circleciToken,
            withSkill: body.withSkill ?? false,
            casesFilter: body.cases,
            outDir: 'results',
          });
        } catch (err) {
          console.error('Run error:', err);
        }
      });
      return;
    }

    // Download results
    if (url.startsWith('/api/results/')) {
      const filename = decodeURIComponent(url.slice('/api/results/'.length));
      const filePath = path.resolve('results', path.basename(filename));
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Pages
    if (url === '/uc2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(UC2_HTML);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(UC1_HTML);
  });

  const emit = (event: BenchEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(data);
  };
  benchEmitter.on('event', emit);

  server.listen(port, () => {
    console.log(`\nLive dashboards → http://localhost:${port} (UC1) | http://localhost:${port}/uc2 (UC2)\n`);
  });

  return () => {
    benchEmitter.off('event', emit);
    server.close();
  };
}
