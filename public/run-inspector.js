// public/run-inspector.js
// Full Grafana Cloud k6 Run View with Separate Result Counters (Normal k6 vs AI Agent),
// Dynamic Multi-CSV ZIP Export & Inspector, Time-Bucketed Charts, and N-Injector Telemetry

let currentRunData = null;
let currentExportBundle = null;
let selectedExportCsvFile = 'metrics.csv';
let runCounterMode = 'auto'; // 'auto' | 'k6' | 'ai'
let activeSubTab = 'thresholds';
let overviewCollapsed = false;
let overviewSeries = { vus: true, rps: true, e2e: true, ttft: true, errors: false };
let expandedThresholdIdx = 0;
let checksViewMode = 'list'; // 'list' | 'tree'
let checksFilterStatus = 'all';
let checksSearchText = '';
let httpMethodFilter = 'ALL';
let httpSearchText = '';
let httpScenarioFilter = 'ALL';
let expandedHttpGroupIdx = 0;
let httpChartMode = 'overview'; // 'overview' | 'rps' | 'latency' | 'percentiles' | 'timing'
let analysisSelectedMetrics = ['e2e_ms', 'ttft_ms', 'planning_ms'];
let logFilterLevel = 'ALL';
let logSearchQuery = '';

// Sample standard deviation (n - 1), unified with server/stats-engine.mjs
function calcStdDev(arr) {
  if (!arr || arr.length <= 1) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (arr.length - 1);
  return Math.round(Math.sqrt(variance));
}

function calcPct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function selectRunDetail(runId) {
  selectedRunId = runId;
  currentExportBundle = null;
  runCounterMode = 'auto';
  renderRunsList(overviewState?.runs || []);

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  currentRunData = await res.json();
  // Pre-fetch export file metadata so dynamic CSV count is accurate
  try {
    const expRes = await fetch(`/api/runs/${encodeURIComponent(runId)}/export-files`);
    currentExportBundle = await expRes.json();
    selectedExportCsvFile = 'metrics.csv';
  } catch (_) {}
  renderGrafanaCloudRunView();
}

function inspectRunTurnByIndex(idx) {
  const row = currentRunData?.rows?.[idx];
  if (row && typeof inspectTurnRow === 'function') {
    inspectTurnRow(row);
  }
}

function setRunCounterMode(mode) {
  runCounterMode = mode;
  renderGrafanaCloudRunView();
}

async function setRunSubTab(tab) {
  activeSubTab = tab;
  if (tab === 'csv_bundle' && !currentExportBundle && currentRunData?.summary?.run_id) {
    const res = await fetch(`/api/runs/${encodeURIComponent(currentRunData.summary.run_id)}/export-files`);
    currentExportBundle = await res.json();
    selectedExportCsvFile = 'metrics.csv';
  }
  renderGrafanaCloudRunView();
}

function selectExportCsvFileName(fileName) {
  selectedExportCsvFile = fileName;
  renderGrafanaCloudRunView();
}

function downloadSingleExportCsv(fileName) {
  if (!currentExportBundle?.files?.[fileName]) return;
  const content = currentExportBundle.files[fileName];
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
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
      { id: 1, title: 'E2E / HTTP Response Time (p95)', type: 'timeseries', targets: [{ expr: 'http_req_duration_p95', runId: s.run_id }] },
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
    const workerMap = {};
    for (const x of list) {
      const w = x.worker_id || 'EC2-Worker-01';
      workerMap[w] = (workerMap[w] || 0) + 1;
    }
    const splitStr = Object.entries(workerMap)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    const tsList = list.map((x) => new Date(x.ts).getTime()).filter((t) => !isNaN(t));
    const spanSec = tsList.length > 1 ? Math.max(1, (Math.max(...tsList) - Math.min(...tsList)) / 1000) : Math.max(1, list.length * 0.25);
    result.push({
      name,
      protocol: list[0]?.protocol || (list[0]?.ttft_ms ? 'SSE' : 'HTTP'),
      count: list.length,
      failed,
      p95: Math.round(calcPct(e2es, 95)),
      avg: Math.round(e2es.reduce((a, b) => a + b, 0) / Math.max(1, e2es.length)),
      rps: Number((list.length / spanSec).toFixed(2)),
      injectorSplit: splitStr
    });
  }
  return result;
}

function buildChecksDataset(rows = []) {
  const checkMap = new Map();
  for (const r of rows) {
    const scen = r.population_id || r.scenario_id || 'default_scenario';
    const grp = `::UserFlow - ${r.category || scen}`;
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

function renderSeparateResultCountersHtml(s, rows, scenarios, checksList, durationSec, avgRps, peakVus, effectiveMode) {
  const e2es = rows.map((r) => Number(r.e2e_ms || 0)).sort((a, b) => a - b);
  const stdDevMs = s.overall?.e2e_stdev_ms ?? calcStdDev(e2es);
  const failedReqs = rows.filter((r) => r.http_status >= 400 || r.completion_status !== 'completed').length;
  const k6c = s.k6_counters || {};
  const totalCheckPasses = checksList.reduce((acc, c) => acc + c.passes, 0);
  const totalCheckAll = checksList.reduce((acc, c) => acc + c.total, 0);
  const checkPassRatePct = totalCheckAll ? ((totalCheckPasses / totalCheckAll) * 100).toFixed(2) : '100.00';

  if (effectiveMode === 'k6') {
    const iterCount = k6c.iterations ?? rows.length;
    const iterP95 = k6c.iteration_duration_p95_ms != null ? `${k6c.iteration_duration_p95_ms} ms` : 'n/a';
    const grpP95 = k6c.group_duration_p95_ms != null ? `${k6c.group_duration_p95_ms} ms` : 'n/a';
    const dataRecvText = k6c.data_received_bytes != null ? `${(k6c.data_received_bytes / 1024).toFixed(1)} KB` : 'n/a';
    const dataSentText = k6c.data_sent_bytes != null ? `${(k6c.data_sent_bytes / 1024).toFixed(1)} KB` : 'n/a';
    const cpuMean = k6c.load_generator_cpu_avg_pct != null ? `${k6c.load_generator_cpu_avg_pct}%` : 'n/a';
    const memMean = k6c.load_generator_mem_avg_pct != null ? `${k6c.load_generator_mem_avg_pct}%` : 'n/a';
    const handlesVal = k6c.load_generator_file_handles != null ? k6c.load_generator_file_handles : 'n/a';

    return `
      <div class="grid-4" style="margin-bottom:10px;">
        <div class="stat-card" style="border-left:3px solid #f97316;" title="Total HTTP requests executed and average requests per second">
          <div class="stat-label">&#9889; HTTP_REQS &amp; THROUGHPUT</div>
          <div class="stat-value">${rows.length} reqs</div>
          <div class="stat-sub">Avg Rate: <strong>${avgRps} reqs/s</strong> &bull; Peak VUs: <strong>${peakVus}</strong></div>
        </div>
        <div class="stat-card" style="border-left:3px solid #38bdf8;" title="Completed VU scenario iterations and measured 95th percentile iteration duration">
          <div class="stat-label">&#9889; ITERATIONS &amp; ITERATION_DURATION</div>
          <div class="stat-value">${iterCount} iters</div>
          <div class="stat-sub">Iteration P95: <strong>${iterP95}</strong> &bull; ${scenarios.length} scenario(s)</div>
        </div>
        <div class="stat-card" style="border-left:3px solid #a855f7;" title="95th percentile, median, and sample standard deviation (n-1) of HTTP request duration">
          <div class="stat-label">&#9889; HTTP_REQ_DURATION (P95 / MEDIAN)</div>
          <div class="stat-value">${s.overall?.e2e_p95_ms ?? 0} ms</div>
          <div class="stat-sub">Median: <strong>${s.overall?.e2e_p50_ms ?? 0} ms</strong> &bull; Stdev (n-1): <strong>${stdDevMs} ms</strong></div>
        </div>
        <div class="stat-card" style="border-left:3px solid ${failedReqs > 0 ? '#ef4444' : '#10b981'};" title="Count and rate of HTTP requests returning status >= 400 or network error">
          <div class="stat-label">&#9889; HTTP_REQ_FAILED (NZ_COUNT)</div>
          <div class="stat-value" style="color:${failedReqs > 0 ? 'var(--red)' : 'var(--green)'};">${failedReqs} failed</div>
          <div class="stat-sub">Failure Rate: <strong>${((failedReqs / Math.max(1, rows.length)) * 100).toFixed(2)}%</strong></div>
        </div>
      </div>
      <div class="grid-4" style="margin-bottom:16px;">
        <div class="stat-card" title="Measured 95th percentile duration of k6 group() blocks">
          <div class="stat-label">GROUP_DURATION (P95)</div>
          <div class="stat-value">${grpP95}</div>
          <div class="stat-sub">User-Flow Group P95 across ${scenarios.length} flow(s)</div>
        </div>
        <div class="stat-card" title="Percentage of check() assertions that evaluated to true">
          <div class="stat-label">CHECKS PASS RATE (NZ_COUNT / COUNT)</div>
          <div class="stat-value" style="color:var(--green);">${checkPassRatePct}%</div>
          <div class="stat-sub">${totalCheckPasses} / ${totalCheckAll} check assertions passed</div>
        </div>
        <div class="stat-card" title="Measured HTTP response and request payload bytes">
          <div class="stat-label">NETWORK I/O (DATA_RECEIVED / SENT)</div>
          <div class="stat-value">${dataRecvText}</div>
          <div class="stat-sub">Sent: <strong>${dataSentText}</strong> (${rows.length} HTTP payloads)</div>
        </div>
        <div class="stat-card" title="Measured OS CPU utilization, RAM utilization, and active handles on load injectors">
          <div class="stat-label">LOAD GENERATOR OS GAUGES</div>
          <div class="stat-value">CPU ${cpuMean}</div>
          <div class="stat-sub">Memory: <strong>${memMean}</strong> &bull; Handles: <strong>${handlesVal}</strong></div>
        </div>
      </div>
    `;
  }

  // AI AGENT RESULT COUNTERS MODE
  const stageTimings = s.overall?.stage_timings_ms || s.levels?.[0]?.stage_timings_ms || null;
  const stagePlan = stageTimings?.planning_avg != null ? `${stageTimings.planning_avg}ms` : 'n/a';
  const stageTools = stageTimings?.tools_avg != null ? `${stageTimings.tools_avg} ms` : 'n/a';
  const stageSynth = stageTimings?.synthesis_avg != null ? `${stageTimings.synthesis_avg}ms` : 'n/a';

  return `
    <div class="grid-4" style="margin-bottom:10px;">
      <div class="stat-card" style="border-left:3px solid #6366f1;" title="Total AI turns executed and average turns per second">
        <div class="stat-label">&#129302; AI TURNS &amp; PROMPT THROUGHPUT</div>
        <div class="stat-value">${rows.length} turns</div>
        <div class="stat-sub">Avg Rate: <strong>${avgRps} turns/s</strong> &bull; Peak Concurrency: <strong>${peakVus} VUs</strong></div>
      </div>
      <div class="stat-card" style="border-left:3px solid #06b6d4;" title="End-to-end AI agent turn latency percentiles and sample standard deviation (n-1)">
        <div class="stat-label">&#129302; AGENT E2E LATENCY (P95 / P50)</div>
        <div class="stat-value">${s.overall?.e2e_p95_ms ?? 0} ms</div>
        <div class="stat-sub">Median P50: <strong>${s.overall?.e2e_p50_ms ?? 0} ms</strong> &bull; Stdev: <strong>${stdDevMs} ms</strong></div>
      </div>
      <div class="stat-card" style="border-left:3px solid #10b981;" title="Measured Time to First Token (TTFT) from streaming response chunks">
        <div class="stat-label">&#129302; TIME TO FIRST TOKEN (TTFT P95)</div>
        <div class="stat-value">${s.overall?.ttft_p95_ms != null ? s.overall.ttft_p95_ms + ' ms' : 'n/a'}</div>
        <div class="stat-sub">TTFT P50: <strong>${s.overall?.ttft_p50_ms != null ? s.overall.ttft_p50_ms + ' ms' : 'n/a'}</strong></div>
      </div>
      <div class="stat-card" style="border-left:3px solid #22c55e;" title="Deterministic check pass rate and completion rate">
        <div class="stat-label">&#129302; COMPLETION &amp; DET. CHECK PASS %</div>
        <div class="stat-value" style="color:var(--green);">${((s.overall?.deterministic_pass_rate || 0) * 100).toFixed(1)}%</div>
        <div class="stat-sub">Completion Rate: <strong>${((s.overall?.completion_rate || 0) * 100).toFixed(1)}%</strong></div>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:16px;">
      <div class="stat-card" title="Lexical correctness and RAG context groundedness scores (0.00 to 1.00)">
        <div class="stat-label">LEXICAL CORRECTNESS &amp; GROUNDEDNESS</div>
        <div class="stat-value">${(s.overall?.correctness_avg ?? 0).toFixed(2)}</div>
        <div class="stat-sub">Groundedness Avg: <strong>${(s.overall?.groundedness_avg ?? 0).toFixed(2)}</strong> (0.00 - 1.00)</div>
      </div>
      <div class="stat-card" title="Quality Drop Under Load (percentage drop in correctness from baseline)">
        <div class="stat-label">QUALITY DROP UNDER LOAD (QDUL %)</div>
        <div class="stat-value" style="color:${(s.overall?.qdul_pct_max || 0) > 10 ? 'var(--red)' : 'var(--green)'};">${s.overall?.qdul_pct_max ?? 0}%</div>
        <div class="stat-sub">Degradation from low-load baseline quality</div>
      </div>
      <div class="stat-card" title="Server-reported stage timings for Planning, Tool Execution, and Synthesis">
        <div class="stat-label">AGENT STAGE TIMINGS (AVG)</div>
        <div class="stat-value" style="font-size:15px;">Plan ${stagePlan} | Synth ${stageSynth}</div>
        <div class="stat-sub">Tool Execution Avg: <strong>${stageTools}</strong></div>
      </div>
      <div class="stat-card" title="Maximum tested concurrency level that satisfied all latency and quality SLOs">
        <div class="stat-label">CAPACITY SLO CEILING</div>
        <div class="stat-value" style="color:var(--indigo);">${s.capacity?.max_passing_level ? 'Level ' + s.capacity.max_passing_level : 'Level ' + peakVus}</div>
        <div class="stat-sub">${esc(s.capacity?.broke_reason || 'All tested levels met SLO')}</div>
      </div>
    </div>
  `;
}

function renderStageBreakdownBox(st) {
  if (!st) {
    return `<div style="color:var(--text-2);padding:16px;background:var(--bg-2);border-radius:8px;">No server stage timings reported for this run.</div>`;
  }
  const total = Math.max(1, (st.planning_avg || 0) + (st.tools_avg || 0) + (st.synthesis_avg || 0));
  const pPct = Math.round(((st.planning_avg || 0) / total) * 100);
  const tPct = Math.round(((st.tools_avg || 0) / total) * 100);
  const sPct = Math.max(0, 100 - pPct - tPct);

  return `
    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;">
      <div style="display:flex;height:22px;border-radius:6px;overflow:hidden;margin-bottom:12px;">
        <div style="width:${pPct}%;background:#6366f1;" title="Planning"></div>
        <div style="width:${tPct}%;background:#f59e0b;" title="Tools"></div>
        <div style="width:${sPct}%;background:#10b981;" title="Synthesis"></div>
      </div>
      <div class="grid-3">
        <div><span style="color:#818cf8;">&#9632;</span> Planning: <strong>${st.planning_avg} ms</strong> (${pPct}%)</div>
        <div><span style="color:#fbbf24;">&#9632;</span> Tool Calls: <strong>${st.tools_avg} ms</strong> (${tPct}%)</div>
        <div><span style="color:#34d399;">&#9632;</span> Synthesis: <strong>${st.synthesis_avg} ms</strong> (${sPct}%)</div>
      </div>
    </div>
  `;
}

function renderGrafanaCloudRunView() {
  if (!currentRunData?.summary) return;
  const s = currentRunData.summary;
  const rows = currentRunData.rows || [];
  const pane = document.getElementById('runDetailPane');

  const detectedType = s.counter_profile || s.run_type || (String(s.run_id).startsWith('K6_') || String(s.run_id).startsWith('POP_') ? 'k6' : 'ai');
  const effectiveMode = runCounterMode === 'auto' ? detectedType : runCounterMode;

  const scenarios = buildScenarioBreakdown(rows);
  const checksList = buildChecksDataset(rows);
  const httpGroups = buildHttpAggregates(rows);

  const totalChecksPass = checksList.reduce((acc, c) => acc + (c.fails === 0 ? 1 : 0), 0);
  const thresholdsList = s.gate?.results || [];
  const passedThresholds = thresholdsList.filter((t) => t.status === 'PASS').length;
  const failedReqs = rows.filter((r) => r.http_status >= 400 || r.completion_status !== 'completed').length;

  const tsList = rows.map((r) => new Date(r.ts).getTime()).filter((t) => !isNaN(t));
  const durationSec = tsList.length > 1 ? Math.max(1, Math.round((Math.max(...tsList) - Math.min(...tsList)) / 1000)) : 8;
  const avgRps = s.overall?.rps ?? Number((rows.length / durationSec).toFixed(2));
  const peakVus = Math.max(1, ...rows.map((r) => Number(r.load_level || 1)));
  const csvFileCount = currentExportBundle?.file_count || (currentExportBundle?.files ? Object.keys(currentExportBundle.files).length : 'Multi');
  const workersUsed = s.workers_used || ['EC2-Worker-01'];

  const otherRunsOpts = (overviewState?.runs || [])
    .filter((r) => r.run_id !== s.run_id)
    .map((r) => `<option value="${esc(r.run_id)}">Compare vs: ${esc(r.run_id)} (${r.overall?.e2e_p95_ms}ms)</option>`)
    .join('');

  pane.innerHTML = `
    <!-- 1. GRAFANA CLOUD K6 RUN HEADER & METADATA BAR -->
    <div class="card" style="padding:16px 20px;margin-bottom:14px;background:var(--run-header-bg);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-secondary" style="padding:4px 9px;font-size:14px;color:${s.starred ? '#f59e0b' : 'var(--text-2)'};" onclick="toggleStarRun()" title="Star this run for quick comparison">&#9733;</button>
            <h2 style="margin:0;font-size:19px;font-weight:800;">${esc(s.run_id)}</h2>
            <span class="badge ${detectedType === 'k6' ? 'badge-warn' : 'badge-info'}" style="font-size:11px;padding:4px 9px;">
              ${detectedType === 'k6' ? '&#9889; NORMAL k6 RUN' : '&#129302; AI AGENT RUN'}
            </span>
            <span class="badge ${s.status === 'ABORTED' ? 'badge-warn' : s.gate?.passed ? 'badge-pass' : 'badge-fail'}" style="font-size:11.5px;padding:4px 10px;">
              ${s.status === 'ABORTED' ? '&#9888; Aborted by User' : `&#10003; Finished &bull; ${s.gate?.passed ? 'Gates Passed' : 'Gates Failed'}`}
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;">
            <span class="pill" style="padding:3px 10px;">Engine: <strong>${esc(s.stream_engine || 'node-http-measured')}</strong></span>
            <span class="pill" style="padding:3px 10px;">Peak <strong>${peakVus} VUs</strong></span>
            <span class="pill" style="padding:3px 10px;">Duration <strong>${durationSec}s</strong></span>
            <span class="pill" style="padding:3px 10px;">&#127760; Load Injectors (${workersUsed.length}): <strong>${esc(workersUsed.join(' + '))}</strong></span>
            <span class="pill" style="padding:3px 10px;">Workload: <code>${esc(s.workload)}</code></span>
          </div>
          ${s.note ? `<div style="margin-top:8px;font-size:12px;color:var(--badge-warn-text);background:var(--badge-warn-bg);border:1px solid var(--badge-warn-border);padding:5px 10px;border-radius:6px;">&#128221; <strong>Note:</strong> ${esc(s.note)}</div>` : ''}
        </div>

        <!-- Action Toolbar (Dynamic Multi-CSV ZIP Export, JUnit XML, Prometheus, InfluxDB, Flat CSV, HTML, Compare) -->
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/export-zip" download="${esc(s.run_id)}-k6-export.zip" class="btn btn-success" style="text-decoration:none;padding:7px 12px;" title="Download Grafana Cloud k6 ZIP archive containing metrics.csv + per-metric CSV files">&#128230; Export k6 ZIP (${csvFileCount} CSVs)</a>
          <button class="btn btn-primary" onclick="setRunSubTab('csv_bundle')">&#128203; Browse ${csvFileCount} CSVs</button>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/csv" download="${esc(s.run_id)}-results.csv" class="btn btn-secondary" style="text-decoration:none;">&#128229; Flat CSV</a>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/junit.xml" download="${esc(s.run_id)}-junit.xml" class="btn btn-secondary" style="text-decoration:none;" title="Download JUnit XML for CI/CD pipelines">JUnit XML</a>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/export-prometheus" download="${esc(s.run_id)}-metrics.prom" class="btn btn-secondary" style="text-decoration:none;" title="Export Prometheus Exposition format">Prometheus</a>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/export-influx" download="${esc(s.run_id)}-influx.lp" class="btn btn-secondary" style="text-decoration:none;" title="Export InfluxDB Line Protocol">InfluxDB</a>
          <button class="btn btn-secondary" onclick="toggleExplainResults()">&#10024; Explain</button>
          <button class="btn btn-secondary" onclick="promptRunNote()">&#128221; Note</button>
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/html" target="_blank" class="btn btn-secondary" style="text-decoration:none;">&#128196; report.html</a>
          <select style="width:auto;margin:0;padding:7px 10px;" onchange="if(this.value) { document.getElementById('selCompareRef').value=this.value; document.getElementById('selCompareCand').value='${esc(s.run_id)}'; switchTab('compare'); runComparison(); }">
            <option value="">&#9878; Compare with run...</option>
            ${otherRunsOpts}
          </select>
        </div>
      </div>

      <!-- AI Explain Results Drawer -->
      <div id="aiExplainBanner" class="hidden" style="margin-top:14px;padding:14px;background:var(--badge-info-bg);border:1px solid var(--badge-info-border);border-radius:8px;">
        <div style="font-weight:700;color:var(--badge-info-text);margin-bottom:6px;">&#10024; Automated Performance &amp; Bottleneck Diagnosis</div>
        <div style="color:var(--text-1);font-size:12.5px;line-height:1.6;">
          &bull; <strong>Throughput &amp; Latency Summary:</strong> The system processed <strong>${rows.length} requests</strong> across <strong>${scenarios.length} scenario(s)/population(s)</strong> with a 95th percentile latency of <strong>${s.overall?.e2e_p95_ms} ms</strong> (median p50: <strong>${s.overall?.e2e_p50_ms} ms</strong>, sample stdev: <strong>${s.overall?.e2e_stdev_ms ?? 0} ms</strong>) and average throughput of <strong>${avgRps} req/s</strong>.<br/>
          &bull; <strong>Load Injector Balance:</strong> Load was distributed across <strong>${esc(workersUsed.join(', '))}</strong> (Measured CPU Avg: <strong>${s.k6_counters?.load_generator_cpu_avg_pct != null ? s.k6_counters.load_generator_cpu_avg_pct + '%' : 'n/a'}</strong>, Memory Avg: <strong>${s.k6_counters?.load_generator_mem_avg_pct != null ? s.k6_counters.load_generator_mem_avg_pct + '%' : 'n/a'}</strong>).<br/>
          &bull; <strong>Quality &amp; Gate Verdict:</strong> Deterministic checks passed at <strong>${((s.overall?.deterministic_pass_rate || 0) * 100).toFixed(1)}%</strong>, lexical correctness averaged <strong>${(s.overall?.correctness_avg ?? 0).toFixed(2)}</strong>, and max Quality Drop Under Load (QDUL) was <strong>${s.overall?.qdul_pct_max ?? 0}%</strong>.
        </div>
      </div>
    </div>

    <!-- 2. COLLAPSIBLE PERFORMANCE OVERVIEW BANNER, SEPARATE RESULT COUNTERS & SCENARIOS TABLE -->
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div style="font-size:13px;color:var(--text-1);cursor:pointer;" onclick="toggleOverviewAccordion()">
          <strong>PERFORMANCE OVERVIEW</strong> &mdash; <em>"The 95th percentile response time of the system being tested was <strong>${s.overall?.e2e_p95_ms ?? 0} ms</strong>, and <strong>${rows.length} requests</strong> were made at an average rate of <strong>${avgRps} requests/second</strong>."</em>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:var(--text-2);margin-right:4px;">Result Counter Profile:</span>
          <button class="btn ${effectiveMode === 'k6' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="setRunCounterMode('k6')">&#9889; Normal k6 Counters (HTTP / Iters / Network / OS Gauges)</button>
          <button class="btn ${effectiveMode === 'ai' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="setRunCounterMode('ai')">&#129302; AI Agent Counters (TTFT / Correctness / QDUL / Stages)</button>
          <button class="btn btn-secondary" style="padding:4px 9px;font-size:11px;" onclick="toggleOverviewAccordion()">${overviewCollapsed ? '&#9660; Expand' : '&#9650; Collapse'}</button>
        </div>
      </div>

      <div class="${overviewCollapsed ? 'hidden' : ''}" style="margin-top:14px;">
        <!-- Separate Result Counters -->
        ${renderSeparateResultCountersHtml(s, rows, scenarios, checksList, durationSec, avgRps, peakVus, effectiveMode)}

        <!-- Dual Y-Axis Multi-Metric Time-Bucketed Chart across Full Run Duration -->
        <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <strong style="font-size:12px;color:var(--text-1);">TIME-BUCKETED PERFORMANCE OVERVIEW (Full Run Duration: VUs / Measured RPS / P95 Response Time)</strong>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn ${overviewSeries.vus ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#94a3b8;" onclick="toggleOverviewSeries('vus')">&#9632; Active VUs</button>
              <button class="btn ${overviewSeries.rps ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#a855f7;color:#c084fc;" onclick="toggleOverviewSeries('rps')">&#9632; Measured RPS</button>
              <button class="btn ${overviewSeries.e2e ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#06b6d4;color:#22d3ee;" onclick="toggleOverviewSeries('e2e')">&#9632; ${effectiveMode === 'k6' ? 'http_req_duration (p95)' : 'Agent E2E Latency (p95)'}</button>
              <button class="btn ${overviewSeries.ttft ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#10b981;color:#34d399;" onclick="toggleOverviewSeries('ttft')">&#9632; ${effectiveMode === 'k6' ? 'http_req_waiting (p95)' : 'TTFT Streaming (p95)'}</button>
              <button class="btn ${overviewSeries.errors ? 'btn-secondary' : ''}" style="padding:3px 9px;font-size:11px;border-color:#ef4444;color:#f87171;" onclick="toggleOverviewSeries('errors')">&#9632; Error Rate</button>
            </div>
          </div>
          <div style="height:215px;">${renderDualAxisOverviewSvg(s, rows)}</div>
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
                <th>LOAD INJECTOR SPLIT</th>
                <th>REQUEST COUNT</th>
                <th>FAILED REQUESTS</th>
                <th>P95 RESPONSE TIME</th>
                <th>AVG RESPONSE TIME</th>
                <th>MEASURED RPS</th>
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
        <span class="badge badge-pass">TELEMETRY INSIGHTS</span>
        <span style="color:var(--text-1);font-size:12.5px;">
          ${failedReqs === 0 && s.gate?.passed
            ? 'All deterministic checks, HTTP expectations, and configured thresholds passed across all active Load Injectors.'
            : `${failedReqs} failed request(s) or threshold warnings detected — inspect Thresholds and HTTP tabs below.`}
        </span>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> CHECK PASS: <strong>${((s.overall?.deterministic_pass_rate || 0) * 100).toFixed(1)}%</strong></span>
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> COMPLETION: <strong>${((s.overall?.completion_rate || 0) * 100).toFixed(1)}%</strong></span>
        <span class="pill" style="padding:3px 10px;"><span class="dot"></span> INJECTORS: <strong>${workersUsed.length} Active</strong></span>
      </div>
    </div>

    <!-- 4. GRAFANA CLOUD K6 8 RUN SUB-TABS -->
    <div class="nav-tabs" style="padding:0 12px;border-radius:10px 10px 0 0;border:1px solid var(--border);border-bottom:none;">
      <div class="nav-tab ${activeSubTab === 'thresholds' ? 'active' : ''}" onclick="setRunSubTab('thresholds')">THRESHOLDS (${passedThresholds}/${thresholdsList.length})</div>
      <div class="nav-tab ${activeSubTab === 'checks' ? 'active' : ''}" onclick="setRunSubTab('checks')">CHECKS (${totalChecksPass}/${checksList.length})</div>
      <div class="nav-tab ${activeSubTab === 'http' ? 'active' : ''}" onclick="setRunSubTab('http')">HTTP &amp; TURNS (${rows.length})</div>
      <div class="nav-tab ${activeSubTab === 'csv_bundle' ? 'active' : ''}" onclick="setRunSubTab('csv_bundle')">&#128230; EXPORTED k6 CSVs (${csvFileCount} FILES)</div>
      <div class="nav-tab ${activeSubTab === 'analysis' ? 'active' : ''}" onclick="setRunSubTab('analysis')">ANALYSIS EXPLORER</div>
      <div class="nav-tab ${activeSubTab === 'injectors' ? 'active' : ''}" onclick="setRunSubTab('injectors')">LOAD INJECTORS &amp; TIMELINE (${workersUsed.length})</div>
      <div class="nav-tab ${activeSubTab === 'script' ? 'active' : ''}" onclick="setRunSubTab('script')">SCRIPT</div>
      <div class="nav-tab ${activeSubTab === 'logs' ? 'active' : ''}" onclick="setRunSubTab('logs')">LOGS</div>
    </div>

    <div class="card" style="border-radius:0 0 10px 10px;margin-top:0;">
      ${renderActiveRunSubTab(s, rows, scenarios, checksList, httpGroups, thresholdsList)}
    </div>
  `;
}

// Build time buckets on the fly if summary.time_series is not present
function getRunTimeBuckets(s, rows = []) {
  if (Array.isArray(s?.time_series) && s.time_series.length > 0) {
    return s.time_series;
  }
  if (!rows.length) return [];
  const timed = rows.map((r, i) => {
    const t = new Date(r.ts).getTime();
    return { r, tsMs: Number.isFinite(t) ? t : i * 500 };
  }).sort((a, b) => a.tsMs - b.tsMs);

  const minTs = timed[0].tsMs;
  const maxTs = timed[timed.length - 1].tsMs;
  const spanMs = Math.max(1000, maxTs - minTs);
  const bCount = Math.min(30, Math.max(4, Math.ceil(timed.length / 2)));
  const bWidthMs = spanMs / bCount;
  const bWidthSec = Math.max(0.25, bWidthMs / 1000);

  const buckets = [];
  for (let b = 0; b < bCount; b++) {
    const start = minTs + b * bWidthMs;
    const end = start + bWidthMs;
    const slice = timed.filter((x) => (b === bCount - 1 ? x.tsMs >= start && x.tsMs <= end : x.tsMs >= start && x.tsMs < end)).map((x) => x.r);
    if (!slice.length) continue;
    const e2es = slice.map((x) => Number(x.e2e_ms || 0)).sort((a, c) => a - c);
    const ttfts = slice.map((x) => Number(x.ttft_ms || 0)).filter((v) => v > 0).sort((a, c) => a - c);
    const errs = slice.filter((x) => Number(x.http_status ?? 200) >= 400).length;
    const byScenario = {};
    for (const x of slice) {
      const sc = x.population_id || x.scenario_id || x.category || 'default';
      byScenario[sc] = (byScenario[sc] || 0) + 1;
    }
    buckets.push({
      bucket: b + 1,
      elapsedSec: Math.round((start - minTs) / 1000),
      label: `+${Math.round((start - minTs) / 1000)}s`,
      requests: slice.length,
      rps: Number((slice.length / bWidthSec).toFixed(2)),
      activeVus: Math.max(1, ...slice.map((x) => Number(x.load_level || 1))),
      e2eP95: Math.round(calcPct(e2es, 95)),
      e2eAvg: Math.round(e2es.reduce((a, c) => a + c, 0) / slice.length),
      ttftP95: ttfts.length ? Math.round(calcPct(ttfts, 95)) : null,
      errorRate: Number(((errs / slice.length) * 100).toFixed(2)),
      byScenario
    });
  }
  return buckets;
}

function renderDualAxisOverviewSvg(s, rows = []) {
  const buckets = getRunTimeBuckets(s, rows);
  if (!buckets.length) {
    return `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-2);">No telemetry data points</div>`;
  }
  const w = 1160;
  const h = 198;
  const padL = 48;
  const padR = 52;
  const padT = 16;
  const padB = 26;

  const maxLat = Math.max(500, ...buckets.map((b) => Number(b.e2eP95 || 0))) * 1.15;
  const maxVuOrRps = Math.max(5, ...buckets.map((b) => Math.max(Number(b.activeVus || 1), Number(b.rps || 0)))) * 1.25;

  const xFor = (i) => padL + (buckets.length === 1 ? (w - padL - padR) / 2 : (i / (buckets.length - 1)) * (w - padL - padR));
  const yLat = (val) => padT + (1 - Math.min(1, val / maxLat)) * (h - padT - padB);
  const yVu = (val) => padT + (1 - Math.min(1, val / maxVuOrRps)) * (h - padT - padB);

  const vuPoly = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yVu(b.activeVus || 1).toFixed(1)}`).join(' ');
  const rpsPoly = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yVu(b.rps || 0).toFixed(1)}`).join(' ');
  const e2ePoly = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yLat(b.e2eP95 || 0).toFixed(1)}`).join(' ');
  const hasTtft = buckets.some((b) => b.ttftP95 != null);
  const ttftPoly = hasTtft
    ? buckets.map((b, i) => `${xFor(i).toFixed(1)},${yLat(b.ttftP95 || 0).toFixed(1)}`).join(' ')
    : '';
  const errPoly = buckets.map((b, i) => `${xFor(i).toFixed(1)},${yVu(((b.errorRate || 0) / 100) * maxVuOrRps).toFixed(1)}`).join(' ');

  const firstLabel = buckets[0]?.label || '+0s';
  const midLabel = buckets[Math.floor(buckets.length / 2)]?.label || '';
  const lastLabel = buckets[buckets.length - 1]?.label || '';

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
      <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />

      <!-- Left Axis: VUs / Measured RPS -->
      <text x="4" y="${padT + 6}" fill="var(--chart-text)" font-size="10">${Math.round(maxVuOrRps)} VUs/RPS</text>
      <text x="4" y="${h - padB}" fill="var(--chart-text)" font-size="10">0</text>

      <!-- Right Axis: Response Time ms -->
      <text x="${w - padR + 4}" y="${padT + 6}" fill="var(--cyan)" font-size="10">${Math.round(maxLat)}ms</text>
      <text x="${w - padR + 4}" y="${(padT + h - padB) / 2 + 4}" fill="var(--cyan)" font-size="10">${Math.round(maxLat / 2)}ms</text>

      <!-- Time Bucket X-Axis Labels across full run duration -->
      <text x="${padL}" y="${h - 6}" fill="var(--chart-text)" font-size="10">${esc(firstLabel)}</text>
      <text x="${(padL + w - padR) / 2}" y="${h - 6}" fill="var(--chart-text)" font-size="10">${esc(midLabel)}</text>
      <text x="${w - padR - 45}" y="${h - 6}" fill="var(--chart-text)" font-size="10">${esc(lastLabel)} (${rows.length} reqs)</text>

      ${overviewSeries.vus ? `<polyline fill="none" stroke="var(--chart-text)" stroke-width="2" stroke-dasharray="3,3" points="${vuPoly}" />` : ''}
      ${overviewSeries.rps ? `<polyline fill="none" stroke="#9333ea" stroke-width="2" points="${rpsPoly}" />` : ''}
      ${overviewSeries.e2e ? `<polyline fill="none" stroke="#0891b2" stroke-width="2.5" points="${e2ePoly}" />` : ''}
      ${overviewSeries.ttft && ttftPoly ? `<polyline fill="none" stroke="#059669" stroke-width="2" points="${ttftPoly}" />` : ''}
      ${overviewSeries.errors ? `<polyline fill="none" stroke="#dc2626" stroke-width="2" points="${errPoly}" />` : ''}
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
  if (activeSubTab === 'csv_bundle') {
    return renderExportedCsvBundleTab(s);
  }
  if (activeSubTab === 'analysis') {
    return renderAnalysisTab(s, rows);
  }
  if (activeSubTab === 'injectors') {
    return renderInjectorsProfileTab(s, rows, scenarios);
  }
  if (activeSubTab === 'script') {
    return renderScriptTab(s, scenarios);
  }
  return renderLogsTab(s, rows);
}

// TAB: EXPORTED k6 CSV BUNDLE (DYNAMICALLY BUILT FROM MEASURED METRICS)
function renderExportedCsvBundleTab(s) {
  if (!currentExportBundle || !currentExportBundle.files) {
    return `<div style="padding:24px;color:var(--text-2);">Generating Grafana Cloud k6 Multi-CSV export bundle...</div>`;
  }
  const fileNames = Object.keys(currentExportBundle.files);
  const currentCsvText = currentExportBundle.files[selectedExportCsvFile] || '';
  const lines = currentCsvText.trim().split('\n').filter(Boolean);
  const headers = lines.length ? parseSimpleCsvRow(lines[0]) : [];
  const dataRows = lines.slice(1, 150).map(parseSimpleCsvRow);

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div>
        <strong style="font-size:13.5px;">Grafana Cloud k6 Multi-CSV Export Bundle (${fileNames.length} Files Dynamically Generated)</strong>
        <div style="font-size:11.5px;color:var(--text-2);margin-top:2px;">
          Built from actual measured metrics in this run: <code>metrics.csv</code> index + per-metric time-bucketed <code>metric_*.csv</code> files with sample <code>stdev</code> (<code>n - 1</code>).
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-secondary" onclick="downloadSingleExportCsv('${esc(selectedExportCsvFile)}')">&#128229; Download <code>${esc(selectedExportCsvFile)}</code></button>
        <a href="/api/runs/${encodeURIComponent(s.run_id)}/export-zip" download="${esc(s.run_id)}-k6-export.zip" class="btn btn-success" style="text-decoration:none;">&#128230; Download All ${fileNames.length} CSVs (.ZIP)</a>
      </div>
    </div>

    <div class="grid-2" style="grid-template-columns:290px 1fr;gap:14px;">
      <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:430px;overflow-y:auto;">
        <div style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;margin-bottom:8px;">Files in ${esc(s.run_id)}-k6-export.zip (${fileNames.length})</div>
        ${fileNames
          .map((fn) => {
            const rowCount = (currentExportBundle.files[fn].trim().split('\n').length || 1) - 1;
            const active = fn === selectedExportCsvFile;
            return `
              <div onclick="selectExportCsvFileName('${esc(fn)}')" style="padding:7px 10px;border-radius:6px;cursor:pointer;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;background:${active ? 'var(--badge-info-bg)' : 'transparent'};border:1px solid ${active ? 'var(--indigo)' : 'transparent'};">
                <code style="font-size:11.5px;color:${active ? 'var(--badge-info-text)' : 'var(--text-1)'};font-weight:${active ? '700' : '400'};word-break:break-all;">${esc(fn)}</code>
                <span class="badge ${fn === 'metrics.csv' ? 'badge-warn' : 'badge-info'}" style="font-size:10px;">${rowCount}r</span>
              </div>
            `;
          })
          .join('')}
      </div>

      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div><strong>Previewing: <code>${esc(selectedExportCsvFile)}</code></strong> <span style="color:var(--text-2);font-size:11.5px;">(${lines.length - 1} data rows)</span></div>
        </div>
        <div class="table-wrap" style="max-height:395px;overflow:auto;">
          <table>
            <thead>
              <tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${dataRows
                .map(
                  (cols) => `
                <tr>
                  ${cols.map((c) => `<td style="font-family:'JetBrains Mono',Consolas,monospace;font-size:11.5px;">${esc(c)}</td>`).join('')}
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function parseSimpleCsvRow(line) {
  const res = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      res.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  res.push(cur);
  return res;
}

// TAB 1: THRESHOLDS (REAL ROW PASS/FAIL COUNTS + SOURCE BADGE + FULL-DURATION TIME SERIES)
function renderThresholdsTab(s, rows, thresholdsList) {
  const rowsHtml = thresholdsList
    .map((g, idx) => {
      const isExpanded = expandedThresholdIdx === idx;
      const passCount = g.passes != null ? g.passes : (g.status === 'PASS' ? rows.length : 0);
      const failCount = g.fails != null ? g.fails : (g.status === 'PASS' ? 0 : rows.length - passCount);
      const srcBadge = g.source === 'k6-script'
        ? '<span class="badge badge-warn">k6 options.thresholds</span>'
        : '<span class="badge badge-info">gates.json</span>';
      return `
        <tr style="cursor:pointer;background:${isExpanded ? 'rgba(99,102,241,0.08)' : 'transparent'};" onclick="expandedThresholdIdx = (expandedThresholdIdx === ${idx} ? null : ${idx}); renderGrafanaCloudRunView();">
          <td><span class="badge ${g.status === 'PASS' ? 'badge-pass' : g.status === 'FAIL' ? 'badge-fail' : 'badge-warn'}">${g.status}</span></td>
          <td><strong><code>${esc(g.rawMetric || g.metric)}</code></strong> <span style="color:var(--text-2);font-size:11px;">(${esc(g.label || '')})</span></td>
          <td>${srcBadge}</td>
          <td><strong>${g.actual ?? 'n/a'}</strong></td>
          <td><code>${esc(g.metric)} ${esc(g.op)} ${esc(g.value)}</code></td>
          <td style="color:var(--green);font-weight:700;">${passCount}</td>
          <td style="color:${failCount > 0 ? 'var(--red)' : 'var(--text-2)'};font-weight:700;">${failCount}</td>
        </tr>
        ${
          isExpanded
            ? `<tr>
                <td colspan="7" style="background:var(--bg-0);padding:14px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <strong style="font-size:12px;">Threshold Time-Series Across Full Run: <code>${esc(g.metric)}</code> vs Target Boundary (<code>${esc(g.op)} ${esc(g.value)}</code>)</strong>
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
      <div style="font-size:12.5px;color:var(--text-1);">Evaluates both <code>options.thresholds</code> from your k6 script and release gates from <code>gates.json</code> with exact per-row pass/fail counts.</div>
      <button class="btn btn-secondary" style="padding:5px 11px;font-size:11.5px;" onclick="reprocessRun('${esc(s.run_id)}')">&#8635; Re-Evaluate Thresholds &amp; Gates</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>STATUS</th>
            <th>NAME</th>
            <th>SOURCE</th>
            <th>ACTUAL VALUE</th>
            <th>THRESHOLD EXPRESSION</th>
            <th>ROW PASSES</th>
            <th>ROW FAILS</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderThresholdInlineChart(rows, gate) {
  const pts = rows;
  if (!pts.length) return '';
  const w = 1120;
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
      <line x1="${padL}" y1="${yThresh}" x2="${w - padR}" y2="${yThresh}" stroke="var(--red)" stroke-width="1.8" stroke-dasharray="5,4" />
      <text x="${w - padR - 150}" y="${Math.max(12, yThresh - 5)}" fill="var(--red)" font-size="10.5" font-weight="700">Threshold: ${esc(gate.op)} ${esc(gate.value)}</text>
      <polyline fill="none" stroke="var(--cyan)" stroke-width="2.3" points="${poly}" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />
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

// TAB 3: HTTP & AI TURNS (10 STATISTICAL COLUMNS + SAFE TURN INSPECTOR BY INDEX)
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
                      <span style="color:var(--text-2);font-size:11.5px;margin-left:8px;">Avg: ${g.avg}ms | Stdev (n-1): ${g.stddev}ms | P90: ${g.p90}ms | P95: ${g.p95}ms | P99: ${g.p99}ms</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style="font-size:11.5px;color:var(--text-2);">Metric View:</span>
                      <select style="width:auto;margin:0;padding:5px 10px;" onchange="httpChartMode=this.value;renderGrafanaCloudRunView();" onclick="event.stopPropagation();">
                        <option value="overview" ${httpChartMode === 'overview' ? 'selected' : ''}>1. Performance overview (VUs + Latency)</option>
                        <option value="percentiles" ${httpChartMode === 'percentiles' ? 'selected' : ''}>2. Response time percentiles (P90, P95, P99)</option>
                        <option value="timing" ${httpChartMode === 'timing' ? 'selected' : ''}>3. Timing breakdown (Planning / Waiting TTFT / Tools / Synthesis)</option>
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
    .map(
      (r, idx) => `
      <tr style="cursor:pointer;" onclick="inspectRunTurnByIndex(${idx})">
        <td><span class="badge ${String(r.worker_id).includes('01') ? 'badge-warn' : 'badge-info'}">${esc(r.worker_id)}</span></td>
        <td><code>${esc(r.population_id || r.scenario_id || 'default')}</code></td>
        <td><code>${esc(r.prompt_id)}</code></td>
        <td><span class="badge ${r.http_status === 200 ? 'badge-pass' : 'badge-fail'}">${r.http_status}</span></td>
        <td>${r.ttft_ms != null ? r.ttft_ms + ' ms' : 'n/a'}</td>
        <td><strong>${r.e2e_ms} ms</strong></td>
        <td>${r.res_bytes != null ? r.res_bytes + ' B' : 'n/a'}</td>
        <td><span class="badge ${r.det_pass ? 'badge-pass' : 'badge-fail'}">${r.det_pass ? 'PASS' : 'FAIL'}</span></td>
        <td style="max-width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.answer)}</td>
      </tr>`
    )
    .join('');

  return `
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
            <th>STDDEV (n-1)</th>
            <th>P95</th>
            <th>P99</th>
            <th>MAX</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

    <h3 class="card-title" style="margin-bottom:8px;">Individual Executed Requests / AI Turns (${rows.length} rows &mdash; Click any row for full AI Answer &amp; Trace)</h3>
    <div class="table-wrap" style="max-height:310px;overflow-y:auto;">
      <table>
        <thead>
          <tr>
            <th>INJECTOR NODE</th>
            <th>POPULATION / SCENARIO</th>
            <th>PROMPT / FLOW ID</th>
            <th>HTTP</th>
            <th>WAITING (TTFT)</th>
            <th>DURATION (E2E)</th>
            <th>BYTES</th>
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
    const planVals = pts.map((r) => r.server_timing?.planning_ms).filter((v) => v != null).map(Number);
    const waitVals = pts.map((r) => r.ttft_ms).filter((v) => v != null).map(Number);
    const toolsVals = pts.map((r) => r.server_timing?.tools_ms).filter((v) => v != null).map(Number);
    const synthVals = pts.map((r) => r.server_timing?.synthesis_ms).filter((v) => v != null).map(Number);

    const planAvg = planVals.length ? Math.round(planVals.reduce((a, b) => a + b, 0) / planVals.length) : 0;
    const waitAvg = waitVals.length ? Math.round(waitVals.reduce((a, b) => a + b, 0) / waitVals.length) : 0;
    const toolsAvg = toolsVals.length ? Math.round(toolsVals.reduce((a, b) => a + b, 0) / toolsVals.length) : 0;
    const synthAvg = synthVals.length ? Math.round(synthVals.reduce((a, b) => a + b, 0) / synthVals.length) : 0;
    const total = Math.max(1, planAvg + toolsAvg + synthAvg);
    const pPct = Math.round((planAvg / total) * 100);
    const tPct = Math.round((toolsAvg / total) * 100);
    const sPct = Math.max(5, 100 - pPct - tPct);

    return `
      <div style="padding:14px;background:var(--bg-1);border-radius:8px;">
        <div style="font-size:12px;margin-bottom:10px;color:var(--text-1);"><strong>Measured Timing Breakdown (Phases: Planning / Waiting TTFT / Tool Execution / Synthesis)</strong></div>
        <div style="display:flex;height:28px;border-radius:6px;overflow:hidden;margin-bottom:14px;">
          <div style="width:${pPct}%;background:#6366f1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">Plan ${planAvg}ms</div>
          <div style="width:${tPct}%;background:#f59e0b;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;">Tools ${toolsAvg}ms</div>
          <div style="width:${sPct}%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">Synthesis ${synthAvg}ms</div>
        </div>
        <div class="grid-4">
          <div><span style="color:#818cf8;">&#9632;</span> Planning: <strong>${planAvg} ms</strong></div>
          <div><span style="color:#38bdf8;">&#9632;</span> Measured TTFT: <strong>${waitAvg} ms</strong></div>
          <div><span style="color:#fbbf24;">&#9632;</span> Tool Calls: <strong>${toolsAvg} ms</strong></div>
          <div><span style="color:#34d399;">&#9632;</span> Synthesis: <strong>${synthAvg} ms</strong></div>
        </div>
      </div>
    `;
  }

  const w = 1120;
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
      <line x1="${padL}" y1="${p99Y}" x2="${w - padR}" y2="${p99Y}" stroke="#db2777" stroke-dasharray="4,4" />
      <text x="${w - padR - 95}" y="${Math.max(12, p99Y - 4)}" fill="#db2777" font-size="10" font-weight="600">P99: ${group.p99}ms</text>
      <line x1="${padL}" y1="${p95Y}" x2="${w - padR}" y2="${p95Y}" stroke="var(--amber)" stroke-dasharray="4,4" />
      <text x="${w - padR - 95}" y="${Math.max(24, p95Y - 4)}" fill="var(--amber)" font-size="10" font-weight="600">P95: ${group.p95}ms</text>
      <polyline fill="none" stroke="var(--cyan)" stroke-width="2.4" points="${e2ePoly}" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />
    </svg>
  `;
}

// TAB 4: ANALYSIS EXPLORER (AUTO-DISCOVERS CUSTOM METRICS + PLOTS FULL RUN DURATION)
function renderAnalysisTab(s, rows) {
  const palette = ['#06b6d4', '#8b5cf6', '#14b8a6', '#f43f5e', '#84cc16'];
  const customKeys = Object.keys(s.custom_metrics || {});
  const metricDefs = [
    { key: 'e2e_ms', label: 'http_req_duration / agent_e2e (ms)', color: '#f97316' },
    { key: 'ttft_ms', label: 'http_req_waiting / ttft (ms)', color: '#10b981' },
    { key: 'planning_ms', label: 'stage_planning_duration (ms)', color: '#6366f1' },
    { key: 'tools_ms', label: 'stage_tools_duration (ms)', color: '#f59e0b' },
    { key: 'synthesis_ms', label: 'stage_synthesis_duration (ms)', color: '#ec4899' },
    ...customKeys.map((ck, idx) => ({
      key: `custom:${ck}`,
      label: `${ck} (custom ${s.custom_metrics[ck]?.type || 'metric'})`,
      color: palette[idx % palette.length]
    }))
  ];

  const toggles = metricDefs
    .map((m) => {
      const active = analysisSelectedMetrics.includes(m.key);
      return `
        <button class="btn ${active ? 'btn-secondary' : ''}" style="padding:5px 10px;font-size:11.5px;border-color:${active ? m.color : 'var(--border)'};" onclick="toggleAnalysisMetric('${esc(m.key)}')">
          <span style="color:${m.color};">&#9632;</span> ${esc(m.label)}
        </button>
      `;
    })
    .join('');

  const pts = rows;
  const w = 1140;
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
          let val = 0;
          if (m.key === 'e2e_ms') val = r.e2e_ms || 0;
          else if (m.key === 'ttft_ms') val = r.ttft_ms || 0;
          else if (m.key.startsWith('custom:')) {
            const cmKey = m.key.replace('custom:', '');
            val = r.custom_metrics?.[cmKey] || 0;
          } else {
            val = r.server_timing?.[m.key] || 0;
          }
          return `${xFor(i).toFixed(1)},${yFor(val).toFixed(1)}`;
        })
        .join(' ');
      return `<polyline fill="none" stroke="${m.color}" stroke-width="2.3" points="${poly}" />`;
    })
    .join('');

  const customSummaryHtml = customKeys.length
    ? `<div style="margin-top:16px;">
         <strong style="font-size:12px;text-transform:uppercase;color:var(--text-1);">Discovered Custom Script Metrics (${customKeys.length})</strong>
         <table style="margin-top:8px;">
           <thead><tr><th>Metric Name</th><th>Type</th><th>Count</th><th>Min</th><th>Avg</th><th>Median (p50)</th><th>P90</th><th>P95</th><th>P99</th><th>Max</th><th>Sample Stdev (n-1)</th></tr></thead>
           <tbody>
             ${customKeys
               .map((ck) => {
                 const cm = s.custom_metrics[ck];
                 const st = cm.stats || {};
                 return `<tr>
                   <td><code>${esc(ck)}</code></td>
                   <td><span class="badge badge-info">${esc(cm.type)}</span></td>
                   <td>${st.count ?? 0}</td>
                   <td>${st.min ?? 0}</td>
                   <td>${st.avg ?? 0}</td>
                   <td>${st.med ?? 0}</td>
                   <td>${st.p90 ?? 0}</td>
                   <td><strong>${st.p95 ?? 0}</strong></td>
                   <td>${st.p99 ?? 0}</td>
                   <td>${st.max ?? 0}</td>
                   <td>${st.stdev ?? 0}</td>
                 </tr>`;
               })
               .join('')}
           </tbody>
         </table>
       </div>`
    : '';

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${toggles}</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <a href="/api/runs/${encodeURIComponent(s.run_id)}/export-zip" download="${esc(s.run_id)}-k6-export.zip" class="btn btn-success" style="text-decoration:none;padding:6px 12px;">&#128230; Export k6 Multi-CSV ZIP</a>
      </div>
    </div>
    <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:14px;height:235px;">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
        <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
        <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />
        <text x="6" y="${padT + 6}" fill="var(--chart-text)" font-size="10">${Math.round(maxVal)}ms</text>
        <text x="6" y="${(padT + h - padB) / 2 + 4}" fill="var(--chart-text)" font-size="10">${Math.round(maxVal / 2)}ms</text>
        ${linesSvg}
      </svg>
    </div>
    ${customSummaryHtml}
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

// TAB 5: N-INJECTOR PROFILE & POPULATION VU TIMELINE
function renderInjectorsProfileTab(s, rows, scenarios) {
  const distinctWorkers = Array.from(new Set([
    ...(s.workers_used || []),
    ...rows.map((r) => r.worker_id).filter(Boolean)
  ]));

  function statsForWorker(wId, idx) {
    const list = rows.filter((r) => (r.worker_id || 'EC2-Worker-01') === wId);
    const e2es = list.map((x) => Number(x.e2e_ms || 0)).sort((a, b) => a - b);
    const p95 = Math.round(calcPct(e2es, 95));
    const avg = list.length ? Math.round(e2es.reduce((a, b) => a + b, 0) / list.length) : 0;
    const errs = list.filter((x) => x.http_status >= 400).length;

    const cpus = list.map((x) => x.host_resources?.cpuPct).filter((v) => v != null).map(Number);
    const mems = list.map((x) => x.host_resources?.memPct).filter((v) => v != null).map(Number);
    const cpuMean = cpus.length ? `${(cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(1)}%` : 'n/a';
    const memMean = mems.length ? `${(mems.reduce((a, b) => a + b, 0) / mems.length).toFixed(1)}%` : 'n/a';
    const seg = list[0]?.execution_segment || (distinctWorkers.length === 1 ? '0:1' : `${idx}/${distinctWorkers.length}`);

    return `
      <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div>
            <strong style="font-size:14px;">${esc(wId)}</strong>
            <div style="color:var(--text-2);font-size:11.5px;">Segment: <code>${esc(seg)}</code></div>
          </div>
          <span class="badge badge-pass">PARTICIPATED (${list.length} reqs)</span>
        </div>
        <div class="grid-3">
          <div class="stat-card"><div class="stat-label">Requests Sent</div><div class="stat-value">${list.length}</div></div>
          <div class="stat-card"><div class="stat-label">Injector P95 / Avg</div><div class="stat-value">${p95} ms</div><div class="stat-sub">Avg: ${avg} ms</div></div>
          <div class="stat-card"><div class="stat-label">HTTP Errors &amp; OS</div><div class="stat-value">${errs}</div><div class="stat-sub">CPU: ${cpuMean} | Mem: ${memMean}</div></div>
        </div>
      </div>
    `;
  }

  // Render Population / Scenario Activity Timeline across time buckets
  const buckets = getRunTimeBuckets(s, rows);
  const scenNames = scenarios.map((sc) => sc.name);
  const colors = ['#f97316', '#06b6d4', '#8b5cf6', '#10b981', '#ec4899'];
  const w = 1120;
  const h = 165;
  const padL = 48;
  const padR = 24;
  const padT = 18;
  const padB = 26;
  const maxReqsInBucket = Math.max(4, ...buckets.map((b) => b.requests || 1));
  const xFor = (i) => padL + (buckets.length <= 1 ? (w - padL - padR) / 2 : (i / (buckets.length - 1)) * (w - padL - padR));
  const yFor = (v) => padT + (1 - Math.min(1, v / maxReqsInBucket)) * (h - padT - padB);

  const scenPolys = scenNames
    .map((scName, idx) => {
      const poly = buckets
        .map((b, i) => `${xFor(i).toFixed(1)},${yFor(b.byScenario?.[scName] || 0).toFixed(1)}`)
        .join(' ');
      return `<polyline fill="none" stroke="${colors[idx % colors.length]}" stroke-width="2.4" points="${poly}" />`;
    })
    .join('');

  const legendHtml = scenNames
    .map(
      (scName, idx) =>
        `<span style="font-size:11.5px;margin-right:12px;"><span style="color:${colors[idx % colors.length]};">&#9632;</span> <code>${esc(scName)}</code></span>`
    )
    .join('');

  return `
    <div style="margin-bottom:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <strong style="font-size:12.5px;text-transform:uppercase;color:var(--text-1);">Run Timeline: Population &amp; Scenario Activity Over Time</strong>
        <div>${legendHtml}</div>
      </div>
      <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:8px;padding:12px;height:185px;">
        <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;">
          <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
          <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />
          <text x="6" y="${padT + 6}" fill="var(--chart-text)" font-size="10">${maxReqsInBucket} req/b</text>
          <text x="6" y="${h - padB}" fill="var(--chart-text)" font-size="10">0</text>
          ${scenPolys}
        </svg>
      </div>
    </div>

    <div class="grid-2" style="grid-template-columns:repeat(auto-fit, minmax(380px, 1fr));">
      ${distinctWorkers.map((wId, idx) => statsForWorker(wId, idx)).join('')}
    </div>
  `;
}

// TAB 6: SCRIPT VIEWER
function renderScriptTab(s, scenarios) {
  const scriptPreview = `// Executed Run ID: ${s.run_id}
// Run Type: ${s.run_type || 'ai'} | Engine: ${s.stream_engine || 'node-http-measured'}
// Workload: ${s.workload} | Target: ${s.target_name} (${s.model})
// Load Injectors: ${(s.workers_used || []).join(', ')}

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
    <pre id="runScriptPre" class="code-pre">${esc(scriptPreview)}</pre>
  `;
}

// TAB 7: LOGS VIEWER (PERSISTED CONSOLE.LOG + TURN TELEMETRY LOGS)
function renderLogsTab(s, rows) {
  const rawConsole = currentRunData?.consoleLog || '';
  const generatedLogs = rows.map((r) => ({
    ts: r.ts,
    level: r.http_status >= 400 || !r.det_pass ? 'WARN' : 'INFO',
    text: `[${r.worker_id}] [${r.population_id || r.scenario_id}] prompt=${r.prompt_id} status=${r.http_status} e2e=${r.e2e_ms}ms ttft=${r.ttft_ms ?? 'n/a'}ms bytes=${r.res_bytes ?? 'n/a'} trace=${r.trace_id} check=${r.det_pass}`
  }));

  const filtered = generatedLogs.filter((l) => {
    if (logFilterLevel !== 'ALL' && l.level !== logFilterLevel) return false;
    if (logSearchQuery && !l.text.toLowerCase().includes(logSearchQuery.toLowerCase())) return false;
    return true;
  });

  return `
    ${
      rawConsole
        ? `<div style="margin-bottom:14px;">
             <strong style="font-size:12px;text-transform:uppercase;color:var(--text-1);">Persisted Pipeline Console Log (<code>results/${esc(s.run_id)}/console.log</code>)</strong>
             <pre class="console-box" style="height:150px;margin-top:6px;">${esc(rawConsole)}</pre>
           </div>`
        : ''
    }
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;gap:6px;">
        <button class="btn ${logFilterLevel === 'ALL' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='ALL';renderGrafanaCloudRunView();">ALL (${generatedLogs.length})</button>
        <button class="btn ${logFilterLevel === 'INFO' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='INFO';renderGrafanaCloudRunView();">INFO</button>
        <button class="btn ${logFilterLevel === 'WARN' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11.5px;" onclick="logFilterLevel='WARN';renderGrafanaCloudRunView();">WARN / ERROR</button>
      </div>
      <input type="text" placeholder="Search logs (trace ID, worker, prompt)..." value="${esc(logSearchQuery)}" style="width:260px;margin:0;padding:5px 10px;" oninput="logSearchQuery=this.value;renderGrafanaCloudRunView();" />
    </div>
    <div class="console-box" style="height:280px;">
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
  const header = 'row_id,run_id,worker_id,population_id,load_level,prompt_id,http_status,ttft_ms,e2e_ms,req_bytes,res_bytes,det_pass,correctness,trace_id\n';
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
      r.req_bytes ?? '',
      r.res_bytes ?? '',
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
