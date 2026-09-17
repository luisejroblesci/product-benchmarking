import http from 'http';
import { EventEmitter } from 'events';

export type BenchEvent =
  | { type: 'run:start'; total: number; repo: string }
  | { type: 'commit:start'; sha: string; message: string; index: number }
  | { type: 'commit:sidecar'; sha: string; durationMs: number; status: string }
  | { type: 'commit:traditional'; sha: string; durationMs: number; status: string }
  | { type: 'commit:skip'; sha: string; reason: string }
  | { type: 'run:done'; speedupFactor: number; avgSidecarMs: number; avgTraditionalMs: number };

export const benchEmitter = new EventEmitter();

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Benchmark Live</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0D1117;--surface:#161B22;--surface2:#1C2128;--border:#30363D;
  --text:#E6EDF3;--muted:#8B949E;
  --teal:#02D1AD;--teal-dim:#0D2E2A;
  --amber:#F59E0B;--amber-dim:#2D1F07;
  --violet:#818CF8;--violet-dim:#1E1B4B;
  --green:#4ADE80;--red:#F87171;
}
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

/* Summary tiles */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.tile-label{font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:5px}
.tile-val{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile-val.teal{color:var(--teal)}.tile-val.amber{color:var(--amber)}.tile-val.neutral{color:var(--text)}

/* Table */
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
.badge.pass{background:#0D2E1A;color:var(--green)}.badge.fail{background:#2D0F0F;color:var(--red)}
.badge.skip{background:var(--surface2);color:var(--muted)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--violet);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.speedup-col{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600}
.empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}

/* Connection status */
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
    <div class="status-pill waiting" id="status-pill">
      <span class="dot"></span> <span id="status-text">Waiting</span>
    </div>
  </header>

  <div class="tiles">
    <div class="tile"><div class="tile-label">Avg Sidecar</div><div class="tile-val teal" id="avg-sidecar">—</div></div>
    <div class="tile"><div class="tile-label">Avg Traditional</div><div class="tile-val amber" id="avg-trad">—</div></div>
    <div class="tile"><div class="tile-label">Speedup</div><div class="tile-val neutral" id="speedup">—</div></div>
    <div class="tile"><div class="tile-label">Progress</div><div class="tile-val neutral" id="progress">0 / ?</div></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>SHA</th>
          <th>Message</th>
          <th class="teal">Sidecar</th>
          <th class="teal">Status</th>
          <th class="amber">Traditional</th>
          <th class="amber">Status</th>
          <th>Speedup</th>
        </tr>
      </thead>
      <tbody id="tbody">
        <tr><td colspan="7" class="empty">Run the benchmark to see live results</td></tr>
      </tbody>
    </table>
  </div>
  <div class="conn" id="conn">● connecting to localhost:4321…</div>
</div>

<script>
const fmtMs = ms => {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
};

const rows = {};
let total = 0, done = 0;
let sidecarTimes = [], tradTimes = [];

const tbody = document.getElementById('tbody');
const pill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const conn = document.getElementById('conn');

function setStatus(state) {
  pill.className = 'status-pill ' + state;
  const dot = pill.querySelector('.dot');
  dot.className = 'dot' + (state === 'running' ? ' pulse' : '');
}

function updateTiles() {
  if (sidecarTimes.length === 0) return;
  const avg = arr => arr.reduce((s,v)=>s+v,0)/arr.length;
  document.getElementById('avg-sidecar').textContent = fmtMs(Math.round(avg(sidecarTimes)));
  document.getElementById('avg-trad').textContent = fmtMs(Math.round(avg(tradTimes)));
  const factor = avg(tradTimes)/avg(sidecarTimes);
  document.getElementById('speedup').textContent = factor.toFixed(1) + '×';
  document.getElementById('progress').textContent = done + ' / ' + (total || '?');
}

function getOrCreateRow(sha) {
  if (rows[sha]) return rows[sha];
  if (tbody.querySelector('.empty')) tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.id = 'row-' + sha;
  tr.className = 'active';
  tr.innerHTML = \`
    <td class="sha">\${sha.slice(0,7)}</td>
    <td class="msg" id="msg-\${sha}">…</td>
    <td class="time-cell teal" id="sc-time-\${sha}"><span class="spinner"></span></td>
    <td id="sc-status-\${sha}"></td>
    <td class="time-cell amber" id="tr-time-\${sha}"><span class="spinner"></span></td>
    <td id="tr-status-\${sha}"></td>
    <td class="speedup-col" id="speedup-\${sha}">—</td>
  \`;
  tbody.appendChild(tr);
  rows[sha] = tr;
  return tr;
}

const es = new EventSource('/events');

es.onopen = () => { conn.textContent = '● connected'; conn.style.color = 'var(--teal)'; };
es.onerror = () => { conn.textContent = '● disconnected — is the benchmark running?'; conn.style.color = 'var(--red)'; };

es.onmessage = e => {
  const ev = JSON.parse(e.data);

  if (ev.type === 'run:start') {
    total = ev.total;
    document.getElementById('repo-tag').textContent = ev.repo;
    document.getElementById('progress').textContent = '0 / ' + total;
    setStatus('running');
    statusText.textContent = 'Running';
  }

  if (ev.type === 'commit:start') {
    getOrCreateRow(ev.sha);
    document.getElementById('msg-' + ev.sha).textContent = ev.message.slice(0, 55);
  }

  if (ev.type === 'commit:sidecar') {
    const cell = document.getElementById('sc-time-' + ev.sha);
    const badge = document.getElementById('sc-status-' + ev.sha);
    if (cell) cell.textContent = fmtMs(ev.durationMs);
    if (badge) badge.innerHTML = \`<span class="badge \${ev.status === 'pass' ? 'pass' : 'fail'}">\${ev.status}</span>\`;
    sidecarTimes.push(ev.durationMs);
    updateTiles();
  }

  if (ev.type === 'commit:traditional') {
    const cell = document.getElementById('tr-time-' + ev.sha);
    const badge = document.getElementById('tr-status-' + ev.sha);
    if (cell) cell.textContent = fmtMs(ev.durationMs);
    if (badge) badge.innerHTML = \`<span class="badge \${ev.status === 'success' ? 'pass' : 'fail'}">\${ev.status}</span>\`;
    tradTimes.push(ev.durationMs);
    done++;
    // Update speedup for this row
    const si = sidecarTimes[sidecarTimes.length - 1];
    const sp = document.getElementById('speedup-' + ev.sha);
    if (sp && si) sp.textContent = (ev.durationMs / si).toFixed(1) + '×';
    const row = rows[ev.sha];
    if (row) row.classList.remove('active');
    updateTiles();
  }

  if (ev.type === 'commit:skip') {
    const row = getOrCreateRow(ev.sha);
    row.innerHTML = \`<td class="sha">\${ev.sha.slice(0,7)}</td><td colspan="6"><span class="badge skip">skipped — \${ev.reason}</span></td>\`;
    row.classList.remove('active');
  }

  if (ev.type === 'run:done') {
    setStatus('done');
    statusText.textContent = 'Done';
    document.getElementById('speedup').textContent = ev.speedupFactor.toFixed(1) + '×';
    document.getElementById('avg-sidecar').textContent = fmtMs(ev.avgSidecarMs);
    document.getElementById('avg-trad').textContent = fmtMs(ev.avgTraditionalMs);
  }
};
</script>
</body>
</html>`;

export function startUIServer(port = 4321): () => void {
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n'); // SSE comment to open connection
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  });

  const emit = (event: BenchEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(data);
  };

  benchEmitter.on('event', emit);

  server.listen(port, () => {
    console.log(`\nLive dashboard → http://localhost:${port}\n`);
  });

  return () => {
    benchEmitter.off('event', emit);
    server.close();
  };
}

export function emitBenchEvent(event: BenchEvent) {
  benchEmitter.emit('event', event);
}
