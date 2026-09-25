import http from 'http';
import fs from 'fs';
import path from 'path';
import { benchEmitter } from '../core/emitter.js';
import { loadConfig, loadSuite, activeModels } from '../core/config.js';
import { ALL_CONDITIONS } from '../core/types.js';
import type { BenchConfig, BenchEvent, Condition, ModelConfig, UseCase, UseCaseSuite } from '../core/types.js';

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

// ─── UC2 Use-Cases Dashboard ──────────────────────────────────────────────────
// NOTE: client code below avoids backticks, "${" and backslashes so it can live inside this template literal.

const UC2_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UC2 · Use-Cases Benchmark</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0D1117;--surface:#161B22;--surface2:#1C2128;--border:#30363D;
  --text:#E6EDF3;--muted:#8B949E;--muted2:#6E7681;
  --teal:#02D1AD;--teal-dim:#0D2E2A;
  --violet:#818CF8;--violet-dim:#1E1B4B;
  --green:#4ADE80;--green-dim:#0D2E1A;
  --red:#F87171;--red-dim:#2D0F0F;
  --amber:#F59E0B;--amber-dim:#2B2006;
  --user-bg:#1C2A1C;--user-fg:#6EE7B7;
}
@media (prefers-color-scheme: light){:root{
  --bg:#F6F8FA;--surface:#FFFFFF;--surface2:#F0F2F5;--border:#D0D7DE;
  --text:#1F2328;--muted:#59636E;--muted2:#8C959F;
  --teal:#0A8F78;--teal-dim:#D7F5EE;
  --violet:#5B5BD6;--violet-dim:#E8E8FC;
  --green:#1A7F37;--green-dim:#DAFBE1;
  --red:#CF222E;--red-dim:#FFEBE9;
  --amber:#9A6700;--amber-dim:#FFF8C5;
  --user-bg:#DAFBE1;--user-fg:#1A7F37;
}}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;display:flex;flex-direction:column}
.mono{font-family:'JetBrains Mono',monospace}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--surface);gap:12px;flex-shrink:0;flex-wrap:wrap}
.topbar-left{display:flex;align-items:center;gap:12px}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.topbar h1{font-size:16px;font-weight:600;letter-spacing:-.01em}
.topbar-right{display:flex;align-items:center;gap:12px}
.status-pill{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;display:flex;align-items:center;gap:5px}
.status-pill.idle{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.status-pill.running{background:var(--violet-dim);color:var(--violet);border:1px solid var(--violet)}
.status-pill.done{background:var(--teal-dim);color:var(--teal);border:1px solid var(--teal)}
.status-pill.failed{background:var(--red-dim);color:var(--red);border:1px solid var(--red)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dot.pulse{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.conn{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}

.layout{display:flex;flex:1;min-height:0;overflow:hidden}
.sidebar{width:280px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--surface)}
.sidebar-section{padding:16px;border-bottom:1px solid var(--border)}
.section-title{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.check-list{display:flex;flex-direction:column;gap:4px}
.check-item{display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:5px;transition:background .15s;min-width:0}
.check-item:hover{background:var(--surface2)}
.check-item input[type=checkbox]{accent-color:var(--violet);width:14px;height:14px;cursor:pointer;flex-shrink:0}
.check-item .lbl{font-size:13px;line-height:1.3;flex:1;min-width:0;overflow-wrap:anywhere}
.check-item .sub{display:block;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}
.tag{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-left:auto;flex-shrink:0}
.tag.off{color:var(--amber);border:1px solid var(--amber);border-radius:4px;padding:0 4px}
.toggle-all{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--violet);cursor:pointer;text-decoration:underline;text-underline-offset:2px;background:none;border:none}
.toggle-all:hover{color:var(--teal)}
.num-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.num-row input{width:72px;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px}
.hint{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.4}

.run-btn{margin:16px;padding:10px;background:var(--violet);color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .2s;letter-spacing:-.01em}
.run-btn:hover:not(:disabled){opacity:.85}
.run-btn:disabled{background:var(--surface2);color:var(--muted);cursor:not-allowed}
.spinner{display:inline-block;width:11px;height:11px;border:2px solid var(--border);border-top-color:var(--violet);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.run-msg{margin:0 16px 16px;font-size:12px;color:var(--red);line-height:1.4;overflow-wrap:anywhere}

.main{flex:1;min-width:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;min-width:0}
.panel-title{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.hidden{display:none!important}
.placeholder{color:var(--muted);font-size:13px;text-align:center;padding:40px 12px;line-height:1.6}

.pf-row{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:4px 0;border-top:1px solid var(--border);font-size:12px}
.pf-row:first-child{border-top:none}
.pf-ok{color:var(--green);font-weight:600}
.pf-bad{color:var(--red);font-weight:600}
.pf-name{overflow-wrap:anywhere}
.pf-name b{font-weight:500}
.pf-detail{display:block;color:var(--muted);font-size:11px;font-family:'JetBrains Mono',monospace;overflow-wrap:anywhere;white-space:pre-wrap}
.pf-ms{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}

.progress-meta{display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:6px;gap:8px;flex-wrap:wrap}
.bar{height:8px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;overflow:hidden}
.bar-fill{height:100%;width:0;background:var(--violet);transition:width .3s}
.bar-fill.done{background:var(--teal)}

.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:12px}
th{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:500;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
td.rowhead{font-family:'JetBrains Mono',monospace;font-size:12px;white-space:nowrap}
td.num{font-family:'JetBrains Mono',monospace;text-align:right;white-space:nowrap}
.cell{cursor:pointer;border-radius:6px;padding:6px 8px;border:1px solid var(--border);background:var(--surface2);min-width:120px;transition:border-color .15s}
.cell:hover{border-color:var(--violet)}
.cell.sel{border-color:var(--violet);box-shadow:0 0 0 1px var(--violet)}
.cell .score{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600}
.cell .score small{font-size:10px;color:var(--muted);font-weight:400}
.cell .counts{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;margin-top:3px}
.c-run{color:var(--violet)}.c-ok{color:var(--green)}.c-err{color:var(--red)}.c-skip{color:var(--amber)}

.filter-bar{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sessions{display:flex;flex-direction:column;gap:6px}
.case-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;min-width:0}
.case-header{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;user-select:none;flex-wrap:wrap}
.case-header:hover{background:var(--surface2)}
.case-id{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);flex:1;font-weight:500;min-width:0;overflow-wrap:anywhere}
.case-id .sep{color:var(--muted2)}
.case-meta{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)}
.badge{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.badge.running{background:var(--violet-dim);color:var(--violet)}
.badge.completed{background:var(--green-dim);color:var(--green)}
.badge.fail{background:var(--amber-dim);color:var(--amber)}
.badge.error,.badge.judge_error{background:var(--red-dim);color:var(--red)}
.badge.skipped{background:var(--amber-dim);color:var(--amber)}
.case-chevron{font-size:10px;color:var(--muted);transition:transform .2s}
.case-card.open .case-chevron{transform:rotate(90deg)}
.case-body{border-top:1px solid var(--border)}

.prompt-row{padding:10px 14px;background:var(--surface2);display:flex;gap:8px;align-items:flex-start}
.role-badge{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:1px}
.role-badge.user{background:var(--user-bg);color:var(--user-fg)}
.role-badge.assistant{background:var(--violet-dim);color:var(--violet)}
.prompt-text{font-size:13px;color:var(--muted);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}

.turn-block{border-top:1px solid var(--border);padding:10px 14px;min-width:0}
.turn-header{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.turn-header .turn-num{color:var(--violet);font-weight:600}
details.reasoning{margin-bottom:6px}
details.reasoning summary{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);cursor:pointer}
details.reasoning pre{margin-top:6px}
.tool-call{background:var(--surface2);border:1px solid var(--border);border-radius:5px;margin-bottom:6px;overflow:hidden}
.tool-call summary{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;list-style:none;flex-wrap:wrap}
.tool-call summary::-webkit-details-marker{display:none}
.tool-call.err{border-color:var(--red)}
.tool-name{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--amber);font-weight:600;overflow-wrap:anywhere}
.tool-args{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.err-flag{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:var(--red)}
.tool-detail{padding:8px 10px;border-top:1px solid var(--border)}
.tool-detail .lab{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted);margin:4px 0}
pre{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:260px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px}
.assistant-text{font-size:13px;color:var(--text);line-height:1.6;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.pending{border-top:1px solid var(--border);padding:10px 14px;font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:center}
.result{border-top:1px solid var(--border);padding:10px 14px;background:var(--surface2)}
.kv{display:flex;flex-wrap:wrap;gap:6px 16px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:6px}
.kv b{color:var(--text);font-weight:600}
.err-box{color:var(--red);font-size:12px;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.judge{font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:var(--violet)}
.report-link{font-weight:600}

@media(max-width:760px){
  body{height:auto;min-height:100%}
  .topbar{padding:12px 16px}
  .layout{flex-direction:column;overflow:visible}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border);overflow:visible}
  .main{overflow:visible;padding:12px 16px}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <span class="eyebrow">UC2</span>
    <h1>Use-Cases Benchmark</h1>
  </div>
  <div class="topbar-right">
    <span class="conn" id="conn">● connecting…</span>
    <div class="status-pill idle" id="status-pill">
      <span class="dot" id="status-dot"></span>
      <span id="status-text">Idle</span>
    </div>
  </div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-section">
      <div class="section-title">Models <button class="toggle-all" id="toggle-models">all</button></div>
      <div class="check-list" id="models-list"><div class="hint">Loading…</div></div>
    </div>
    <div class="sidebar-section">
      <div class="section-title">Conditions</div>
      <div class="check-list" id="conds-list"><div class="hint">Loading…</div></div>
    </div>
    <div class="sidebar-section">
      <div class="section-title">Use cases <button class="toggle-all" id="toggle-cases">all</button></div>
      <div class="check-list" id="cases-list"><div class="hint">Loading…</div></div>
    </div>
    <div class="sidebar-section">
      <div class="num-row"><label for="reps">Repetitions</label><input type="number" id="reps" min="1" max="50" value="1"></div>
      <div class="hint" id="matrix-hint"></div>
    </div>
    <button class="run-btn" id="run-btn" disabled><span id="run-btn-icon">▶</span><span id="run-btn-label">Run Benchmark</span></button>
    <div class="run-msg hidden" id="run-msg"></div>
  </aside>

  <main class="main" id="main">
    <div class="panel hidden" id="preflight-panel">
      <div class="panel-title"><span>Preflight</span><span id="preflight-sum"></span></div>
      <div id="preflight-rows"></div>
    </div>

    <div class="panel hidden" id="done-panel">
      <div class="panel-title"><span>Run complete</span><a class="report-link" id="report-link" target="_blank" rel="noopener">Open report ↗</a></div>
      <div class="table-wrap"><table id="summary-table"></table></div>
    </div>

    <div class="panel hidden" id="progress-panel">
      <div class="progress-meta"><span id="progress-label">0 / 0 sessions</span><span id="progress-run"></span></div>
      <div class="bar"><div class="bar-fill" id="bar-fill"></div></div>
    </div>

    <div class="panel hidden" id="matrix-panel">
      <div class="panel-title"><span>Model × condition</span><span>click a cell to filter</span></div>
      <div class="table-wrap"><table id="matrix"></table></div>
    </div>

    <div class="filter-bar hidden" id="filter-bar"><span id="filter-label"></span><button class="toggle-all" id="filter-clear">clear filter</button></div>
    <div class="sessions" id="sessions"></div>

    <div class="placeholder" id="placeholder">Pick models, conditions and use cases, then click <strong style="color:var(--violet)">Run Benchmark</strong>.<br>Runs started from the CLI also stream here.</div>
  </main>
</div>

<script>
(function(){
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtMs(ms){ if (ms == null || isNaN(ms)) return '—'; ms = Math.round(ms); if (ms < 1000) return ms + 'ms'; if (ms < 60000) return (ms/1000).toFixed(1) + 's'; return Math.floor(ms/60000) + 'm ' + Math.round((ms % 60000)/1000) + 's'; }
function fmtK(n){ if (n == null || isNaN(n)) return '—'; n = Math.round(n); return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n); }
function fmtCost(n){ return n == null ? '—' : '$' + Number(n).toFixed(n < 0.01 ? 4 : 3); }
function fmtPct(n){ return n == null ? '—' : Math.round(n * 100) + '%'; }
function fmtScore(n){ return n == null ? '—' : Number(n).toFixed(2); }
function keyStr(k){ return k.model + '|' + k.condition + '|' + k.caseId + '|' + k.rep; }
function json(v){ try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
var PREVIEW = 1500;

var S = { cfg: null, suite: null, caseById: {}, phase: 'idle', startedHere: false,
  sessions: {}, order: [], models: [], conds: [], total: 0, filter: null, runDirName: null };

// ── status ──
function setStatus(state, text){
  $('status-pill').className = 'status-pill ' + state;
  $('status-dot').className = 'dot' + (state === 'running' ? ' pulse' : '');
  $('status-text').textContent = text;
}
function setPhase(p, text){
  S.phase = p;
  var pill = p === 'starting' || p === 'preflight' || p === 'running' ? 'running' : p;
  setStatus(pill, text);
  updateRunBtn();
}
function showMsg(t){ var m = $('run-msg'); if (!t) { m.classList.add('hidden'); m.textContent = ''; } else { m.classList.remove('hidden'); m.textContent = t; } }

// ── sidebar ──
function checked(name){ return Array.prototype.map.call(document.querySelectorAll('input[name=' + name + ']:checked'), function(i){ return i.value; }); }
function busy(){ return S.phase === 'starting' || S.phase === 'preflight' || S.phase === 'running'; }
function updateRunBtn(){
  var m = checked('model').length, c = checked('cond').length, k = checked('case').length, r = parseInt($('reps').value, 10) || 0;
  $('matrix-hint').textContent = m + ' models × ' + c + ' conditions × ' + k + ' cases × ' + r + ' reps = ' + (m*c*k*r) + ' sessions';
  var b = $('run-btn');
  b.disabled = busy() || !m || !c || !k || r < 1;
  $('run-btn-icon').innerHTML = busy() ? '<span class="spinner"></span>' : '▶';
  $('run-btn-label').textContent = busy() ? 'Running…' : 'Run Benchmark';
}
function checkItem(name, value, label, sub, tag, tagClass, isChecked){
  return '<label class="check-item"><input type="checkbox" name="' + name + '" value="' + esc(value) + '"' + (isChecked ? ' checked' : '') + '>' +
    '<span class="lbl">' + esc(label) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</span>' +
    (tag ? '<span class="tag ' + (tagClass || '') + '">' + esc(tag) + '</span>' : '') + '</label>';
}
function toggleAll(name){
  var boxes = document.querySelectorAll('input[name=' + name + ']');
  var allOn = Array.prototype.every.call(boxes, function(b){ return b.checked; });
  Array.prototype.forEach.call(boxes, function(b){ b.checked = !allOn; });
  updateRunBtn();
}
async function loadSidebar(){
  try {
    var r = await Promise.all([fetch('/api/config'), fetch('/api/suite')]);
    var cfg = await r[0].json(), suite = await r[1].json();
    if (!r[0].ok) throw new Error('config: ' + (cfg.error || r[0].status));
    if (!r[1].ok) throw new Error('suite: ' + (suite.error || r[1].status));
    S.cfg = cfg; S.suite = suite;
    suite.cases.forEach(function(c){ S.caseById[c.id] = c; });
    $('models-list').innerHTML = cfg.models.map(function(m){
      return checkItem('model', m.id, m.id, m.provider + ' · ' + m.model, m.enabled ? '' : 'disabled', 'off', m.enabled);
    }).join('');
    $('conds-list').innerHTML = cfg.allConditions.map(function(c){
      return checkItem('cond', c, c, '', c.indexOf('mcp') === 0 ? 'hosted MCP' : 'CLI', '', cfg.conditions.indexOf(c) >= 0);
    }).join('');
    $('cases-list').innerHTML = suite.cases.map(function(c){
      return checkItem('case', c.id, c.id, (c.tags || []).join(', '), '', '', true);
    }).join('');
    $('reps').value = cfg.repetitions || 1;
    updateRunBtn();
  } catch (e) {
    showMsg('Could not load config/suite: ' + e.message);
  }
}
document.addEventListener('change', function(e){ if (e.target && e.target.matches && e.target.matches('.sidebar input')) updateRunBtn(); });
$('reps').addEventListener('input', updateRunBtn);
$('toggle-models').addEventListener('click', function(){ toggleAll('model'); });
$('toggle-cases').addEventListener('click', function(){ toggleAll('case'); });

$('run-btn').addEventListener('click', async function(){
  var body = { models: checked('model'), conditions: checked('cond'), cases: checked('case'), reps: parseInt($('reps').value, 10) };
  showMsg('');
  resetRun();
  S.startedHere = true;
  setPhase('starting', 'Starting…');
  try {
    var res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = await res.json().catch(function(){ return {}; });
    if (res.status !== 202) { S.startedHere = false; setPhase('idle', 'Idle'); showMsg(data.error || ('Request failed (' + res.status + ')')); return; }
    setPhase('preflight', 'Preflight…');
    pollStatus();
  } catch (e) { S.startedHere = false; setPhase('idle', 'Idle'); showMsg('Request failed: ' + e.message); }
});

// If this page started the run, poll so a crash that emits no event still ends the "running" state.
function pollStatus(){
  setTimeout(async function(){
    if (!S.startedHere || !busy()) return;
    try {
      var st = await (await fetch('/api/status')).json();
      if (!st.running && busy()) {
        S.startedHere = false;
        setPhase('failed', st.lastError === 'Preflight failed' ? 'Preflight failed' : 'Run failed');
        if (st.lastError) showMsg(st.lastError);
        return;
      }
    } catch (e) {}
    pollStatus();
  }, 4000);
}

// ── run state ──
function resetRun(){
  S.sessions = {}; S.order = []; S.models = []; S.conds = []; S.total = 0; S.filter = null; S.runDirName = null;
  $('sessions').innerHTML = ''; $('matrix').innerHTML = ''; $('preflight-rows').innerHTML = ''; $('summary-table').innerHTML = '';
  ['preflight-panel','done-panel','progress-panel','matrix-panel','filter-bar'].forEach(function(id){ $(id).classList.add('hidden'); });
  $('placeholder').classList.remove('hidden');
  renderProgress();
}
function freshIfFinished(){ if (S.phase === 'done' || S.phase === 'failed' || S.phase === 'idle') { if (S.order.length || S.total) resetRun(); } }
function addDim(model, cond){
  var changed = false;
  if (S.models.indexOf(model) < 0) { S.models.push(model); changed = true; }
  if (S.conds.indexOf(cond) < 0) { S.conds.push(cond); changed = true; }
  return changed;
}

// ── preflight ──
function renderPreflight(checks){
  $('preflight-panel').classList.remove('hidden');
  var bad = checks.filter(function(c){ return !c.ok; }).length;
  $('preflight-sum').innerHTML = bad ? '<span class="pf-bad">' + bad + ' failed</span>' : '<span class="pf-ok">all ' + checks.length + ' passed</span>';
  var sorted = checks.slice().sort(function(a, b){ return (a.ok === b.ok) ? 0 : (a.ok ? 1 : -1); });
  $('preflight-rows').innerHTML = sorted.map(function(c){
    return '<div class="pf-row"><span class="' + (c.ok ? 'pf-ok' : 'pf-bad') + '">' + (c.ok ? '✓' : '✗') + '</span>' +
      '<span class="pf-name"><b>' + esc(c.name) + '</b> <span class="mono" style="color:var(--muted);font-size:11px">' + esc(c.target) + '</span>' +
      (c.detail ? '<span class="pf-detail">' + esc(c.detail) + '</span>' : '') + '</span>' +
      '<span class="pf-ms">' + fmtMs(c.durationMs) + '</span></div>';
  }).join('');
  return bad === 0;
}

// ── progress + matrix ──
function doneCount(){ var n = 0; S.order.forEach(function(k){ if (S.sessions[k].record) n++; }); return n; }
function renderProgress(){
  var d = doneCount(), t = Math.max(S.total, S.order.length);
  $('progress-label').textContent = d + ' / ' + t + ' sessions';
  var running = 0; S.order.forEach(function(k){ if (!S.sessions[k].record) running++; });
  $('progress-run').textContent = running ? running + ' running' : '';
  var f = $('bar-fill');
  f.style.width = (t ? Math.min(100, d / t * 100) : 0) + '%';
  f.className = 'bar-fill' + (S.phase === 'done' ? ' done' : '');
}
function renderMatrix(){
  if (!S.models.length) return;
  $('matrix-panel').classList.remove('hidden');
  var stats = {};
  S.order.forEach(function(k){
    var s = S.sessions[k], ck = s.key.model + '|' + s.key.condition;
    var st = stats[ck] || (stats[ck] = { running: 0, completed: 0, error: 0, skipped: 0, sum: 0, n: 0 });
    if (!s.record) st.running++;
    else if (s.record.status === 'completed') st.completed++;
    else if (s.record.status === 'skipped') st.skipped++;
    else st.error++;
    if (s.record && s.record.score != null) { st.sum += s.record.score; st.n++; }
  });
  var h = '<tr><th>model</th>' + S.conds.map(function(c){ return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';
  S.models.forEach(function(m){
    h += '<tr><td class="rowhead">' + esc(m) + '</td>';
    S.conds.forEach(function(c){
      var st = stats[m + '|' + c];
      var sel = S.filter && S.filter.model === m && S.filter.condition === c;
      if (!st) { h += '<td><div class="cell' + (sel ? ' sel' : '') + '" data-m="' + esc(m) + '" data-c="' + esc(c) + '"><div class="score">—</div><div class="counts">no sessions yet</div></div></td>'; return; }
      h += '<td><div class="cell' + (sel ? ' sel' : '') + '" data-m="' + esc(m) + '" data-c="' + esc(c) + '" title="running / completed / error / skipped">' +
        '<div class="score">' + (st.n ? (st.sum / st.n).toFixed(2) : '—') + '<small> /5 mean</small></div>' +
        '<div class="counts">' + (st.running ? '<span class="c-run">' + st.running + ' run</span>' : '') +
        '<span class="c-ok">' + st.completed + ' ok</span>' +
        (st.error ? '<span class="c-err">' + st.error + ' err</span>' : '') +
        (st.skipped ? '<span class="c-skip">' + st.skipped + ' skip</span>' : '') + '</div></div></td>';
    });
    h += '</tr>';
  });
  $('matrix').innerHTML = h;
}
$('matrix').addEventListener('click', function(e){
  var cell = e.target.closest ? e.target.closest('.cell') : null;
  if (!cell) return;
  var m = cell.getAttribute('data-m'), c = cell.getAttribute('data-c');
  S.filter = (S.filter && S.filter.model === m && S.filter.condition === c) ? null : { model: m, condition: c };
  applyFilter(); renderMatrix();
});
$('filter-clear').addEventListener('click', function(){ S.filter = null; applyFilter(); renderMatrix(); });
function visible(s){ return !S.filter || (s.key.model === S.filter.model && s.key.condition === S.filter.condition); }
function applyFilter(){
  S.order.forEach(function(k){ var s = S.sessions[k]; s.el.style.display = visible(s) ? '' : 'none'; });
  if (S.filter) { $('filter-bar').classList.remove('hidden'); $('filter-label').textContent = 'Showing ' + S.filter.model + ' · ' + S.filter.condition; }
  else $('filter-bar').classList.add('hidden');
}

// ── session cards ──
function getSession(k){
  var key = { model: k.model, condition: k.condition, caseId: k.caseId, rep: k.rep };
  var ks = keyStr(key);
  var s = S.sessions[ks];
  if (s) return s;
  s = { key: key, ks: ks, turns: [], record: null, open: false, el: null, tokens: 0 };
  S.sessions[ks] = s; S.order.push(ks);
  $('placeholder').classList.add('hidden');
  $('progress-panel').classList.remove('hidden');
  addDim(key.model, key.condition);
  var el = document.createElement('div');
  el.className = 'case-card';
  el.innerHTML = '<div class="case-header"><span class="case-id">' + esc(key.model) + ' <span class="sep">·</span> ' + esc(key.condition) +
    ' <span class="sep">·</span> ' + esc(key.caseId) + ' <span class="sep">·</span> r' + esc(key.rep) + '</span>' +
    '<span class="case-meta"></span><span class="hstatus"></span><span class="case-chevron">▶</span></div><div class="case-body hidden"></div>';
  el.querySelector('.case-header').addEventListener('click', function(){ toggleCard(s); });
  s.el = el;
  if (!visible(s)) el.style.display = 'none';
  $('sessions').appendChild(el);
  updateHeader(s);
  return s;
}
function statusBadge(s){
  var r = s.record;
  if (!r) return '<span class="badge running"><span class="spinner"></span>running</span>';
  if (r.status === 'completed') {
    var cls = r.pass === false ? 'fail' : 'completed';
    return '<span class="badge ' + cls + '">' + (r.pass === false ? '✗ ' : '✓ ') + (r.score != null ? esc(r.score) + '/5' : 'done') + '</span>';
  }
  return '<span class="badge ' + esc(r.status) + '">' + esc(r.status.replace('_', ' ')) + (r.error ? ' · ' + esc(r.error.kind) : '') + '</span>';
}
function updateHeader(s){
  var turns = s.record ? s.record.turns : s.turns.length;
  var tok = s.record ? (s.record.usage.input + s.record.usage.output) : s.tokens;
  var dur = s.record ? ' · ' + fmtMs(s.record.durationMs) : '';
  s.el.querySelector('.case-meta').textContent = turns + ' turn' + (turns === 1 ? '' : 's') + ' · ' + fmtK(tok) + ' tok' + dur;
  s.el.querySelector('.hstatus').innerHTML = statusBadge(s);
}
function toggleCard(s){
  s.open = !s.open;
  s.el.classList.toggle('open', s.open);
  var body = s.el.querySelector('.case-body');
  if (s.open) { body.classList.remove('hidden'); renderBody(s); }
  else { body.classList.add('hidden'); body.innerHTML = ''; }
}
function toolHTML(tc){
  var inputStr = json(tc.input);
  var argsShort = tc.input && tc.input.args && tc.input.args.join ? tc.input.args.join(' ') : inputStr.replace(/ +/g, ' ');
  var out = String(tc.output == null ? '' : tc.output);
  var preview = out.length > PREVIEW ? out.slice(0, PREVIEW) : out;
  var note = [];
  if (out.length > PREVIEW) note.push('showing first ' + PREVIEW + ' of ' + out.length + ' chars');
  if (tc.outputBytes != null) note.push(fmtK(tc.outputBytes) + ' bytes total');
  if (tc.truncated) note.push('full output in ' + (tc.blobPath || 'blob file'));
  if (tc.exitCode != null) note.push('exit ' + tc.exitCode);
  return '<details class="tool-call' + (tc.isError ? ' err' : '') + '"><summary><span class="tool-name">' + esc(tc.name) + '</span>' +
    '<span class="tool-args">' + esc(argsShort.slice(0, 200)) + '</span>' +
    (tc.isError ? '<span class="err-flag">ERROR</span>' : '') +
    '<span class="case-meta">' + fmtMs(tc.durationMs) + '</span></summary>' +
    '<div class="tool-detail"><div class="lab">input</div><pre>' + esc(inputStr) + '</pre>' +
    '<div class="lab">output' + (note.length ? ' (' + esc(note.join(' · ')) + ')' : '') + '</div><pre>' + esc(preview || '(empty)') + '</pre></div></details>';
}
function turnHTML(t){
  var u = t.usage || {};
  var h = '<div class="turn-block"><div class="turn-header"><span class="turn-num">Turn ' + esc(t.turn) + '</span>' +
    '<span>' + fmtMs(t.durationMs) + '</span><span>' + fmtK(u.input) + ' in / ' + fmtK(u.output) + ' out</span>' +
    (u.cacheRead ? '<span>' + fmtK(u.cacheRead) + ' cached</span>' : '') +
    (t.finishReason ? '<span>' + esc(t.finishReason) + '</span>' : '') +
    (t.retries ? '<span class="c-skip">' + esc(t.retries) + ' retries</span>' : '') +
    (t.skillLoaded && t.skillLoaded.length ? '<span class="c-ok">skill: ' + esc(t.skillLoaded.join(', ')) + '</span>' : '') + '</div>';
  if (t.reasoning) h += '<details class="reasoning"><summary>reasoning (' + fmtK(t.reasoning.length) + ' chars)</summary><pre>' + esc(t.reasoning) + '</pre></details>';
  (t.toolCalls || []).forEach(function(tc){ h += toolHTML(tc); });
  if (t.assistantText) h += '<div class="assistant-text">' + esc(t.assistantText) + '</div>';
  return h + '</div>';
}
function resultHTML(s){
  var r = s.record;
  var kv = [
    ['status', r.status], ['score', r.score != null ? r.score + '/5' : '—'], ['pass', r.pass == null ? '—' : (r.pass ? 'yes' : 'no')],
    ['cost', fmtCost(r.costUsd)], ['duration', fmtMs(r.durationMs)], ['turns', r.turns],
    ['tokens', fmtK(r.usage.input) + ' in / ' + fmtK(r.usage.output) + ' out'],
    ['tool calls', r.toolCallCount + (r.toolErrors ? ' (' + r.toolErrors + ' err)' : '')]
  ];
  if (r.skillsLoaded && r.skillsLoaded.length) kv.push(['skills', r.skillsLoaded.join(', ')]);
  var h = '<div class="result"><div class="kv">' + kv.map(function(p){ return '<span>' + esc(p[0]) + ' <b>' + esc(p[1]) + '</b></span>'; }).join('') + '</div>';
  if (r.error) h += '<div class="err-box"><b>' + esc(r.error.kind) + ':</b> ' + esc(r.error.message) + '</div>';
  if (r.judgeReasoning) h += '<div class="lab case-meta" style="margin:6px 0 4px">judge</div><div class="judge">' + esc(r.judgeReasoning) + '</div>';
  if (S.runDirName && r.transcriptPath) h += '<div style="margin-top:8px;font-size:12px"><a target="_blank" rel="noopener" href="/runs/' + encodeURIComponent(S.runDirName) + '/transcript.html?path=' + encodeURIComponent(r.transcriptPath) + '">Full transcript ↗</a></div>';
  return h + '</div>';
}
function renderBody(s){
  var body = s.el.querySelector('.case-body');
  var c = S.caseById[s.key.caseId];
  var h = c ? '<div class="prompt-row"><span class="role-badge user">user</span><span class="prompt-text">' + esc(c.prompt) + '</span></div>' : '';
  h += '<div class="turns">' + s.turns.map(turnHTML).join('') + '</div>';
  if (!s.record) h += '<div class="pending"><span class="spinner"></span>waiting for next turn…</div>';
  else {
    if (s.record.finalAnswer) h += '<div class="turn-block"><div class="turn-header"><span class="role-badge assistant">final answer</span></div><div class="assistant-text">' + esc(s.record.finalAnswer) + '</div></div>';
    h += resultHTML(s);
  }
  body.innerHTML = h;
}

// ── run done ──
function renderDone(ev){
  var parts = String(ev.runDir || '').split('/').filter(Boolean);
  S.runDirName = parts.length ? parts[parts.length - 1] : null;
  $('done-panel').classList.remove('hidden');
  var link = $('report-link');
  if (S.runDirName) { link.href = '/runs/' + encodeURIComponent(S.runDirName) + '/report.html'; link.classList.remove('hidden'); }
  else link.classList.add('hidden');
  var cells = (ev.summary && ev.summary.cells) || [];
  var h = '<tr><th>model</th><th>condition</th><th>ok / err / skip</th><th>pass rate</th><th>mean score</th><th>avg turns</th><th>avg tokens</th><th>cost</th><th>p50</th><th>p90</th></tr>';
  cells.forEach(function(c){
    h += '<tr><td class="rowhead">' + esc(c.model) + '</td><td class="rowhead">' + esc(c.condition) + '</td>' +
      '<td class="num"><span class="c-ok">' + esc(c.completed) + '</span> / <span class="c-err">' + esc(c.errors + c.judgeErrors) + '</span> / <span class="c-skip">' + esc(c.skipped) + '</span></td>' +
      '<td class="num">' + fmtPct(c.passRate) + '</td><td class="num">' + fmtScore(c.meanScore) + '</td>' +
      '<td class="num">' + (c.avgTurns == null ? '–' : esc(Math.round(c.avgTurns * 10) / 10)) + '</td>' +
      '<td class="num">' + fmtK(c.avgTotalTokens) + '</td><td class="num">' + fmtCost(c.totalCostUsd) + '</td>' +
      '<td class="num">' + fmtMs(c.p50DurationMs) + '</td><td class="num">' + fmtMs(c.p90DurationMs) + '</td></tr>';
  });
  $('summary-table').innerHTML = h;
  S.order.forEach(function(k){ var s = S.sessions[k]; if (s.open) renderBody(s); });
}

// ── SSE ──
var es = new EventSource('/events');
es.onopen = function(){ $('conn').textContent = '● live'; $('conn').style.color = 'var(--green)'; };
es.onerror = function(){ $('conn').textContent = '● reconnecting…'; $('conn').style.color = 'var(--amber)'; };
es.onmessage = function(e){
  var ev; try { ev = JSON.parse(e.data); } catch (err) { return; }
  if (!ev || typeof ev.type !== 'string' || ev.type.indexOf('uc:') !== 0) return;
  switch (ev.type) {
    case 'uc:preflight':
      freshIfFinished();
      if (renderPreflight(ev.checks || [])) { if (!busy()) setPhase('preflight', 'Preflight passed'); else setStatus('running', 'Preflight passed'); }
      else { S.startedHere = false; setPhase('failed', 'Preflight failed'); }
      break;
    case 'uc:run:start':
      freshIfFinished();
      S.total = ev.total || 0;
      (ev.models || []).forEach(function(m){ (ev.conditions || []).forEach(function(c){ addDim(m, c); }); });
      $('progress-panel').classList.remove('hidden');
      $('placeholder').classList.add('hidden');
      setPhase('running', 'Running');
      renderMatrix(); renderProgress();
      break;
    case 'uc:session:start':
      if (!busy()) { freshIfFinished(); setPhase('running', 'Running'); }
      getSession(ev.key); renderMatrix(); renderProgress();
      break;
    case 'uc:session:turn': {
      var s = getSession(ev.key);
      var t = ev.turn; s.turns.push(t);
      if (t.usage) s.tokens += (t.usage.input || 0) + (t.usage.output || 0);
      updateHeader(s);
      if (s.open) { var tw = s.el.querySelector('.turns'); if (tw) tw.insertAdjacentHTML('beforeend', turnHTML(t)); }
      break;
    }
    case 'uc:session:done': {
      var s2 = getSession(ev.record);
      s2.record = ev.record;
      updateHeader(s2);
      if (s2.open) renderBody(s2);
      renderMatrix(); renderProgress();
      break;
    }
    case 'uc:run:done':
      S.startedHere = false;
      setPhase('done', 'Done');
      renderDone(ev); renderProgress();
      break;
  }
};

loadSidebar();
})();
</script>
</body>
</html>`;

// ─── Server ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = 'bench.config.json';
const SUITE_PATH = 'suites/circleci-use-cases.json';
const RUNS_DIR = 'benchmarks/uc2/runs';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function parseBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

interface RunRequest { models: string[]; conditions: string[]; cases: string[]; reps: number }

/** Validates a POST /api/run body against the config and suite. Returns an error message or the resolved run inputs. */
function validateRunRequest(body: unknown, cfg: BenchConfig, suite: UseCaseSuite):
  { error: string } | { models: ModelConfig[]; conditions: Condition[]; cases: UseCase[]; reps: number } {
  const b = (body ?? {}) as Partial<RunRequest>;
  if (!isStringArray(b.models) || b.models.length === 0) return { error: 'models must be a non-empty array of model ids' };
  if (!isStringArray(b.conditions) || b.conditions.length === 0) return { error: 'conditions must be a non-empty array' };
  if (!isStringArray(b.cases) || b.cases.length === 0) return { error: 'cases must be a non-empty array of case ids' };
  if (typeof b.reps !== 'number' || !Number.isInteger(b.reps) || b.reps < 1 || b.reps > 100) return { error: 'reps must be an integer between 1 and 100' };

  let models: ModelConfig[];
  try { models = activeModels(cfg, b.models); } catch (err) { return { error: errMsg(err) }; }

  const badConds = b.conditions.filter((c) => !ALL_CONDITIONS.includes(c as Condition));
  if (badConds.length) return { error: `Unknown condition(s): ${badConds.join(', ')}. Valid: ${ALL_CONDITIONS.join(', ')}` };
  const conditions = [...new Set(b.conditions)] as Condition[];

  const ids = new Set(b.cases);
  const unknown = [...ids].filter((id) => !suite.cases.some((c) => c.id === id));
  if (unknown.length) return { error: `Unknown case id(s): ${unknown.join(', ')}` };
  const cases = suite.cases.filter((c) => ids.has(c.id));

  return { models, conditions, cases, reps: b.reps };
}

/** Serves a file under benchmarks/uc2/runs/, refusing anything that resolves outside it. */
function serveRunFile(relUrlPath: string, res: http.ServerResponse) {
  const base = path.resolve(RUNS_DIR);
  let rel: string;
  try { rel = decodeURIComponent(relUrlPath); } catch { res.writeHead(400); res.end('Bad path'); return; }
  if (rel.includes('\0')) { res.writeHead(400); res.end('Bad path'); return; }
  const filePath = path.resolve(base, rel);
  if (!filePath.startsWith(base + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { res.writeHead(404); res.end('Not found'); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).pipe(res);
}

export function startUIServer(port = 4321): () => void {
  const clients = new Set<http.ServerResponse>();
  let runInProgress = false;
  let lastError: string | null = null;

  const server = http.createServer(async (req, res) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { pathname = '/'; }

    // SSE
    if (pathname === '/events') {
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

    // Model/condition config (env var names and values are never sent)
    if (pathname === '/api/config') {
      try {
        const cfg = loadConfig(CONFIG_PATH);
        sendJSON(res, 200, {
          models: cfg.models.map((m) => ({ id: m.id, provider: m.provider, model: m.model, enabled: m.enabled !== false })),
          conditions: cfg.conditions,
          allConditions: ALL_CONDITIONS,
          repetitions: cfg.repetitions,
          concurrency: cfg.concurrency,
        });
      } catch (err) {
        sendJSON(res, 500, { error: `Could not load ${CONFIG_PATH}: ${errMsg(err)}` });
      }
      return;
    }

    if (pathname === '/api/suite') {
      try {
        sendJSON(res, 200, loadSuite(SUITE_PATH));
      } catch (err) {
        sendJSON(res, 500, { error: `Could not load ${SUITE_PATH}: ${errMsg(err)}` });
      }
      return;
    }

    if (pathname === '/api/status') {
      sendJSON(res, 200, { running: runInProgress, lastError });
      return;
    }

    // Trigger a use-cases run
    if (pathname === '/api/run') {
      if (req.method !== 'POST') { sendJSON(res, 405, { error: 'POST only' }); return; }
      if (runInProgress) { sendJSON(res, 409, { error: 'A run is already in progress' }); return; }
      let body: unknown;
      try { body = await parseBody(req); } catch (err) { sendJSON(res, 400, { error: errMsg(err) }); return; }

      let cfg: BenchConfig;
      let suite: UseCaseSuite;
      try {
        cfg = loadConfig(CONFIG_PATH);
        suite = loadSuite(SUITE_PATH);
      } catch (err) {
        sendJSON(res, 500, { error: errMsg(err) });
        return;
      }
      const v = validateRunRequest(body, cfg, suite);
      if ('error' in v) { sendJSON(res, 400, { error: v.error }); return; }
      if (runInProgress) { sendJSON(res, 409, { error: 'A run is already in progress' }); return; }

      runInProgress = true;
      lastError = null;
      sendJSON(res, 202, { status: 'started', sessions: v.models.length * v.conditions.length * v.cases.length * v.reps });

      // Kick off asynchronously; import lazily to avoid a circular dep at module load time
      setImmediate(async () => {
        let runner: typeof import('../benchmarks/skills/runner.js') | undefined;
        try {
          runner = await import('../benchmarks/skills/runner.js');
          const { runDir } = await runner.runUseCaseBenchmark({
            cfg, suite, suitePath: SUITE_PATH,
            models: v.models, conditions: v.conditions, cases: v.cases, reps: v.reps,
            concurrency: cfg.concurrency,
          });
          console.log(`Run complete → ${runDir}`);
        } catch (err) {
          if (runner && err instanceof runner.PreflightFailedError) {
            // The uc:preflight event already carried the failed checks to the page.
            lastError = 'Preflight failed';
            console.error(`Preflight failed: ${err.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.target})`).join(', ')}`);
          } else {
            lastError = errMsg(err);
            console.error('Run error:', err);
          }
        } finally {
          runInProgress = false;
        }
      });
      return;
    }

    // Static run artifacts (report.html, transcript.html, sessions.jsonl, transcripts/…)
    if (pathname.startsWith('/runs/')) {
      serveRunFile(pathname.slice('/runs/'.length), res);
      return;
    }

    // Pages
    if (pathname === '/uc2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
    for (const client of clients) client.end();
    server.close();
  };
}
