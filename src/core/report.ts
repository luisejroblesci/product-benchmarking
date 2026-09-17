import fs from 'fs';
import path from 'path';
import type { UC1RunResult, UC2RunResult } from './types.js';

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function generateUC1Report(run: UC1RunResult, title: string): string {
  const rows = run.commits
    .map(
      (c) => `
      <tr>
        <td><code>${c.sha.slice(0, 7)}</code></td>
        <td>${c.message.slice(0, 60)}</td>
        <td class="teal">${fmtMs(c.sidecar.durationMs)}</td>
        <td class="${c.sidecar.status === 'pass' ? 'pass' : 'fail'}">${c.sidecar.status}</td>
        <td class="amber">${fmtMs(c.traditional.durationMs)}</td>
        <td class="${c.traditional.status === 'success' ? 'pass' : 'fail'}">${c.traditional.status}</td>
        <td>${(c.traditional.durationMs / c.sidecar.durationMs).toFixed(1)}×</td>
      </tr>`
    )
    .join('');

  const s = run.summary;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg:#F6F8FA;--surface:#fff;--border:#D0D7DE;--text:#1A1F29;--muted:#57606A;--teal:#00B89C;--amber:#D97706; }
  @media(prefers-color-scheme:dark){:root{--bg:#0D1117;--surface:#161B22;--border:#30363D;--text:#E6EDF3;--muted:#8B949E;--teal:#02D1AD;--amber:#F59E0B;}}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:32px 24px;max-width:960px;margin:0 auto;}
  h1{font-size:20px;font-weight:600;margin-bottom:4px;}
  .meta{color:var(--muted);font-size:13px;margin-bottom:28px;}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:28px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .card-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px;}
  .card-val{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;}
  .card-val.teal{color:var(--teal)}.card-val.amber{color:var(--amber)}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
  td{padding:8px 12px;border-bottom:1px solid var(--border);}
  code{font-family:monospace;font-size:12px;}
  .teal{color:var(--teal)} .amber{color:var(--amber)}
  .pass{color:#16A34A} .fail{color:#DC2626}
</style></head><body>
<h1>${title}</h1>
<div class="meta">${run.repo} · ${new Date(run.timestamp).toLocaleString()} · ${run.commits.length} commits</div>
<div class="summary">
  <div class="card"><div class="card-label">Avg Sidecar</div><div class="card-val teal">${fmtMs(s.avgSidecarMs)}</div></div>
  <div class="card"><div class="card-label">Avg Traditional</div><div class="card-val amber">${fmtMs(s.avgTraditionalMs)}</div></div>
  <div class="card"><div class="card-label">Speedup Factor</div><div class="card-val">${s.speedupFactor.toFixed(1)}×</div></div>
  <div class="card"><div class="card-label">p50 Sidecar</div><div class="card-val teal">${fmtMs(s.p50SidecarMs)}</div></div>
  <div class="card"><div class="card-label">p50 Traditional</div><div class="card-val amber">${fmtMs(s.p50TraditionalMs)}</div></div>
</div>
<table><thead><tr><th>SHA</th><th>Message</th><th>Sidecar</th><th>Status</th><th>Traditional</th><th>Status</th><th>Speedup</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

export function generateUC2Report(run: UC2RunResult, title: string): string {
  const configRows = run.configs
    .map(
      (cfg) => `
      <tr>
        <td><code>${cfg.tools.join(', ')}</code></td>
        <td>${cfg.summary.avgTurns.toFixed(1)}</td>
        <td>${cfg.summary.totalTokens.toLocaleString()}</td>
        <td>${fmtMs(cfg.summary.avgDurationMs)}</td>
        <td>${(cfg.summary.successRate * 100).toFixed(0)}%</td>
      </tr>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg:#F6F8FA;--surface:#fff;--border:#D0D7DE;--text:#1A1F29;--muted:#57606A; }
  @media(prefers-color-scheme:dark){:root{--bg:#0D1117;--surface:#161B22;--border:#30363D;--text:#E6EDF3;--muted:#8B949E;}}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:32px 24px;max-width:960px;margin:0 auto;}
  h1{font-size:20px;font-weight:600;margin-bottom:4px;}
  .meta{color:var(--muted);font-size:13px;margin-bottom:28px;}
  .highlight{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .card-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px;}
  .card-val{font-size:16px;font-weight:600;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
  td{padding:8px 12px;border-bottom:1px solid var(--border);}
  code{font-family:monospace;font-size:12px;}
</style></head><body>
<h1>${title}</h1>
<div class="meta">${run.suite} · ${new Date(run.timestamp).toLocaleString()}</div>
<div class="highlight">
  <div class="card"><div class="card-label">Fastest Config</div><div class="card-val"><code>${run.crossConfigSummary.fastestConfig}</code></div></div>
  <div class="card"><div class="card-label">Lowest Tokens</div><div class="card-val"><code>${run.crossConfigSummary.lowestTokenConfig}</code></div></div>
  <div class="card"><div class="card-label">Fewest Turns</div><div class="card-val"><code>${run.crossConfigSummary.fewestTurnsConfig}</code></div></div>
</div>
<table><thead><tr><th>Tools</th><th>Avg Turns</th><th>Total Tokens</th><th>Avg Duration</th><th>Success Rate</th></tr></thead>
<tbody>${configRows}</tbody></table>
</body></html>`;
}

export function saveReport(html: string, outPath: string) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
}
