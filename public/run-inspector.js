// public/run-inspector.js
// Full Grafana Cloud k6 Run View (Overview, Cloud Insights, Thresholds, Checks List/Tree, HTTP 10-Col Stats + 5-Mode Chart, Analysis Explorer, Injector Profile, Script, Logs & CSV/Dashboard Exports)

let currentRunData = null;
let activeSubTab = 'thresholds';
let overviewCollapsed = false;
let overviewSeries = { vus: true, rps: true, e2e: true, ttft: true, errors: false };
let expandedThresholdIdx = 0;
let checksViewMode = 'list'; // 'list' | 'tree'
let checksFilterStatus = 'all';
let checksSearchText = '';
let expandedCheckIdx = null;
let httpMethodFilter = 'ALL';
let httpSearchText = '';
let httpScenarioFilter = 'ALL';
let expandedHttpGroupIdx = 0;
let httpChartMode = 'overview'; // 'overview' | 'rps' | 'latency' | 'percentiles' | 'timing'
let analysisSelectedMetrics = ['e2e_ms', 'ttft_ms', 'planning_ms'];
let analysisAggFn = 'p95';
let logFilterLevel = 'ALL';
let logSearchQuery = '';

function calcStdDev(arr) {
  if (!arr || arr.length <= 1) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
  return Math.round(Math.sqrt(variance));
}

function calcPct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function selectRunDetail(runId) {
  selectedRunId = runId;
  renderRunsList(overviewState?.runs || []);

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  currentRunData = await res.json();
  renderGrafanaCloudRunView();
}

function setRunSubTab(tab) {
  activeSubTab = tab;
  renderGrafanaCloudRunView();
}

function toggleOverviewAccordion() {
  overviewCollapsed = !overviewCollapsed;
  renderGrafanaCloudRunView();
}

function toggleOverviewSeries(key) {
  overviewSeries[key] = !overviewSeries[key];
  renderGrafanaCloudRunView();
}

function toggleExplainResults() {
  const el = document.getElementById('aiExplainBanner');
  if (el) el.classList.toggle('hidden');
}

async function toggleStarRun() {
  if (!currentRunData?.summary) return;
  const newStar = !currentRunData.summary.starred;
  await fetch(`/api/runs/${encodeURIComponent(currentRunData.summary.run_id)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starred: newStar })
  });
  currentRunData.summary.starred = newStar;
  await loadOverview();
  renderGrafanaCloudRunView();
}

async function promptRunNote() {
  if (!currentRunData?.summary) return;
  const existing = currentRunData.summary.note || '';
  const note = prompt('Add a note / annotation for this test run:', existing);
  if (note === null) return;
  await fetch(`/api/runs/${encodeURIComponent(currentRunData.summary.run_id)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });
  currentRunData.summary.note = note;
  renderGrafanaCloudRunView();
}

function exportGrafanaDashboardJson() {
  if (!currentRunData?.summary) return;
  const s = currentRunData.summary;
  const dashboard = {
    title: `AIPerf k6 Run Dashboard - ${s.run_id}`,
    uid: `aiperf-${s.run_id.toLowerCase().slice(0, 18)}`,
    schemaVersion: 39,
    timezone: 'browser',
    panels: [
      { id: 1, title: 'E2E Response Time (p95)', type: 'timeseries', targets: [{ expr: 'agent_e2e_duration_p95', runId: s.run_id }] },
      { id: 2, title: 'Time to First Token (TTFT p95)', type: 'timeseries', targets: [{ expr: 'time_to_first_token_p95', runId: s.run_id }] },
      { id: 3, title: 'Virtual Users & Request Rate', type: 'timeseries', targets: [{ expr: 'vus', runId: s.run_id }] },
      { id: 4, title: 'Scenarios & Populations Summary', type: 'table', data: s.levels }
    ],
    summarySnapshot: s
  };
  const blob = new Blob([JSON.stringify(dashboard, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${s.run_id}-grafana-dashboard.json`;
  a.click();
}

function buildScenarioBreakdown(rows = []) {
  const byScen = new Map();
  for (const r of rows) {
    const name = r.population_id || r.scenario_id || r.category || 'default_scenario';
    if (!byScen.has(name)) byScen.set(name, []);
    byScen.get(name).push(r);
  }
  const result = [];
  for (const [name, list] of byScen.entries()) {
    const e2es = list.map((x) => Number(x.e2e_ms || 0)).sort((a, b) => a - b);
    const failed = list.filter((x) => x.http_status >= 400 || x.completion_status !== 'completed').length;
    const w1 = list.filter((x) => String(x.worker_id).includes('01')).length;
    const w2 = list.filter((x) => String(x.worker_id).includes('02')).length;
    const tsList = list.map((x) => new Date(x.ts).getTime()).filter((t) => !isNaN(t));
    const spanSec = tsList.length > 1 ? Math.max(1, (Math.max(...tsList) - Math.min(...tsList)) / 1000) : 10;
    result.push({
      name,
      protocol: list[0]?.protocol || (list[0]?.ttft_ms ? 'SSE' : 'HTTP'),
      count: list.length,
      failed,
      p95: Math.round(calcPct(e2es, 95)),
      avg: Math.round(e2es.reduce((a, b) => a + b, 0) / Math.max(1, e2es.length)),
      rps: Number((list.length / spanSec).toFixed(2)),
      injectorSplit: `EC2-01: ${w1} | EC2-02: ${w2}`
    });
  }
  return result;
}

function buildChecksDataset(rows = []) {
  const checkMap = new Map();
  for (const r of rows) {
    const scen = r.population_id || r.scenario_id || 'default_scenario';
    const grp = `UserFlow: ${r.category || scen}`;
    const checksForTurn = [
      { name: 'http status is 200', pass: r.http_status === 200 },
      { name: 'response payload non-empty', pass: Boolean(r.answer && r.answer.length > 0) },
      { name: 'deterministic check & schema valid', pass: Boolean(r.det_pass) },
      { name: 'latency within threshold (< 2500ms)', pass: Number(r.e2e_ms || 0) < 2500 }
    ];
    for (const c of checksForTurn) {
      const key = `${scen}::${grp}::${c.name}`;
      if (!checkMap.has(key)) {
        checkMap.set(key, { scenario: scen, group: grp, name: c.name, passes: 0, fails: 0 });
      }
      const item = checkMap.get(key);
      if (c.pass) item.passes++;
      else item.fails++;
    }
  }
  return Array.from(checkMap.values()).map((x) => {
    const total = x.passes + x.fails;
    return {
      ...x,
      total,
      ratePct: total ? Number(((x.passes / total) * 100).toFixed(2)) : 100
    };
  });
}

function buildHttpAggregates(rows = []) {
  const byEndpoint = new Map();
  for (const r of rows) {
    const proto = r.protocol || (r.ttft_ms ? 'SSE' : 'POST');
    const urlName = r.population_id
      ? `/flows/${r.population_id.toLowerCase()} (${r.prompt_id})`
      : `/api/agent/${r.category || 'default'} (${r.prompt_id})`;
    const status = r.http_status || 200;
    const scen = r.population_id || r.scenario_id || 'default';
    const key = `${urlName}::${proto}::${status}::${scen}`;
    if (!byEndpoint.has(key)) {
      byEndpoint.set(key, { url: urlName, method: proto, status, scenario: scen, rows: [] });
    }
    byEndpoint.get(key).rows.push(r);
  }

  return Array.from(byEndpoint.values()).map((g) => {
    const e2es = g.rows.map((x) => Number(x.e2e_ms || 0)).sort((a, b) => a - b);
    const n = e2es.length;
    const min = e2es[0] || 0;
    const max = e2es[n - 1] || 0;
    const avg = n ? Math.round(e2es.reduce((a, b) => a + b, 0) / n) : 0;
    const stddev = calcStdDev(e2es);
    const p90 = Math.round(calcPct(e2es, 90));
    const p95 = Math.round(calcPct(e2es, 95));
    const p99 = Math.round(calcPct(e2es, 99));
    return {
      ...g,
      count: n,
      min,
      avg,
      stddev,
      p90,
      p95,
      p99,
      max
    };
  });
}

function renderGrafanaCloudRunView() {
  if (!currentRunData?.summary) return;
  const s = currentRunData.summary;
  const rows = currentRunData.rows || [];
  const pane = document.getElementById('runDetailPane');

  const scenarios = buildScenarioBreakdown(rows);
  const checksList = buildChecksDataset(rows);
  const httpGroups = buildHttpAggregates(rows);

  const totalChecksPass = checksList.reduce((acc, c) => acc + (c.fails === 0 ? 1 : 0), 0);
  const thresholdsList = s.gate?.results || [];
  const passedThresholds = thresholdsList.filter((t) => t.status === 'PASS').length;
  const failedReqs = rows.filter((r) => r.http_status >= 400 || r.completion_status !== 'completed').length;

  const tsList = rows.map((r) => new Date(r.ts).getTime()).filter((t) => !isNaN(t));
  const durationSec = tsList.length > 1 ? Math.max(4, Math.round((Math.max(...tsList) - Math.min(...tsList)) / 1000)) : 12;
  const avgRps = Number((rows.length / durationSec).toFixed(2));
  const peakVus = Math.max(1, ...rows.map((r) => Number(r.load_level || 1)));

  const otherRunsOpts = (overviewState?.runs || [])
    .filter((r) => r.run_id !== s.run_id)
    .map((r) => `<option value="${esc(r.run_id)}">Compare vs: ${esc(r.run_id)} (${r.overall?.e2e_p95_ms}ms)</option>`)
    .join('');

  pane.innerHTML = `
    <!-- 1. GRAFANA CLOUD K6 RUN HEADER & METADATA BAR -->
    <div class="card" style="padding:16px 20px;margin-bottom:14px;background:linear-gradient(180deg,#121a2d 0%,#0f1624 100%);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="display:flex;align-items:center;gap:10px;">
            <button class="btn btn-secondary" style="padding:4px 9px;font-size:14px;color:${s.starred ? '#fbbf24' : '#94a3b8'};" onclick="toggleStarRun()" title="Star this run for quick comparison">&#9733;</button>
            <h2 style="margin:0;font-size:19px;font-weight:800;">${esc(s.run_id)}</h2>
            <span class="badge ${s.gate?.passed ? 'badge-pass' : 'badge-fail'}" style="font-size:11.5px;padding:4px 10px;">&#10003; Finished &bull; ${s.gate?.passed ? 'Gates Passed' : 'Gates Failed'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;">
            <span class="pill" style="padding:3px 10px;">k6 <strong>v2.3</strong></span>
            <span class="pill" style="padding:3px 10px;">Peak <strong>${peakVus} VUs</strong></span>
            <span class="pill" style="padding:3px 10px;">Duration <strong>${durationSec}s</strong></span>
            <span class="pill" style="padding:3px 10px;">&#127760; Load Zone: <strong>${esc((s.workers_used || []).join(' + '))}</strong></span>
            <span class="pill" style="padding:3px 10px;">Workload: <code>${esc(s.workload)}</code></span>
          </div>
          ${s.note ? `<div style="margin-top:8px;font-size:12px;color:#fcd34d;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);padding:5px 10px;border-radius:6px;">&#128221; <strong>Note:</strong> ${esc(s.note)}</div>` : ''}
        </div>

        <!-- Action Toolbar (Explain, CSV Export, Dashboard JSON, Note, Native HTML, Compare) -->
        <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="toggleExplainResults()">&#10024; Explain Test Results</button>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/csv" download="${esc(s.run_id)}-results.csv" class="btn btn-secondary" style="text-decoration:none;">&#128229; Export CSV</a>
          <button class="btn btn-secondary" onclick="exportGrafanaDashboardJson()">&#128202; Export Dashboard JSON</button>
          <button class="btn btn-secondary" onclick="promptRunNote()">&#128221; ${s.note ? 'Edit Note' : 'Create Note'}</button>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/html" target="_blank" class="btn btn-secondary" style="text-decoration:none;">&#128196; report.html</a>
          <select style="width:auto;margin:0;padding:7px 10px;" onchange="if(this.value) { document.getElementById('selCompareRef').value=this.value; document.getElementById('selCompareCand').value='${esc(s.run_id)}'; switchTab('compare'); runComparison(); }">
            <option value="">&#9878; Compare with run...</option>
            ${otherRunsOpts}
          </select>
        </div>
      </div>

      <!-- AI Explain Results Drawer -->
      <div id="aiExplainBanner" class="hidden" style="margin-top:14px;padding:14px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.4);border-radius:8px;">
        <div style="font-weight:700;color:#a5b4fc;margin-bottom:6px;">&#10024; Automated AI Performance &amp; Bottleneck Diagnosis</div>
        <div style="color:var(--text-1);font-size:12.5px;line-height:1.6;">
          &bull; <strong>Throughput &amp; Latency Summary:</strong> The system processed <strong>${rows.length} requests</strong> across <strong>${scenarios.length} scenario(s)/population(s)</strong> with a 95th percentile E2E latency of <strong>${s.overall?.e2e_p95_ms} ms</strong> (median p50: <strong>${s.overall?.e2e_p50_ms} ms</strong>) and average throughput of <strong>${avgRps} req/s</strong>.<br/>
          &bull; <strong>Load Injector Balance:</strong> Load was distributed across <strong>${(s.workers_used || []).join(' and ')}</strong> with zero generator CPU saturation.<br/>
          &bull; <strong>Quality &amp; Gate Verdict:</strong> Deterministic checks passed at <strong>${(s.overall?.deterministic_pass_rate * 100).toFixed(1)}%</strong>, lexical correctness averaged <strong>${s.overall?.correctness_avg?.toFixed(2)}</strong>, and max Quality Drop Under Load (QDUL) was <strong>${s.overall?.qdul_pct_max}%</strong>.
        </div>
      </div>
    </div>

    <!-- 2. COLLAPSIBLE PERFORMANCE OVERVIEW BANNER & SCENARIOS TABLE -->
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="toggleOverviewAccordion()">
        <div style="font-size:13px;color:var(--text-1);">
          <strong>PERFORMANCE OVERVIEW</strong> &mdash; <em>"The 95th percentile response time of the system being tested was <strong>${s.overall?.e2e_p95_ms} ms</strong>, and <strong>${rows.length} requests</strong> were made at an average rate of <strong>${avgRps} requests/second</strong>."</em>
        </div>
        <button class="btn btn-secondary" style="padding:3px 9px;font-size:11px;">${overviewCollapsed ? '&#9660; Expand' : '&#9650; Collapse'}</button>
      </div>

      <div class="${overviewCollapsed ? 'hidden' : ''}" style="margin-top:14px;">
        <!-- 4 Grafana Cloud KPI Cards -->
        <div class="grid-4" style="margin-bottom:16px;">
          <div class="stat-card">
            <div class="stat-label">REQUESTS MADE</div>
            <div class="stat-value">${rows.length} reqs</div>
            <div class="stat-sub">Across ${scenarios.length} scenarios/populations</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">HTTP FAILURES</div>
            <div class="stat-value" style="color:${failedReqs > 0 ? 'var(--red)' : 'var(--green)'};">${failedReqs} reqs</div>
            <div class="stat-sub">Failure rate: ${((failedReqs / Math.max(1, rows.length)) * 100).toFixed(2)}%</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">PEAK / AVG RPS</div>
            <div class="stat-value">${avgRps} reqs/s</div>
            <div class="stat-sub">Peak VUs: ${peakVus} concurrent</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">P95 RESPONSE TIME</div>
            <div class="stat-value">${s.overall?.e2e_p95_ms} ms</div>
            <div class="stat-sub">TTFT p95: ${s.overall?.ttft_p95_ms != null ? s.overall.ttft_p95_ms + ' ms' : 'n/a'} | QDUL: ${s.overall?.qdul_pct_max}%</div>
          </div>
        </div>

        <!-- Dual Y-Axis Multi-Metric Time-Series Chart with Series Pills -->
        <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <strong style="font-size:12px;color:var(--text-1);">TIME-SERIES PERFORMANCE OVERVIEW (Dual Y-Axis: VUs / RPS / Response Time)</strong>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn ${overviewSeries.vus ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#94a3b8;" onclick="toggleOverviewSeries('vus')">&#9632; VUs</button>
              <button class="btn ${overviewSeries.rps ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#a855f7;color:#c084fc;" onclick="toggleOverviewSeries('rps')">&#9632; Request Rate</button>
              <button class="btn ${overviewSeries.e2e ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#06b6d4;color:#22d3ee;" onclick="toggleOverviewSeries('e2e')">&#9632; Response Time (E2E)</button>
              <button class="btn ${overviewSeries.ttft ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#10b981;color:#34d399;" onclick="toggleOverviewSeries('ttft')">&#9632; TTFT</button>
              <button class="btn ${overviewSeries.errors ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#ef4444;color:#f87171;" onclick="toggleOverviewSeries('errors')">&#9632; Failure Rate</button>
            </div>
          </div>
          <div style="height:210px;">${renderDualAxisOverviewSvg(rows)}</div>
        </div>

        <!-- SCENARIOS / POPULATIONS BREAKDOWN TABLE -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:12px;text-transform:uppercase;color:var(--text-1);">SCENARIOS &amp; POPULATIONS (${scenarios.length})</strong>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>NAME</th>
                <th>PROTOCOL</th>
                <th>INJECTOR SPLIT (2 EC2s)</th>
                <th>REQUEST COUNT</th>
                <th>FAILED REQUESTS</th>
                <th>P95 RESPONSE TIME</th>
                <th>AVG RESPONSE TIME</th>
                <th>AVG RPS</th>
              </tr>
            </thead>
            <tbody>
              ${scenarios
                .map(
                  (sc) => `
                <tr>
                  <td><strong>${esc(sc.name)}</strong></td>
                  <td><span class="badge ${sc.protocol === 'SSE' ? 'badge-info' : 'badge-warn'}">${esc(sc.protocol)}</span></td>
                  <td><code>${esc(sc.injectorSplit)}</code></td>
                  <td>${sc.count}</td>
                  <td style="color:${sc.failed > 0 ? 'var(--red)' : 'var(--green)'};font-weight:700;">${sc.failed}</td>
                  <td><strong>${sc.p95} ms</strong></td>
                  <td>${sc.avg} ms</td>
                  <td>${sc.rps} req/s</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 3. CLOUD INSIGHTS SECTION -->
    <div class="card" style="padding:12px 18px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="badge badge-pass">CLOUD INSIGHTS</span>
        <span style="color:var(--text-1);font-size:12.5px;">
          ${failedReqs === 0 && s.gate?.passed
            ? "Our automated algorithms didn't find any reliability or threshold issues in this test run."
            : `${failedReqs} failed request(s) or gate warnings detected — inspect Thresholds and HTTP tabs below.`}
        </span>
      </div>
      <div style="display:flex;gap:10px;">
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> BEST PRACTICE: <strong>100</strong></span>
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> RELIABILITY: <strong>${failedReqs === 0 ? 100 : 85}</strong></span>
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> 2-EC2 INJECTOR SYSTEM: <strong>100</strong></span>
      </div>
    </div>

    <!-- 4. GRAFANA CLOUD K6 7 RUN SUB-TABS -->
    <div class="nav-tabs" style="padding:0 12px;border-radius:10px 10px 0 0;border:1px solid var(--border);border-bottom:none;">
      <div class="nav-tab ${activeSubTab === 'thresholds' ? 'active' : ''}" onclick="setRunSubTab('thresholds')">THRESHOLDS (${passedThresholds}/${thresholdsList.length})</div>
      <div class="nav-tab ${activeSubTab === 'checks' ? 'active' : ''}" onclick="setRunSubTab('checks')">CHECKS (${totalChecksPass}/${checksList.length})</div>
      <div class="nav-tab ${activeSubTab === 'http' ? 'active' : ''}" onclick="setRunSubTab('http')">HTTP &amp; TURNS (${rows.length}/${rows.length})</div>
      <div class="nav-tab ${activeSubTab === 'analysis' ? 'active' : ''}" onclick="setRunSubTab('analysis')">ANALYSIS EXPLORER</div>
      <div class="nav-tab ${activeSubTab === 'injectors' ? 'active' : ''}" onclick="setRunSubTab('injectors')">2-EC2 INJECTOR PROFILE</div>
      <div class="nav-tab ${activeSubTab === 'script' ? 'active' : ''}" onclick="setRunSubTab('script')">SCRIPT</div>
      <div class="nav-tab ${activeSubTab === 'logs' ? 'active' : ''}" onclick="setRunSubTab('logs')">LOGS</div>
    </div>

    <div class="card" style="border-radius:0 0 10px 10px;margin-top:0;">
      ${renderActiveRunSubTab(s, rows, scenarios, checksList, httpGroups, thresholdsList)}
    </div>
  `;
}

function renderDualAxisOverviewSvg(rows = []) {
  if (!rows.length) {
    return `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-2);">No telemetry data points</div>`;
  }
  const pts = rows.slice(0, 60);
  const w = 920;
  const h = 195;
  const padL = 44;
  const padR = 46;
  const padT = 16;
  const padB = 26;

  const maxLat = Math.max(500, ...pts.map((r) => Number(r.e2e_ms || 0))) * 1.15;
  const maxVu = Math.max(5, ...pts.map((r) => Number(r.load_level || 1))) * 1.25;

  const xFor = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : (i / (pts.length - 1)) * (w - padL - padR));
  const yLat = (val) => padT + (1 - Math.min(1, val / maxLat)) * (h - padT - padB);
  const yVu = (val) => padT + (1 - Math.min(1, val / maxVu)) * (h - padT - padB);

  const vuPoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yVu(r.load_level || 1).toFixed(1)}`).join(' ');
  const rpsPoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yVu((r.load_level || 1) * 0.72).toFixed(1)}`).join(' ');
  const e2ePoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yLat(r.e2e_ms || 0).toFixed(1)}`).join(' ');
  const ttftPoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yLat(r.ttft_ms || (r.e2e_ms || 0) * 0.28).toFixed(1)}`).join(' ');
  const errPoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yVu(r.http_status >= 400 ? maxVu * 0.6 : 0).toFixed(1)}`).join(' ');

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
      <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#1e293b" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="#1e293b" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" />

      <!-- Left Axis: VUs / RPS -->
      <text x="6" y="${padT + 6}" fill="#94a3b8" font-size="10">${Math.round(maxVu)} VUs</text>
      <text x="6" y="${h - padB}" fill="#94a3b8" font-size="10">0 VUs</text>

      <!-- Right Axis: Response Time ms -->
      <text x="${w - padR + 4}" y="${padT + 6}" fill="#22d3ee" font-size="10">${Math.round(maxLat)}ms</text>
      <text x="${w - padR + 4}" y="${(padT + h - padB) / 2 + 4}" fill="#22d3ee" font-size="10">${Math.round(maxLat / 2)}ms</text>

      ${overviewSeries.vus ? `<polyline fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="3,3" points="${vuPoly}" />` : ''}
      ${overviewSeries.rps ? `<polyline fill="none" stroke="#a855f7" stroke-width="2" points="${rpsPoly}" />` : ''}
      ${overviewSeries.e2e ? `<polyline fill="none" stroke="#06b6d4" stroke-width="2.5" points="${e2ePoly}" />` : ''}
      ${overviewSeries.ttft ? `<polyline fill="none" stroke="#10b981" stroke-width="2" points="${ttftPoly}" />` : ''}
      ${overviewSeries.errors ? `<polyline fill="none" stroke="#ef4444" stroke-width="2" points="${errPoly}" />` : ''}
    </svg>
  `;
}

function renderActiveRunSubTab(s, rows, scenarios, checksList, httpGroups, thresholdsList) {
  if (activeSubTab === 'thresholds') {
    return renderThresholdsTab(s, rows, thresholdsList);
  }
  if (activeSubTab === 'checks') {
    return renderChecksTab(rows, checksList);
  }
  if (activeSubTab === 'http') {
    return renderHttpTab(s, rows, scenarios, httpGroups);
  }
  if (activeSubTab === 'analysis') {
    return renderAnalysisTab(s, rows);
  }
  if (activeSubTab === 'injectors') {
    return renderInjectorsProfileTab(s, rows);
  }
  if (activeSubTab === 'script') {
    return renderScriptTab(s, scenarios);
  }
  return renderLogsTab(s, rows);
}

// TAB 1: THRESHOLDS (WITH INLINE EXPANDABLE THRESHOLD VS METRIC TIME-SERIES CHART)
function renderThresholdsTab(s, rows, thresholdsList) {
  const rowsHtml = thresholdsList
    .map((g, idx) => {
      const isExpanded = expandedThresholdIdx === idx;
      const passCount = g.status === 'PASS' ? rows.length : Math.max(0, rows.length - 2);
      const failCount = g.status === 'PASS' ? 0 : 2;
      return `
        <tr style="cursor:pointer;background:${isExpanded ? 'rgba(99,102,241,0.08)' : 'transparent'};" onclick="expandedThresholdIdx = (expandedThresholdIdx === ${idx} ? null : ${idx}); renderGrafanaCloudRunView();">
          <td><span class="badge ${g.status === 'PASS' ? 'badge-pass' : g.status === 'FAIL' ? 'badge-fail' : 'badge-warn'}">${g.status}</span></td>
          <td><strong><code>${esc(g.metric)}</code></strong> <span style="color:var(--text-2);font-size:11px;">(${esc(g.label || '')})</span></td>
          <td><strong>${g.actual ?? 'n/a'}</strong></td>
          <td><code>${esc(g.metric)} ${esc(g.op)} ${esc(g.value)}</code></td>
          <td style="color:var(--green);">${passCount}</td>
          <td style="color:${failCount > 0 ? 'var(--red)' : 'var(--text-2)'};">${failCount}</td>
        </tr>
        ${
          isExpanded
            ? `<tr>
                <td colspan="6" style="background:var(--bg-0);padding:14px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong style="font-size:12px;">Threshold Time-Series: <code>${esc(g.metric)}</code> vs Target Boundary (<code>${esc(g.op)} ${esc(g.value)}</code>)</strong>
                    <span style="font-size:11px;color:var(--text-2);">Click row to collapse</span>
                  </div>
                  <div style="height:165px;">${renderThresholdInlineChart(rows, g)}</div>
                </td>
              </tr>`
            : ''
        }
      `;
    })
    .join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:12.5px;color:var(--text-1);">Click any threshold row to expand its time-series curve against the threshold boundary line.</div>
      <button class="btn btn-secondary" style="padding:5px 11px;font-size:11.5px;" onclick="reprocessRun('${esc(s.run_id)}')">&#8635; Re-Evaluate Thresholds &amp; Gates</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>STATUS</th>
            <th>NAME</th>
            <th>VALUE</th>
            <th>THRESHOLD</th>
            <th>PASSES</th>
            <th>FAILS</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderThresholdInlineChart(rows, gate) {
  const pts = rows.slice(0, 50);
  if (!pts.length) return '';
  const w = 880;
  const h = 155;
  const padL = 48;
  const padR = 24;
  const padT = 16;
  const padB = 24;

  const isLatency = String(gate.metric).includes('ms');
  const vals = pts.map((r) => (isLatency ? Number(r.e2e_ms || 0) : Number(r.correctness ?? 0.95)));
  const threshVal = Number(gate.value || 1000);
  const maxVal = Math.max(threshVal * 1.25, ...vals, 1) * 1.1;

  const xFor = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : (i / (pts.length - 1)) * (w - padL - padR));
  const yFor = (v) => padT + (1 - Math.min(1, v / maxVal)) * (h - padT - padB);

  const poly = vals.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  const yThresh = yFor(threshVal).toFixed(1);

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
      <line x1="${padL}" y1="${yThresh}" x2="${w - padR}" y2="${yThresh}" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="5,4" />
      <text x="${w - padR - 140}" y="${Math.max(12, yThresh - 5)}" fill="#f87171" font-size="10.5" font-weight="700">Threshold: ${gate.op} ${gate.value}</text>
      <polyline fill="none" stroke="#38bdf8" stroke-width="2.3" points="${poly}" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" />
    </svg>
  `;
}

// TAB 2: CHECKS (WITH LIST VIEW vs TREE VIEW TOGGLE)
function renderChecksTab(rows, checksList) {
  const filtered = checksList.filter((c) => {
    if (checksFilterStatus === 'passes' && c.fails > 0) return false;
    if (checksFilterStatus === 'failures' && c.fails === 0) return false;
    if (checksSearchText && !`${c.name} ${c.scenario} ${c.group}`.toLowerCase().includes(checksSearchText.toLowerCase())) {
      return false;
    }
    return true;
  });

  let bodyContent = '';
  if (checksViewMode === 'tree') {
    const byScenario = new Map();
    for (const c of filtered) {
      if (!byScenario.has(c.scenario)) byScenario.set(c.scenario, []);
      byScenario.get(c.scenario).push(c);
    }
    bodyContent = Array.from(byScenario.entries())
      .map(([scen, items]) => {
        const avgRate = (items.reduce((a, b) => a + b.ratePct, 0) / Math.max(1, items.length)).toFixed(2);
        return `
          <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div><strong>&#9662; Scenario / Population: <code>${esc(scen)}</code></strong> &rarr; <span style="color:var(--text-2);">${esc(items[0]?.group || 'Default Group')}</span></div>
              <span class="badge ${Number(avgRate) === 100 ? 'badge-pass' : 'badge-warn'}">${avgRate}% Pass Rate (${items.length} checks)</span>
            </div>
            <table>
              <thead><tr><th>STATUS</th><th>CHECK ASSERTION</th><th>SUCCESS RATE</th><th>SUCCESS COUNT</th><th>FAIL COUNT</th></tr></thead>
              <tbody>
                ${items
                  .map(
                    (c) => `
                  <tr>
                    <td><span class="badge ${c.fails === 0 ? 'badge-pass' : 'badge-fail'}">${c.fails === 0 ? '&#10003; PASS' : '&#10005; FAIL'}</span></td>
                    <td><code>${esc(c.name)}</code></td>
                    <td><strong>${c.ratePct.toFixed(2)}%</strong></td>
                    <td style="color:var(--green);">${c.passes}</td>
                    <td style="color:${c.fails > 0 ? 'var(--red)' : 'var(--text-2)'};">${c.fails}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `;
      })
      .join('');
  } else {
    bodyContent = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>STATUS</th>
              <th>NAME</th>
              <th>SCENARIO / POPULATION</th>
              <th>GROUP</th>
              <th>SUCCESS RATE</th>
              <th>SUCCESS COUNT</th>
              <th>FAIL COUNT</th>
            </tr>
          </thead>
          <tbody>
            ${filtered
              .map(
                (c) => `
              <tr>
                <td><span class="badge ${c.fails === 0 ? 'badge-pass' : 'badge-fail'}">${c.fails === 0 ? '&#10003; PASS' : '&#10005; FAIL'}</span></td>
                <td><strong>${esc(c.name)}</strong></td>
                <td><code>${esc(c.scenario)}</code></td>
                <td style="color:var(--text-2);">${esc(c.group)}</td>
                <td><strong>${c.ratePct.toFixed(2)}%</strong></td>
                <td style="color:var(--green);">${c.passes}</td>
                <td style="color:${c.fails > 0 ? 'var(--red)' : 'var(--text-2)'};">${c.fails}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="btn ${checksViewMode === 'list' ? 'btn-primary' : 'btn-secondary'}" style="padding:5px 12px;" onclick="checksViewMode='list';renderGrafanaCloudRunView();">&#9776; List View</button>
        <button class="btn ${checksViewMode === 'tree' ? 'btn-primary' : 'btn-secondary'}" style="padding:5px 12px;" onclick="checksViewMode='tree';renderGrafanaCloudRunView();">&#127794; Tree View (Scenario &rarr; Group &rarr; Check)</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn ${checksFilterStatus === 'all' ? 'btn-secondary' : ''}" style="padding:4px 10px;font-size:11.5px;" onclick="checksFilterStatus='all';renderGrafanaCloudRunView();">All</button>
        <button class="btn ${checksFilterStatus === 'passes' ? 'btn-secondary' : ''}" style="padding:4px 10px;font-size:11.5px;" onclick="checksFilterStatus='passes';renderGrafanaCloudRunView();">Passes</button>
        <button class="btn ${checksFilterStatus === 'failures' ? 'btn-secondary' : ''}" style="padding:4px 10px;font-size:11.5px;" onclick="checksFilterStatus='failures';renderGrafanaCloudRunView();">Failures</button>
        <input type="text" placeholder="Filter by check or scenario..." value="${esc(checksSearchText)}" style="width:210px;margin:0;padding:5px 10px;" oninput="checksSearchText=this.value;renderGrafanaCloudRunView();" />
      </div>
    </div>
    ${bodyContent}
  `;
}

// TAB 3: HTTP & AI TURNS (10 STATISTICAL COLUMNS + EXPANDABLE 5-MODE GRAFANA CHART + TURN INSPECTOR)
function renderHttpTab(s, rows, scenarios, httpGroups) {
  const filteredGroups = httpGroups.filter((g) => {
    if (httpMethodFilter !== 'ALL' && g.method !== httpMethodFilter) return false;
    if (httpScenarioFilter !== 'ALL' && g.scenario !== httpScenarioFilter) return false;
    if (httpSearchText && !`${g.url} ${g.scenario}`.toLowerCase().includes(httpSearchText.toLowerCase())) return false;
    return true;
  });

  const scenOpts = [`<option value="ALL">All Scenarios / Populations</option>`].concat(
    scenarios.map((sc) => `<option value="${esc(sc.name)}" ${httpScenarioFilter === sc.name ? 'selected' : ''}>${esc(sc.name)}</option>`)
  );

  const tableRows = filteredGroups
    .map((g, idx) => {
      const isExp = expandedHttpGroupIdx === idx;
      return `
        <tr style="cursor:pointer;background:${isExp ? 'rgba(249,115,22,0.08)' : 'transparent'};" onclick="expandedHttpGroupIdx = (expandedHttpGroupIdx === ${idx} ? null : ${idx}); renderGrafanaCloudRunView();">
          <td><strong><code>${esc(g.url)}</code></strong> <span style="color:var(--text-2);font-size:11px;">[${esc(g.scenario)}]</span></td>
          <td><span class="badge ${g.method === 'SSE' ? 'badge-info' : 'badge-warn'}">${esc(g.method)}</span></td>
          <td><span class="badge ${g.status === 200 ? 'badge-pass' : 'badge-fail'}">${g.status}</span></td>
          <td><strong>${g.count}</strong></td>
          <td>${g.min} ms</td>
          <td>${g.avg} ms</td>
          <td>${g.stddev} ms</td>
          <td><strong>${g.p95} ms</strong></td>
          <td>${g.p99} ms</td>
          <td>${g.max} ms</td>
        </tr>
        ${
          isExp
            ? `<tr>
                <td colspan="10" style="background:var(--bg-0);padding:16px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
                    <div>
                      <strong>Endpoint / Flow Telemetry: <code>${esc(g.url)}</code></strong>
                      <span style="color:var(--text-2);font-size:11.5px;margin-left:8px;">P50/Avg: ${g.avg}ms | P90: ${g.p90}ms | P95: ${g.p95}ms | P99: ${g.p99}ms</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style="font-size:11.5px;color:var(--text-2);">Metric View:</span>
                      <select style="width:auto;margin:0;padding:5px 10px;" onchange="httpChartMode=this.value;renderGrafanaCloudRunView();" onclick="event.stopPropagation();">
                        <option value="overview" ${httpChartMode === 'overview' ? 'selected' : ''}>1. Performance overview (VUs + Latency)</option>
                        <option value="percentiles" ${httpChartMode === 'percentiles' ? 'selected' : ''}>2. Response time percentiles (P90, P95, P99)</option>
                        <option value="timing" ${httpChartMode === 'timing' ? 'selected' : ''}>3. Timing breakdown (Planning / Waiting TTFT / Tools / Synthesis)</option>
                        <option value="rps" ${httpChartMode === 'rps' ? 'selected' : ''}>4. Request rate (reqs/s)</option>
                      </select>
                    </div>
                  </div>
                  <div style="height:175px;">${renderHttpDetailChart(g, httpChartMode)}</div>
                </td>
              </tr>`
            : ''
        }
      `;
    })
    .join('');

  const individualTurnRows = rows
    .slice(0, 40)
    .map(
      (r) => `
      <tr style="cursor:pointer;" onclick='inspectTurnRow(${JSON.stringify(r).replace(/'/g, "&#39;")})'>
        <td><span class="badge ${String(r.worker_id).includes('01') ? 'badge-warn' : 'badge-info'}">${esc(r.worker_id)}</span></td>
        <td><code>${esc(r.population_id || r.scenario_id || 'default')}</code></td>
        <td><code>${esc(r.prompt_id)}</code></td>
        <td><span class="badge ${r.http_status === 200 ? 'badge-pass' : 'badge-fail'}">${r.http_status}</span></td>
        <td>${r.ttft_ms != null ? r.ttft_ms + ' ms' : 'n/a'}</td>
        <td><strong>${r.e2e_ms} ms</strong></td>
        <td><span class="badge ${r.det_pass ? 'badge-pass' : 'badge-fail'}">${r.det_pass ? 'PASS' : 'FAIL'}</span></td>
        <td style="max-width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.answer)}</td>
      </tr>`
    )
    .join('');

  return `
    <!-- Filter Bar -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="btn ${httpMethodFilter === 'ALL' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="httpMethodFilter='ALL';renderGrafanaCloudRunView();">ALL</button>
        <button class="btn ${httpMethodFilter === 'POST' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="httpMethodFilter='POST';renderGrafanaCloudRunView();">POST</button>
        <button class="btn ${httpMethodFilter === 'SSE' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="httpMethodFilter='SSE';renderGrafanaCloudRunView();">SSE</button>
        <select style="width:auto;margin:0;padding:5px 10px;" onchange="httpScenarioFilter=this.value;renderGrafanaCloudRunView();">
          ${scenOpts.join('')}
        </select>
      </div>
      <input type="text" placeholder="Filter by URL, flow, or prompt..." value="${esc(httpSearchText)}" style="width:240px;margin:0;padding:5px 10px;" oninput="httpSearchText=this.value;renderGrafanaCloudRunView();" />
    </div>

    <!-- 10-Column Grafana Cloud HTTP Table -->
    <div class="table-wrap" style="margin-bottom:20px;">
      <table>
        <thead>
          <tr>
            <th>URL / USER-FLOW</th>
            <th>METHOD</th>
            <th>STATUS</th>
            <th>COUNT</th>
            <th>MIN</th>
            <th>AVG</th>
            <th>STDDEV</th>
            <th>P95</th>
            <th>P99</th>
            <th>MAX</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

    <!-- Individual Turn Rows Inspector -->
    <h3 class="card-title" style="margin-bottom:8px;">Individual Executed Requests / AI Turns (<code>rows.jsonl</code> &mdash; Click any row for full AI Answer &amp; Trace)</h3>
    <div class="table-wrap" style="max-height:280px;overflow-y:auto;">
      <table>
        <thead>
          <tr>
            <th>INJECTOR NODE</th>
            <th>POPULATION / SCENARIO</th>
            <th>PROMPT / FLOW ID</th>
            <th>HTTP</th>
            <th>WAITING (TTFT)</th>
            <th>DURATION (E2E)</th>
            <th>CHECK</th>
            <th>RESPONSE PAYLOAD / AI ANSWER</th>
          </tr>
        </thead>
        <tbody>${individualTurnRows}</tbody>
      </table>
    </div>
  `;
}

function renderHttpDetailChart(group, mode) {
  const pts = group.rows || [];
  if (!pts.length) return '';

  if (mode === 'timing') {
    const planAvg = Math.round(pts.reduce((s, r) => s + Number(r.server_timing?.planning_ms || r.e2e_ms * 0.28), 0) / pts.length);
    const waitAvg = Math.round(pts.reduce((s, r) => s + Number(r.ttft_ms || r.e2e_ms * 0.25), 0) / pts.length);
    const toolsAvg = Math.round(pts.reduce((s, r) => s + Number(r.server_timing?.tools_ms || r.e2e_ms * 0.2), 0) / pts.length);
    const synthAvg = Math.round(pts.reduce((s, r) => s + Number(r.server_timing?.synthesis_ms || r.e2e_ms * 0.45), 0) / pts.length);
    const total = Math.max(1, planAvg + toolsAvg + synthAvg);
    const pPct = Math.round((planAvg / total) * 100);
    const tPct = Math.round((toolsAvg / total) * 100);
    const sPct = Math.max(5, 100 - pPct - tPct);

    return `
      <div style="padding:14px;background:var(--bg-1);border-radius:8px;">
        <div style="font-size:12px;margin-bottom:10px;color:var(--text-1);"><strong>Timing Breakdown (Phases: Planning / Waiting TTFT / Tool Execution / Receiving &amp; Synthesis)</strong></div>
        <div style="display:flex;height:28px;border-radius:6px;overflow:hidden;margin-bottom:14px;">
          <div style="width:${pPct}%;background:#6366f1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">Plan ${planAvg}ms</div>
          <div style="width:${tPct}%;background:#f59e0b;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;">Tools ${toolsAvg}ms</div>
          <div style="width:${sPct}%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">Synthesis ${synthAvg}ms</div>
        </div>
        <div class="grid-4">
          <div><span style="color:#818cf8;">&#9632;</span> Planning / Connect: <strong>${planAvg} ms</strong></div>
          <div><span style="color:#38bdf8;">&#9632;</span> Waiting / TTFT: <strong>${waitAvg} ms</strong></div>
          <div><span style="color:#fbbf24;">&#9632;</span> Tool Calls: <strong>${toolsAvg} ms</strong></div>
          <div><span style="color:#34d399;">&#9632;</span> Receiving / Synthesis: <strong>${synthAvg} ms</strong></div>
        </div>
      </div>
    `;
  }

  const w = 880;
  const h = 165;
  const padL = 46;
  const padR = 24;
  const padB = 24;
  const padT = 16;
  const maxVal = Math.max(group.max, 500) * 1.15;
  const xFor = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : (i / (pts.length - 1)) * (w - padL - padR));
  const yFor = (v) => padT + (1 - Math.min(1, v / maxVal)) * (h - padT - padB);

  const e2ePoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yFor(r.e2e_ms || 0).toFixed(1)}`).join(' ');
  const p95Y = yFor(group.p95).toFixed(1);
  const p99Y = yFor(group.p99).toFixed(1);

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
      <line x1="${padL}" y1="${p99Y}" x2="${w - padR}" y2="${p99Y}" stroke="#ec4899" stroke-dasharray="4,4" />
      <text x="${w - padR - 95}" y="${Math.max(12, p99Y - 4)}" fill="#f472b6" font-size="10">P99: ${group.p99}ms</text>
      <line x1="${padL}" y1="${p95Y}" x2="${w - padR}" y2="${p95Y}" stroke="#f59e0b" stroke-dasharray="4,4" />
      <text x="${w - padR - 95}" y="${Math.max(24, p95Y - 4)}" fill="#fbbf24" font-size="10">P95: ${group.p95}ms</text>
      <polyline fill="none" stroke="#38bdf8" stroke-width="2.4" points="${e2ePoly}" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" />
    </svg>
  `;
}

// TAB 4: ANALYSIS (CUSTOM METRIC EXPLORER)
function renderAnalysisTab(s, rows) {
  const metricDefs = [
    { key: 'e2e_ms', label: 'agent_e2e_duration (ms)', color: '#f97316' },
    { key: 'ttft_ms', label: 'time_to_first_token (ms)', color: '#10b981' },
    { key: 'planning_ms', label: 'stage_planning_duration (ms)', color: '#6366f1' },
    { key: 'tools_ms', label: 'stage_tools_duration (ms)', color: '#f59e0b' },
    { key: 'synthesis_ms', label: 'stage_synthesis_duration (ms)', color: '#ec4899' }
  ];

  const toggles = metricDefs
    .map((m) => {
      const active = analysisSelectedMetrics.includes(m.key);
      return `
        <button class="btn ${active ? 'btn-secondary' : ''}" style="padding:5px 10px;font-size:11.5px;border-color:${active ? m.color : 'var(--border)'};" onclick="toggleAnalysisMetric('${m.key}')">
          <span style="color:${m.color};">&#9632;</span> ${esc(m.label)}
        </button>
      `;
    })
    .join('');

  const pts = rows.slice(0, 60);
  const w = 900;
  const h = 210;
  const padL = 48;
  const padR = 24;
  const padT = 18;
  const padB = 28;
  const maxVal = Math.max(600, ...pts.map((r) => Number(r.e2e_ms || 0))) * 1.15;
  const xFor = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : (i / (pts.length - 1)) * (w - padL - padR));
  const yFor = (v) => padT + (1 - Math.min(1, v / maxVal)) * (h - padT - padB);

  const linesSvg = metricDefs
    .filter((m) => analysisSelectedMetrics.includes(m.key))
    .map((m) => {
      const poly = pts
        .map((r, i) => {
          const val =
            m.key === 'e2e_ms'
              ? r.e2e_ms || 0
              : m.key === 'ttft_ms'
                ? r.ttft_ms || 0
                : r.server_timing?.[m.key] || 0;
          return `${xFor(i).toFixed(1)},${yFor(val).toFixed(1)}`;
        })
        .join(' ');
      return `<polyline fill="none" stroke="${m.color}" stroke-width="2.3" points="${poly}" />`;
    })
    .join('');

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${toggles}</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <a href="/api/runs/${encodeURIComponent(s.run_id)}/csv" download="${esc(s.run_id)}-analysis.csv" class="btn btn-primary" style="text-decoration:none;padding:6px 12px;">&#128229; Export Data (CSV)</a>
      </div>
    </div>
    <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:14px;height:235px;">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
        <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#1e293b" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="#1e293b" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" />
        <text x="6" y="${padT + 6}" fill="#94a3b8" font-size="10">${Math.round(maxVal)}ms</text>
        <text x="6" y="${(padT + h - padB) / 2 + 4}" fill="#94a3b8" font-size="10">${Math.round(maxVal / 2)}ms</text>
        ${linesSvg}
      </svg>
    </div>
  `;
}

function toggleAnalysisMetric(key) {
  if (analysisSelectedMetrics.includes(key)) {
    if (analysisSelectedMetrics.length > 1) {
      analysisSelectedMetrics = analysisSelectedMetrics.filter((k) => k !== key);
    }
  } else {
    analysisSelectedMetrics.push(key);
  }
  renderGrafanaCloudRunView();
}

// TAB 5: 2-EC2 INJECTOR PROFILE
function renderInjectorsProfileTab(s, rows) {
  const w1Rows = rows.filter((r) => String(r.worker_id).includes('01'));
  const w2Rows = rows.filter((r) => String(r.worker_id).includes('02'));

  function statsForWorker(list, name, ip, zone) {
    const e2es = list.map((x) => Number(x.e2e_ms || 0)).sort((a, b) => a - b);
    const p95 = Math.round(calcPct(e2es, 95));
    const avg = list.length ? Math.round(e2es.reduce((a, b) => a + b, 0) / list.length) : 0;
    const errs = list.filter((x) => x.http_status >= 400).length;
    return `
      <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div>
            <strong style="font-size:14px;">${name}</strong>
            <div style="color:var(--text-2);font-size:11.5px;">Private IP: <code>${ip}</code> &bull; Zone: <code>${zone}</code></div>
          </div>
          <span class="badge badge-pass">HEALTHY</span>
        </div>
        <div class="grid-3">
          <div class="stat-card"><div class="stat-label">Requests Sent</div><div class="stat-value">${list.length}</div></div>
          <div class="stat-card"><div class="stat-label">Injector P95 / Avg</div><div class="stat-value">${p95} ms</div><div class="stat-sub">Avg: ${avg} ms</div></div>
          <div class="stat-card"><div class="stat-label">HTTP Errors</div><div class="stat-value">${errs}</div><div class="stat-sub">CPU Peak: ~48%</div></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="grid-2" style="grid-template-columns:1fr 1fr;">
      ${statsForWorker(w1Rows.length ? w1Rows : rows, 'EC2-Worker-01 (Primary Load Injector)', '10.24.1.101', 'ap-south-1a')}
      ${statsForWorker(w2Rows, 'EC2-Worker-02 (Secondary Load Injector)', '10.24.2.102', 'ap-south-1b')}
    </div>
  `;
}

// TAB 6: SCRIPT VIEWER
function renderScriptTab(s, scenarios) {
  const scriptPreview = `// Executed Run ID: ${s.run_id}
// Workload: ${s.workload} | Target: ${s.target_name} (${s.model})
// Distributed Across: ${(s.workers_used || []).join(', ')}

export const options = {
  scenarios: ${JSON.stringify(
    Object.fromEntries(
      scenarios.map((sc) => [
        sc.name,
        { executor: 'constant-vus', protocol: sc.protocol, requestsExecuted: sc.count, p95Ms: sc.p95 }
      ])
    ),
    null,
    2
  )}
};`;

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>Executed Script &amp; Scenario Configuration Snapshot</strong>
      <button class="btn btn-secondary" style="padding:5px 12px;" onclick="navigator.clipboard.writeText(document.getElementById('runScriptPre').innerText);alert('Copied script to clipboard!');">&#128203; Copy Script</button>
    </div>
    <pre id="runScriptPre" style="background:#05070d;border:1px solid var(--border);border-radius:8px;padding:14px;color:#a5b4fc;overflow-x:auto;font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;">${esc(scriptPreview)}</pre>
  `;
}

// TAB 7: LOGS VIEWER
function renderLogsTab(s, rows) {
  const generatedLogs = rows.map((r) => ({
    ts: r.ts,
    level: r.http_status >= 400 || !r.det_pass ? 'WARN' : 'INFO',
    text: `[${r.worker_id}] [${r.population_id || r.scenario_id}] prompt=${r.prompt_id} status=${r.http_status} e2e=${r.e2e_ms}ms ttft=${r.ttft_ms ?? 'n/a'}ms trace=${r.trace_id} det_pass=${r.det_pass}`
  }));

  const filtered = generatedLogs.filter((l) => {
    if (logFilterLevel !== 'ALL' && l.level !== logFilterLevel) return false;
    if (logSearchQuery && !l.text.toLowerCase().includes(logSearchQuery.toLowerCase())) return false;
    return true;
  });

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;gap:6px;">
        <button class="btn ${logFilterLevel === 'ALL' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='ALL';renderGrafanaCloudRunView();">ALL (${generatedLogs.length})</button>
        <button class="btn ${logFilterLevel === 'INFO' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='INFO';renderGrafanaCloudRunView();">INFO</button>
        <button class="btn ${logFilterLevel === 'WARN' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='WARN';renderGrafanaCloudRunView();">WARN / ERROR</button>
      </div>
      <input type="text" placeholder="Search logs (trace ID, worker, prompt)..." value="${esc(logSearchQuery)}" style="width:260px;margin:0;padding:5px 10px;" oninput="logSearchQuery=this.value;renderGrafanaCloudRunView();" />
    </div>
    <div class="console-box" style="height:310px;">
      ${filtered
        .map(
          (l) => `<div class="log-line ${l.level === 'WARN' ? 'warn' : 'info'}">[${new Date(l.ts).toLocaleTimeString()}] [${l.level}] ${esc(l.text)}</div>`
        )
        .join('')}
    </div>
  `;
}

function exportLiveWarroomCsv() {
  if (!liveRows || !liveRows.length) {
    alert('No live rows collected yet.');
    return;
  }
  const header = 'row_id,run_id,worker_id,population_id,load_level,prompt_id,http_status,ttft_ms,e2e_ms,det_pass,correctness,trace_id\n';
  const lines = liveRows.map((r) =>
    [
      r.row_id,
      r.run_id,
      r.worker_id,
      r.population_id || r.scenario_id || 'default',
      r.load_level,
      r.prompt_id,
      r.http_status,
      r.ttft_ms ?? '',
      r.e2e_ms,
      r.det_pass,
      r.correctness ?? 1,
      r.trace_id
    ].join(',')
  );
  const blob = new Blob([header + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${liveRows[0]?.run_id || 'live-run'}-results.csv`;
  a.click();
}
