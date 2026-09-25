import fs from 'fs';
import path from 'path';
import type {
  UC1RunResult, RunManifest, RunSummary, SessionRecord, CellSummary, Condition,
} from './types.js';

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

export function saveReport(html: string, outPath: string) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use-cases benchmark (multi-model × condition) report + transcript viewer
// ─────────────────────────────────────────────────────────────────────────────

/** Strict HTML escape for text and attribute contexts. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(0)}%`);
const num = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '–' : x.toFixed(d));
const int = (x: number | null | undefined) => (x === null || x === undefined ? '–' : Math.round(x).toLocaleString('en-US'));
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);
const ms = (x: number | null | undefined) => (x === null || x === undefined ? '–' : fmtMs(Math.round(x)));
const signed = (x: number | null, f: (n: number) => string) =>
  x === null ? '–' : `<span class="${x > 0 ? 'pos' : x < 0 ? 'neg' : ''}">${x > 0 ? '+' : x < 0 ? '−' : '±'}${f(Math.abs(x))}</span>`;

/** Shared design tokens + base styles for the use-case report and transcript viewer. */
const UC_STYLE = `
  :root{--bg:#F6F8FA;--surface:#fff;--surface2:#F0F3F6;--border:#D0D7DE;--text:#1A1F29;--muted:#57606A;--teal:#00B89C;--amber:#D97706;--pass:#16A34A;--fail:#DC2626;--link:#0969DA;}
  @media(prefers-color-scheme:dark){:root{--bg:#0D1117;--surface:#161B22;--surface2:#1C2129;--border:#30363D;--text:#E6EDF3;--muted:#8B949E;--teal:#02D1AD;--amber:#F59E0B;--pass:#3FB950;--fail:#F85149;--link:#58A6FF;}}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:32px 24px;max-width:1200px;margin:0 auto;line-height:1.45;}
  h1{font-size:20px;font-weight:600;margin:0 0 4px;}
  h2{font-size:15px;font-weight:600;margin:32px 0 10px;}
  a{color:var(--link);text-decoration:none} a:hover{text-decoration:underline}
  .meta{color:var(--muted);font-size:13px;margin-bottom:20px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .card-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px;}
  .card-val{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:8px;background:var(--surface);}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;}
  td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top;font-variant-numeric:tabular-nums;}
  tr:last-child td{border-bottom:none}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
  .pass,.pos{color:var(--pass)} .fail,.neg{color:var(--fail)} .muted{color:var(--muted)} .teal{color:var(--teal)} .amber{color:var(--amber)}
  .note{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px;margin:16px 0;}
  .badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;border:1px solid var(--border);white-space:nowrap;}
  .badge.completed{color:var(--pass);border-color:var(--pass)} .badge.error{color:var(--fail);border-color:var(--fail)}
  .badge.skipped{color:var(--muted)} .badge.judge_error{color:var(--amber);border-color:var(--amber)}
  @media(max-width:600px){body{padding:16px}td,th{padding:6px 8px}}
`;

function cellHtml(c: CellSummary | undefined, anchor: string | null): string {
  if (!c) return '<td class="muted">–</td>';
  const body = `
    <div class="cell-main"><span class="big">${pct(c.passRate)}</span> <span class="muted">pass</span> · <b>${num(c.meanScore, 2)}</b><span class="muted">/5</span></div>
    <div class="cell-sub">${num(c.avgTurns)} turns · ${int(c.avgTotalTokens)} tok</div>
    <div class="cell-sub">${usd(c.totalCostUsd)} · p50 ${ms(c.p50DurationMs)}</div>
    <div class="cell-sub"><span class="pass">${c.completed}✓</span> <span class="fail">${c.errors}✗</span> <span class="muted">${c.skipped} skip</span>${c.judgeErrors ? ` <span class="amber">${c.judgeErrors} judge✗</span>` : ''}</div>`;
  return `<td class="cell">${anchor ? `<a class="cell-link" href="#${esc(anchor)}">${body}</a>` : body}</td>`;
}

const rowAnchor = (model: string, condition: string) =>
  `s-${model}-${condition}`.replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`);

/** Link to transcript.html (relative to the run dir) for a session, optionally side by side with another. */
export function transcriptLink(transcriptPath: string, compare?: string): string {
  return `transcript.html?path=${encodeURIComponent(transcriptPath)}${compare ? `&compare=${encodeURIComponent(compare)}` : ''}`;
}

/** The counterpart condition for side-by-side comparison (cli ↔ cli+skills, mcp ↔ mcp+skills). */
function counterpart(c: Condition): Condition {
  return (c.endsWith('+skills') ? c.slice(0, -'+skills'.length) : `${c}+skills`) as Condition;
}

export function generateUseCaseReport(manifest: RunManifest, summary: RunSummary, records: SessionRecord[]): string {
  const models = manifest.models.length ? manifest.models : [...new Set(summary.cells.map((c) => c.model))];
  const conditions = manifest.conditions.length ? manifest.conditions : [...new Set(summary.cells.map((c) => c.condition))];
  const cellOf = (m: string, c: string) => summary.cells.find((x) => x.model === m && x.condition === c);

  const pre = manifest.preflight ?? [];
  const preFailed = pre.filter((p) => !p.ok);
  const preflightHtml = !pre.length
    ? '<span class="muted">not run</span>'
    : preFailed.length
      ? `<span class="fail">${preFailed.length}/${pre.length} failed</span>`
      : `<span class="pass">passed (${pre.length} checks)</span>`;

  const total = records.length;
  const nCompleted = records.filter((r) => r.status === 'completed').length;
  const nErr = records.filter((r) => r.status === 'error').length;
  const nSkip = records.filter((r) => r.status === 'skipped').length;
  const nJudgeErr = records.filter((r) => r.status === 'judge_error').length;
  const totalCost = records.reduce((a, r) => a + (r.costUsd ?? 0), 0);

  // ── matrix ──
  const matrix = `
<div class="scroll"><table class="matrix"><thead><tr><th>Model</th>${conditions.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${models
    .map((m) => `<tr><td><b>${esc(m)}</b></td>${conditions
      .map((c) => cellHtml(cellOf(m, c), records.some((r) => r.model === m && r.condition === c) ? rowAnchor(m, c) : null))
      .join('')}</tr>`)
    .join('')}</tbody></table></div>`;

  // ── skills delta ──
  const deltaRows = summary.skillsDelta
    .map((d) => `<tr><td>${esc(d.model)}</td><td><code>${esc(d.surface)}+skills</code> vs <code>${esc(d.surface)}</code></td>
      <td>${signed(d.passRateDelta, (n) => `${(n * 100).toFixed(0)}pp`)}</td>
      <td>${signed(d.meanScoreDelta, (n) => n.toFixed(2))}</td>
      <td>${d.tokensDelta === null ? '–' : `<span class="${d.tokensDelta < 0 ? 'pos' : d.tokensDelta > 0 ? 'neg' : ''}">${d.tokensDelta > 0 ? '+' : d.tokensDelta < 0 ? '−' : '±'}${int(Math.abs(d.tokensDelta))}</span>`}</td></tr>`)
    .join('');
  const deltaTable = summary.skillsDelta.length
    ? `<div class="scroll"><table><thead><tr><th>Model</th><th>Comparison</th><th>Δ Pass rate</th><th>Δ Mean score</th><th>Δ Avg tokens</th></tr></thead><tbody>${deltaRows}</tbody></table></div>`
    : '<p class="muted">No paired conditions (X and X+skills) in this run.</p>';

  // ── per case ──
  const caseIds = manifest.suite?.caseIds?.length ? manifest.suite.caseIds : [...new Set(summary.byCase.map((b) => b.caseId))];
  const caseRows = caseIds
    .flatMap((id) => models.map((m) => {
      const cols = conditions.map((c) => {
        const b = summary.byCase.find((x) => x.caseId === id && x.model === m && x.condition === c);
        return b ? `<td>${pct(b.passRate)} <span class="muted">· ${num(b.meanScore, 1)}</span></td>` : '<td class="muted">–</td>';
      });
      return `<tr><td><code>${esc(id)}</code></td><td>${esc(m)}</td>${cols.join('')}</tr>`;
    }))
    .join('');
  const caseTable = `<div class="scroll"><table><thead><tr><th>Case</th><th>Model</th>${conditions
    .map((c) => `<th>${esc(c)} <span class="muted">pass · score</span></th>`).join('')}</tr></thead><tbody>${caseRows}</tbody></table></div>`;

  // ── turns by case (rows = cases, cols = model × condition) ──
  const turnCols = models.flatMap((m) => conditions.map((c) => ({ m, c })));
  const turnFmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : num(n, Number.isInteger(n) ? 0 : 1));
  const turnRows = caseIds
    .map((id) => `<tr><td><code>${esc(id)}</code></td>${turnCols.map(({ m, c }) => {
      const b = summary.byCase.find((x) => x.caseId === id && x.model === m && x.condition === c);
      if (!b) return '<td class="muted">–</td>';
      const star = b.unfinished ? '<span class="fail" title="some sessions did not finish; excluded">*</span>' : '';
      return `<td>${turnFmt(b.avgTurns)}${star}</td>`;
    }).join('')}</tr>`)
    .join('');
  const turnAvg = `<tr><td><strong>average</strong></td>${turnCols.map(({ m, c }) => {
    const cell = summary.cells.find((x) => x.model === m && x.condition === c);
    return `<td><strong>${turnFmt(cell?.avgTurns)}</strong></td>`;
  }).join('')}</tr>`;
  const turnsTable = `<div class="scroll"><table><thead><tr><th rowspan="2">Case</th>${models
    .map((m) => `<th colspan="${conditions.length}">${esc(m)}</th>`).join('')}</tr><tr>${turnCols
    .map(({ c }) => `<th><code>${esc(c)}</code></th>`).join('')}</tr></thead><tbody>${turnRows}${turnAvg}</tbody></table></div>
<p class="muted small">A turn is one model response (which may include several tool calls). Averages are over sessions that finished; <span class="fail">*</span> marks cells where some session did not.</p>`;

  // ── sessions ──
  const sorted = [...records].sort((a, b) =>
    models.indexOf(a.model) - models.indexOf(b.model) ||
    conditions.indexOf(a.condition) - conditions.indexOf(b.condition) ||
    a.caseId.localeCompare(b.caseId) || a.rep - b.rep);
  const seenAnchor = new Set<string>();
  const sessionRows = sorted
    .map((r) => {
      const anchor = rowAnchor(r.model, r.condition);
      const idAttr = seenAnchor.has(anchor) ? '' : ` id="${esc(anchor)}"`;
      seenAnchor.add(anchor);
      const other = records.find((x) => x.model === r.model && x.caseId === r.caseId && x.rep === r.rep && x.condition === counterpart(r.condition));
      const links = r.transcriptPath
        ? `<a href="${esc(transcriptLink(r.transcriptPath))}">transcript</a>${other?.transcriptPath ? ` · <a href="${esc(transcriptLink(r.transcriptPath, other.transcriptPath))}">vs ${esc(other.condition)}</a>` : ''}`
        : '<span class="muted">–</span>';
      const scoreHtml = r.score === null || r.score === undefined ? '<span class="muted">–</span>' : `<span class="${r.pass ? 'pass' : 'fail'}">${num(r.score, 1)}</span>`;
      const errHtml = r.error ? `<div class="muted small" title="${esc(r.error.message)}">${esc(r.error.kind)}: ${esc(r.error.message.slice(0, 80))}</div>` : '';
      return `<tr${idAttr}><td>${esc(r.model)}</td><td><code>${esc(r.condition)}</code></td><td><code>${esc(r.caseId)}</code></td><td>${r.rep}</td>
        <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span>${errHtml}</td><td>${scoreHtml}</td><td>${r.turns}</td>
        <td>${int((r.usage?.input ?? 0) + (r.usage?.output ?? 0))}</td><td>${r.toolCallCount}${r.toolErrors ? ` <span class="fail">(${r.toolErrors}✗)</span>` : ''}</td>
        <td>${usd(r.costUsd)}</td><td>${ms(r.durationMs)}</td><td>${links}</td></tr>`;
    })
    .join('');

  const title = `Use-case benchmark · ${manifest.suite?.name ?? ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${UC_STYLE}
  .matrix td.cell{min-width:170px}
  .cell-link{display:block;color:inherit} .cell-link:hover{text-decoration:none;background:var(--surface2)}
  .cell-main{font-size:13px} .cell-main .big{font-size:18px;font-weight:600}
  .cell-sub{font-size:12px;color:var(--muted)}
  .small{font-size:11px}
  details summary{cursor:pointer;color:var(--muted);font-size:13px}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">run <code>${esc(manifest.runId)}</code> · ${esc(new Date(manifest.startedAt).toLocaleString('en-US'))} · ${models.length} models × ${conditions.length} conditions × ${caseIds.length} cases × ${manifest.repetitions} reps</div>
<div class="grid">
  <div class="card"><div class="card-label">Suite</div><div class="card-val">${esc(manifest.suite?.name)}</div><div class="muted small"><code>${esc((manifest.suite?.sha256 ?? '').slice(0, 12))}</code></div></div>
  <div class="card"><div class="card-label">Git SHA</div><div class="card-val"><code>${esc(manifest.gitSha ? manifest.gitSha.slice(0, 10) : 'unknown')}</code></div></div>
  <div class="card"><div class="card-label">Skills</div><div class="card-val"><code>${esc(manifest.skills?.resolvedSha ? manifest.skills.resolvedSha.slice(0, 10) : 'unresolved')}</code></div><div class="muted small">${esc(manifest.skills?.repo)}@${esc(manifest.skills?.ref)}</div></div>
  <div class="card"><div class="card-label">Preflight</div><div class="card-val">${preflightHtml}</div></div>
  <div class="card"><div class="card-label">Sessions</div><div class="card-val"><span class="pass">${nCompleted}✓</span> <span class="fail">${nErr}✗</span> <span class="muted">${nSkip} skip</span>${nJudgeErr ? ` <span class="amber">${nJudgeErr} judge✗</span>` : ''}</div><div class="muted small">${total} total</div></div>
  <div class="card"><div class="card-label">Total cost</div><div class="card-val">${usd(totalCost)}</div></div>
</div>
${preFailed.length ? `<div class="note"><b class="fail">Preflight failures</b><ul>${preFailed.map((p) => `<li><code>${esc(p.name)}</code> (${esc(p.target)}): ${esc(p.detail)}</li>`).join('')}</ul></div>` : ''}
<div class="note">Transcript links load JSONL with <code>fetch()</code>, which browsers block over <code>file://</code>. Serve the run directory with <code>npx tsx src/cli.ts serve &lt;runDir&gt;</code> and open <code>report.html</code> from there.</div>

<h2>Model × condition</h2>
<p class="muted small">Pass rate and mean score are over judged sessions; turns, tokens and p50 time are over sessions that ran to completion; cost includes errored sessions. Click a cell to jump to its sessions.</p>
${matrix}

<h2>Skills effect</h2>
${deltaTable}

<h2>Per case</h2>
${caseTable}
<h2>Turns by case</h2>
${turnsTable}

<h2 id="sessions">Sessions</h2>
<div class="scroll"><table><thead><tr><th>Model</th><th>Condition</th><th>Case</th><th>Rep</th><th>Status</th><th>Score</th><th>Turns</th><th>Tokens</th><th>Tools</th><th>Cost</th><th>Time</th><th>Trace</th></tr></thead>
<tbody>${sessionRows}</tbody></table></div>
<p class="muted small">Generated ${esc(summary.generatedAt)}</p>
</body></html>`;
}

/**
 * Static transcript viewer written as `<runDir>/transcript.html`.
 * Usage: transcript.html?path=<transcriptPath>[&compare=<transcriptPath2>] (paths relative to the run dir).
 */
export function generateTranscriptViewer(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session transcript</title>
<style>${UC_STYLE}
  body{max-width:1600px}
  .cols{display:grid;grid-template-columns:1fr;gap:16px}
  .cols.two{grid-template-columns:1fr 1fr}
  @media(max-width:900px){.cols.two{grid-template-columns:1fr}}
  .col{min-width:0}
  .hdr h2{margin:0 0 6px;font-size:15px}
  .kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:12px}
  .kv dt{color:var(--muted)} .kv dd{margin:0;overflow-wrap:anywhere}
  details{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:8px 0;}
  details>summary{padding:8px 12px;cursor:pointer;font-size:13px;list-style-position:inside}
  details .body{padding:0 12px 12px}
  details details{background:var(--surface2)}
  .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:10px 0 4px}
  pre{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto}
  details details pre{background:var(--surface)}
  .reason pre{font-style:italic;color:var(--muted)}
  .end{border-left:3px solid var(--teal)}
  .err{color:var(--fail)}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;font-size:13px;margin-bottom:12px}
</style></head><body>
<h1>Session transcript</h1>
<div class="meta"><a href="report.html">← report</a> <span id="cmpLinks"></span></div>
<div class="toolbar"><button id="expand" type="button">Expand all</button><button id="collapse" type="button">Collapse all</button></div>
<div id="root" class="cols"></div>
<script>
(function () {
  'use strict';
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safePath(p) {
    if (!p) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.charAt(0) === '/' || p.charAt(0) === '\\\\' || p.split('/').indexOf('..') !== -1) return null;
    return p;
  }
  function urlFor(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function fmtMs(ms) {
    if (ms == null) return '–';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function n(x) { return x == null ? '–' : Number(x).toLocaleString('en-US'); }
  function usage(u) {
    if (!u) return '';
    return 'in ' + n(u.input) + ' · out ' + n(u.output) + (u.cacheRead ? ' · cache r ' + n(u.cacheRead) : '') +
      (u.cacheWrite ? ' · cache w ' + n(u.cacheWrite) : '') + (u.reasoning ? ' · reasoning ' + n(u.reasoning) : '');
  }
  function pre(text, cls) { return '<pre' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(text) + '</pre>'; }
  function json(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
  function parseJsonl(text) {
    var out = [];
    text.split('\\n').forEach(function (line) {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch (e) { /* truncated line */ }
    });
    return out;
  }
  function argsShort(input) {
    if (input && Array.isArray(input.args)) return input.args.join(' ');
    var s = json(input).replace(/\\s+/g, ' ');
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  function renderHeader(h, p) {
    if (!h) return '<div class="card hdr"><h2>' + esc(p) + '</h2><p class="err">No session header (transcript may be truncated).</p></div>';
    return '<div class="card hdr"><h2>' + esc(h.model) + ' · <code>' + esc(h.condition) + '</code> · <code>' + esc(h.caseId) + '</code> r' + esc(h.rep) + '</h2>' +
      '<dl class="kv"><dt>provider</dt><dd>' + esc(h.provider) + ' / ' + esc(h.providerModel) + '</dd>' +
      '<dt>started</dt><dd>' + esc(h.startedAt) + '</dd>' +
      '<dt>tools</dt><dd>' + esc((h.toolNames || []).join(', ')) + '</dd>' +
      '<dt>skills</dt><dd>' + esc((h.skillsAvailable || []).join(', ') || '–') + '</dd>' +
      '<dt>file</dt><dd><code>' + esc(p) + '</code></dd></dl>' +
      '<details><summary>System prompt</summary><div class="body">' + pre(h.systemPrompt) + '</div></details>' +
      '<details open><summary>User prompt</summary><div class="body">' + pre(h.userPrompt) + '</div></details></div>';
  }

  function renderTool(tc) {
    var head = (tc.isError ? '<span class="err">✗</span> ' : '→ ') + '<b>' + esc(tc.name) + '</b>(<code>' + esc(argsShort(tc.input)) + '</code>)' +
      ' <span class="muted">' + fmtMs(tc.durationMs) + ' · ' + n(tc.outputBytes) + ' B' + (tc.exitCode != null ? ' · exit ' + esc(tc.exitCode) : '') + '</span>';
    var full = tc.blobPath && safePath(tc.blobPath)
      ? '<p><a href="' + esc(urlFor(tc.blobPath)) + '" target="_blank" rel="noopener">view full output</a> <span class="muted">(' + esc(tc.blobPath) + ', showing preview)</span></p>'
      : '';
    return '<details><summary>' + head + '</summary><div class="body">' +
      '<div class="lbl">input</div>' + pre(json(tc.input)) +
      '<div class="lbl">output' + (tc.truncated ? ' (preview)' : '') + (tc.isError ? ' <span class="err">[ERROR]</span>' : '') + '</div>' + pre(tc.output) + full +
      '</div></details>';
  }

  function renderTurn(t) {
    var tools = t.toolCalls || [];
    var summary = '<b>Turn ' + esc(t.turn) + '</b> <span class="muted">' + fmtMs(t.durationMs) + ' · ' + n((t.usage || {}).input) + '/' + n((t.usage || {}).output) + ' tok · ' +
      tools.length + ' tool call' + (tools.length === 1 ? '' : 's') + (t.skillLoaded && t.skillLoaded.length ? ' · skill: ' + esc(t.skillLoaded.join(', ')) : '') + '</span> ' +
      esc(tools.map(function (x) { return x.name; }).join(', '));
    var body = '';
    if (t.reasoning) body += '<div class="lbl">reasoning</div><div class="reason">' + pre(t.reasoning) + '</div>';
    if (t.assistantText) body += '<div class="lbl">assistant</div>' + pre(t.assistantText);
    if (tools.length) body += '<div class="lbl">tool calls</div>' + tools.map(renderTool).join('');
    body += '<div class="lbl">meta</div><div class="muted" style="font-size:12px">' + esc(usage(t.usage)) + ' · finish: ' + esc(t.finishReason) +
      (t.retries ? ' · retries: ' + esc(t.retries) : '') + ' · started ' + esc(t.startedAt) + '</div>';
    return '<details class="turn"><summary>' + summary + '</summary><div class="body">' + body + '</div></details>';
  }

  function renderEnd(e) {
    if (!e) return '<div class="card end"><b class="err">No end block</b> <span class="muted">— the session crashed or is still running.</span></div>';
    var t = e.totals || {};
    var j = e.judge;
    return '<div class="card end"><div class="lbl">end · <span class="badge ' + esc(e.status) + '">' + esc(e.status) + '</span></div>' +
      (e.error ? '<p class="err">' + esc(e.error.kind) + ': ' + esc(e.error.message) + '</p>' : '') +
      '<div class="lbl">final answer</div>' + pre(e.finalAnswer || '') +
      '<div class="lbl">judge</div>' + (j ? '<p><b class="' + (j.pass ? 'pass' : 'fail') + '">' + esc(j.score) + '/5 · ' + (j.pass ? 'pass' : 'fail') + '</b> <span class="muted">(' + esc(j.judgeModel) + ')</span></p>' + pre(j.reasoning) : '<p class="muted">not judged</p>') +
      '<div class="lbl">totals</div><dl class="kv">' +
      '<dt>turns</dt><dd>' + n(t.turns) + '</dd><dt>tokens</dt><dd>' + esc(usage(t.usage)) + '</dd>' +
      '<dt>cost</dt><dd>' + (t.costUsd == null ? '–' : '$' + Number(t.costUsd).toFixed(4)) + '</dd>' +
      '<dt>time</dt><dd>' + fmtMs(t.durationMs) + ' (model ' + fmtMs(t.modelTimeMs) + ', tools ' + fmtMs(t.toolTimeMs) + ')</dd>' +
      '<dt>tool calls</dt><dd>' + n(t.toolCallCount) + ' (' + n(t.toolErrors) + ' errors) · ' + esc((t.distinctTools || []).join(', ')) + '</dd>' +
      '<dt>skills loaded</dt><dd>' + esc((t.skillsLoaded || []).join(', ') || '–') + '</dd>' +
      '<dt>ended</dt><dd>' + esc(e.endedAt) + '</dd></dl></div>';
  }

  function render(p, lines) {
    var h = null, e = null, turns = [];
    lines.forEach(function (l) {
      if (l.type === 'session') h = l; else if (l.type === 'turn') turns.push(l); else if (l.type === 'end') e = l;
    });
    return renderHeader(h, p) + turns.map(renderTurn).join('') + renderEnd(e);
  }

  function load(p) {
    return fetch(urlFor(p)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + p);
      return r.text();
    }).then(function (text) { return render(p, parseJsonl(text)); });
  }

  var params = new URLSearchParams(location.search);
  var root = document.getElementById('root');
  var rawMain = params.get('path'), rawCmp = params.get('compare');
  var main = safePath(rawMain), cmp = safePath(rawCmp);
  if (!main) {
    root.innerHTML = '<div class="card err">' + (rawMain ? 'Refusing unsafe path: <code>' + esc(rawMain) + '</code>' : 'Missing <code>?path=</code> parameter.') + '</div>';
    return;
  }
  if (rawCmp && !cmp) root.insertAdjacentHTML('beforebegin', '<div class="note err">Ignoring unsafe compare path.</div>');

  // "compare with" links: same case/rep under each other condition
  var m = /^(transcripts\\/[^/]+\\/)([^/]+)(\\/.+)$/.exec(main);
  if (m) {
    var conds = ['cli+skills', 'cli', 'mcp+skills', 'mcp'].filter(function (c) { return c !== m[2]; });
    document.getElementById('cmpLinks').innerHTML = ' · compare with: ' + conds.map(function (c) {
      var other = m[1] + c + m[3];
      return '<a href="?path=' + encodeURIComponent(main) + '&compare=' + encodeURIComponent(other) + '">' + esc(c) + '</a>';
    }).join(' · ') + (cmp ? ' · <a href="?path=' + encodeURIComponent(main) + '">single</a>' : '');
  }

  var paths = cmp ? [main, cmp] : [main];
  if (paths.length === 2) root.classList.add('two');
  var hint = location.protocol === 'file:' ? '<p class="muted">fetch() does not work over file://. Serve the run dir with <code>npx tsx src/cli.ts serve &lt;runDir&gt;</code>.</p>' : '';
  Promise.all(paths.map(function (p) {
    return load(p).catch(function (err) { return '<div class="card"><p class="err">' + esc(err && err.message ? err.message : err) + '</p>' + hint + '</div>'; });
  })).then(function (htmls) {
    root.innerHTML = htmls.map(function (h) { return '<div class="col">' + h + '</div>'; }).join('');
  });

  document.getElementById('expand').onclick = function () { root.querySelectorAll('details').forEach(function (d) { d.open = true; }); };
  document.getElementById('collapse').onclick = function () { root.querySelectorAll('details').forEach(function (d) { d.open = false; }); };
})();
</script>
</body></html>`;
}
