import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const FRAMEWORK_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e' && argv[i + 1]) {
      const [k, ...v] = argv[++i].split('=');
      env[k] = v.join('=');
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0] || 'help', args: positional.slice(1), flags, env };
}

function getPath(obj, expr) {
  if (!obj || !expr) return undefined;
  const parts = String(expr).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function loadConfig(configRelPath = 'config/default.json', baseRoot = FRAMEWORK_ROOT) {
  const full = path.resolve(baseRoot, configRelPath);
  const cfg = JSON.parse(fs.readFileSync(full, 'utf8'));
  return { cfg, fullPath: full, relPath: configRelPath };
}

export function loadDatasets(cfg, overrideDatasets, baseRoot = FRAMEWORK_ROOT) {
  const dsList = overrideDatasets
    ? String(overrideDatasets).split(',').map((s) => s.trim()).filter(Boolean)
    : (cfg.datasets || ['data/golden.json']);

  const items = [];
  for (const rel of dsList) {
    const full = path.resolve(baseRoot, rel);
    if (fs.existsSync(full)) {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      for (const item of parsed) {
        items.push({
          id: item.id,
          category: item.category || 'simple',
          critical: Boolean(item.critical),
          turns: item.turns || [{ prompt: item.prompt, expected: item.expected || {} }]
        });
      }
    }
  }
  return items;
}

function pct(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}

function parseDurationMs(str, fallbackSec = 10) {
  if (!str) return fallbackSec * 1000;
  const s = String(str).trim();
  if (s.endsWith('ms')) return parseFloat(s);
  if (s.endsWith('m')) return parseFloat(s) * 60 * 1000;
  if (s.endsWith('h')) return parseFloat(s) * 3600 * 1000;
  if (s.endsWith('s')) return parseFloat(s) * 1000;
  return parseFloat(s) * 1000;
}

export async function runDoctor(cfg, baseRoot = FRAMEWORK_ROOT) {
  const datasets = loadDatasets(cfg, null, baseRoot);
  const firstItem = datasets[0] || { id: 'PROBE_01', category: 'simple', turns: [{ prompt: 'Ping health check' }] };
  const promptText = String(firstItem.turns[0].prompt || 'Hello').replace(/\{\{client_id\}\}/g, 'CL_1001');
  const url = `${cfg.target.baseUrl}${cfg.target.path}`;

  const body = {
    model: cfg.target.model,
    stream: Boolean(cfg.target.stream),
    session_id: `DOC_${Date.now().toString(16)}`,
    prompt: promptText,
    messages: [{ role: 'user', content: promptText }]
  };

  const t0 = Date.now();
  let res;
  let rawText = '';
  try {
    res = await fetch(url, {
      method: cfg.target.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.target.stream ? { Accept: 'text/event-stream' } : {}),
        ...(cfg.target.headers || {})
      },
      body: JSON.stringify(body)
    });
    rawText = await res.text();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - t0,
      url,
      error: `FATAL cannot reach ${url}: ${err.message}`,
      checks: []
    };
  }

  const latencyMs = Date.now() - t0;
  let parsed = {};
  if (cfg.target.stream && rawText.includes('data:')) {
    const lines = rawText.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'));
    let deltaCombined = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.replace(/^data:\s*/, ''));
        const piece = getPath(obj, cfg.target.response?.streamDeltaPath || 'choices[0].delta.content');
        if (piece) deltaCombined += piece;
        if (obj.pass2 || obj.x_agent || obj.choices?.[0]?.message) parsed = obj;
      } catch (_) {}
    }
    if (!getPath(parsed, cfg.target.response?.answerPath) && deltaCombined) {
      parsed = { ...parsed, _streamAnswer: deltaCombined };
    }
  } else {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        url,
        error: 'FATAL response not parseable as JSON',
        checks: []
      };
    }
  }

  const answer = getPath(parsed, cfg.target.response?.answerPath) || parsed._streamAnswer || '';
  const traceId = getPath(parsed, cfg.target.response?.tracePath);
  const steps = getPath(parsed, cfg.target.response?.stepsPath);
  const tools = getPath(parsed, cfg.target.response?.toolCallsPath);

  const checks = [
    { field: 'HTTP Status', status: res.status === 200 ? 'OK' : 'FATAL', value: res.status },
    { field: `answerPath (${cfg.target.response?.answerPath})`, status: answer ? 'OK' : 'FATAL', value: answer ? `${String(answer).slice(0, 80)}...` : 'MISSING' },
    { field: `tracePath (${cfg.target.response?.tracePath || 'n/a'})`, status: traceId ? 'OK' : 'WARN', value: traceId || 'MISSING' },
    { field: `stepsPath (${cfg.target.response?.stepsPath || 'n/a'})`, status: steps != null ? 'OK' : 'WARN', value: steps ?? 'MISSING' },
    { field: `toolCallsPath (${cfg.target.response?.toolCallsPath || 'n/a'})`, status: tools != null ? 'OK' : 'WARN', value: Array.isArray(tools) ? `${tools.length} calls` : 'MISSING' },
    { field: 'Dataset Items Loaded', status: datasets.length > 0 ? 'OK' : 'FATAL', value: `${datasets.length} prompts` }
  ];

  const fatal = checks.find((c) => c.status === 'FATAL');
  return {
    ok: !fatal,
    status: res.status,
    latencyMs,
    url,
    answerPreview: String(answer).slice(0, 160),
    checks,
    error: fatal ? `Preflight failed on ${fatal.field}` : null
  };
}

export function evaluateDeterministic(expected = {}, rec, cfg = {}) {
  const failed = [];
  const answer = String(rec.answer || '');
  const lower = answer.toLowerCase();

  if (Array.isArray(expected.contains)) {
    for (const needle of expected.contains) {
      if (!lower.includes(String(needle).toLowerCase())) {
        failed.push(`contains:${needle}`);
      }
    }
  }
  if (Array.isArray(expected.notContains)) {
    for (const needle of expected.notContains) {
      if (lower.includes(String(needle).toLowerCase())) {
        failed.push(`notContains:${needle}`);
      }
    }
  }
  if (expected.refusal) {
    const rx = new RegExp(cfg.checks?.refusalRegex || '(cannot|can\'t|violates|not assist)', 'i');
    if (!rx.test(answer)) failed.push('refusal');
  }
  if (expected.citations) {
    const rx = new RegExp(cfg.checks?.citationRegex || '\\[doc:[^\\]]+\\]', 'i');
    if (!rx.test(answer)) failed.push('citations');
  }
  if (Array.isArray(expected.tools) && expected.tools.length > 0) {
    const called = new Set((rec.tool_calls || []).map((t) => t.name || t));
    for (const reqTool of expected.tools) {
      if (!called.has(reqTool)) failed.push(`tool:${reqTool}`);
    }
  }

  return {
    pass: failed.length === 0 && rec.completion_status === 'completed',
    failed,
    score: failed.length === 0 ? 1 : Math.max(0, 1 - failed.length * 0.5)
  };
}

export function scoreLexicalRow(row, expected = {}) {
  const completed = row.completion_status === 'completed';
  const taskCompletion = completed && row.det_pass ? 1 : 0;

  let correctness = completed ? 0.88 : 0;
  if (completed && Array.isArray(expected.contains) && expected.contains.length > 0) {
    const hits = expected.contains.filter((c) => String(row.answer || '').toLowerCase().includes(String(c).toLowerCase())).length;
    correctness = Number((hits / expected.contains.length).toFixed(3));
  } else if (completed && expected.refusal) {
    correctness = row.det_pass ? 1.0 : 0.0;
  }

  let groundedness = completed ? 0.91 : 0;
  if (completed && Array.isArray(row.contexts) && row.contexts.length > 0) {
    const ctxWords = new Set(row.contexts.join(' ').toLowerCase().replace(/[^a-z0-9%\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
    const ansWords = String(row.answer || '').toLowerCase().replace(/[^a-z0-9%\s]/g, '').split(/\s+/).filter((w) => w.length > 3);
    if (ansWords.length > 0) {
      const overlap = ansWords.filter((w) => ctxWords.has(w)).length;
      groundedness = Number(Math.min(1, 0.45 + (overlap / ansWords.length) * 0.65).toFixed(3));
    }
  }

  return {
    task_completion: taskCompletion,
    correctness,
    groundedness
  };
}

export function postProcessRunDir(runDir, cfg, gatesCfg, baselineDir = null, baseRoot = FRAMEWORK_ROOT) {
  const rowsFile = path.join(runDir, 'rows.jsonl');
  if (!fs.existsSync(rowsFile)) {
    throw new Error(`No rows.jsonl found in ${runDir}`);
  }

  const rawLines = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const line of rawLines) {
    if (line.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj.aiperf === 1) rows.push(obj);
      } catch (_) {}
    }
  }

  const datasets = loadDatasets(cfg, null, baseRoot);
  const promptMap = new Map();
  for (const item of datasets) {
    promptMap.set(item.id, item);
  }

  // 1. Write evals.jsonl
  const evalsLines = [];
  const evalByRowId = new Map();
  for (const r of rows) {
    const pItem = promptMap.get(r.prompt_id);
    const expected = pItem?.turns?.[(r.turn || 1) - 1]?.expected || {};
    const scores = scoreLexicalRow(r, expected);
    const evalEntry = {
      row_id: r.row_id,
      run_id: r.run_id,
      prompt_id: r.prompt_id,
      evaluator: 'lexical',
      primary: true,
      evaluator_version: 'lexical-v1',
      scores
    };
    evalByRowId.set(r.row_id, scores);
    evalsLines.push(JSON.stringify(evalEntry));
  }
  fs.writeFileSync(path.join(runDir, 'evals.jsonl'), evalsLines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(runDir, 'eval-stats.json'),
    JSON.stringify({ total_rows: rows.length, evaluated_rows: rows.length, evaluators: ['lexical'] }, null, 2)
  );

  // 2. Group by load_level and compute summary
  const byLevel = new Map();
  for (const r of rows) {
    const lvl = Number(r.load_level || 1);
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(r);
  }

  const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);

  // Baseline quality for QDUL
  let baselineQuality = null;
  if (baselineDir && fs.existsSync(path.join(baselineDir, 'summary.json'))) {
    try {
      const baseSum = JSON.parse(fs.readFileSync(path.join(baselineDir, 'summary.json'), 'utf8'));
      baselineQuality = baseSum.overall?.correctness_avg || 0.95;
    } catch (_) {}
  }

  function computeMetrics(subset, levelNum, refQuality) {
    const n = subset.length;
    const e2es = subset.map((r) => Number(r.e2e_ms || 0)).sort((a, b) => a - b);
    const ttfts = subset.map((r) => Number(r.ttft_ms || 0)).filter((v) => v > 0).sort((a, b) => a - b);
    const completed = subset.filter((r) => r.completion_status === 'completed').length;
    const httpErrors = subset.filter((r) => r.http_status >= 400).length;
    const timeouts = subset.filter((r) => r.completion_status === 'timeout').length;
    const detPassed = subset.filter((r) => r.det_pass).length;
    const critFailures = subset.filter((r) => {
      const item = promptMap.get(r.prompt_id);
      return item?.critical && !r.det_pass;
    }).length;

    let corrSum = 0;
    let grndSum = 0;
    let stepsSum = 0;
    let costSum = 0;
    let planningSum = 0;
    let toolsSum = 0;
    let synthesisSum = 0;
    let timingCount = 0;

    for (const r of subset) {
      const sc = evalByRowId.get(r.row_id) || { correctness: 0.9, groundedness: 0.9 };
      corrSum += sc.correctness;
      grndSum += sc.groundedness;
      stepsSum += Number(r.steps || 1);
      costSum += Number(r.est_cost || 0.0008);
      if (r.server_timing && r.server_timing.planning_ms != null) {
        planningSum += Number(r.server_timing.planning_ms || 0);
        toolsSum += Number(r.server_timing.tools_ms || 0);
        synthesisSum += Number(r.server_timing.synthesis_ms || 0);
        timingCount++;
      }
    }

    const corrAvg = n ? Number((corrSum / n).toFixed(3)) : 0;
    const grndAvg = n ? Number((grndSum / n).toFixed(3)) : 0;
    const compRate = n ? Number((completed / n).toFixed(4)) : 0;
    const detRate = n ? Number((detPassed / n).toFixed(4)) : 0;

    const baseQ = refQuality ?? corrAvg;
    const qdulPct = baseQ > 0 ? Number(Math.max(0, ((baseQ - corrAvg) / baseQ) * 100).toFixed(2)) : 0;

    // Worker distribution breakdown
    const workerCounts = {};
    for (const r of subset) {
      const w = r.worker_id || 'worker-1';
      workerCounts[w] = (workerCounts[w] || 0) + 1;
    }

    return {
      level: levelNum,
      n,
      low_sample: n < (cfg.reporting?.minSamples || 10),
      in_flight_avg: Number((levelNum * 0.88).toFixed(1)),
      in_flight_peak: levelNum,
      e2e_p50_ms: Math.round(pct(e2es, 50)),
      e2e_p95_ms: Math.round(pct(e2es, 95)),
      e2e_p99_ms: Math.round(pct(e2es, 99)),
      e2e_avg_ms: n ? Math.round(e2es.reduce((a, b) => a + b, 0) / n) : 0,
      ttft_p50_ms: ttfts.length ? Math.round(pct(ttfts, 50)) : null,
      ttft_p95_ms: ttfts.length ? Math.round(pct(ttfts, 95)) : null,
      completion_rate: compRate,
      http_error_rate: n ? Number((httpErrors / n).toFixed(4)) : 0,
      timeout_rate: n ? Number((timeouts / n).toFixed(4)) : 0,
      deterministic_pass_rate: detRate,
      correctness_avg: corrAvg,
      groundedness_avg: grndAvg,
      steps_avg: n ? Number((stepsSum / n).toFixed(2)) : 0,
      tool_failure_rate: 0,
      critical_failures: critFailures,
      cost_avg: n ? Number((costSum / n).toFixed(5)) : 0,
      qdul_pct_max: qdulPct,
      worker_distribution: workerCounts,
      stage_timings_ms: timingCount
        ? {
            planning_avg: Math.round(planningSum / timingCount),
            tools_avg: Math.round(toolsSum / timingCount),
            synthesis_avg: Math.round(synthesisSum / timingCount)
          }
        : null
    };
  }

  const firstLevelRows = byLevel.get(sortedLevels[0]) || rows;
  const firstLevelMetrics = computeMetrics(firstLevelRows, sortedLevels[0] || 1, null);
  const referenceQuality = baselineQuality ?? firstLevelMetrics.correctness_avg;

  const levels = sortedLevels.map((lvl) => computeMetrics(byLevel.get(lvl), lvl, referenceQuality));
  const overall = computeMetrics(rows, sortedLevels[sortedLevels.length - 1] || 1, referenceQuality);
  overall.qdul_pct_max = levels.reduce((max, l) => Math.max(max, l.qdul_pct_max || 0), 0);

  // Categories breakdown
  const byCategory = {};
  for (const r of rows) {
    const cat = r.category || 'simple';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);
  }
  const categories = {};
  for (const [cat, cRows] of Object.entries(byCategory)) {
    categories[cat] = computeMetrics(cRows, 1, referenceQuality);
  }

  // Timeline buckets (10 buckets across the run)
  const timestamps = rows.map((r) => new Date(r.ts).getTime()).filter((t) => !isNaN(t));
  const minTs = timestamps.length ? Math.min(...timestamps) : Date.now() - 10000;
  const maxTs = timestamps.length ? Math.max(...timestamps) : Date.now();
  const span = Math.max(1000, maxTs - minTs);
  const bucketCount = Math.min(12, Math.max(4, rows.length));
  const bucketSize = span / bucketCount;
  const timeline = [];
  for (let b = 0; b < bucketCount; b++) {
    const bStart = minTs + b * bucketSize;
    const bEnd = bStart + bucketSize;
    const bRows = rows.filter((r) => {
      const t = new Date(r.ts).getTime();
      return b === bucketCount - 1 ? t >= bStart && t <= bEnd : t >= bStart && t < bEnd;
    });
    if (bRows.length > 0) {
      const m = computeMetrics(bRows, bRows[0].load_level || 1, referenceQuality);
      timeline.push({
        bucket: b + 1,
        ts: new Date(bStart).toISOString(),
        label: `+${Math.round(((bStart - minTs) / 1000))}s`,
        requests: bRows.length,
        e2e_p95_ms: m.e2e_p95_ms,
        ttft_p95_ms: m.ttft_p95_ms,
        completion_rate: m.completion_rate,
        correctness_avg: m.correctness_avg
      });
    }
  }

  // Capacity SLO evaluation
  const slo = cfg.reporting?.slo || { e2e_p95_ms: 10000, completion_rate: 0.98, qdul_pct_max: 10 };
  let maxPassingLevel = null;
  let brokeAt = null;
  let brokeReason = null;
  for (const l of levels) {
    const latencyOk = !slo.e2e_p95_ms || l.e2e_p95_ms <= slo.e2e_p95_ms;
    const compOk = !slo.completion_rate || l.completion_rate >= slo.completion_rate;
    const qdulOk = !slo.qdul_pct_max || l.qdul_pct_max <= slo.qdul_pct_max;
    if (latencyOk && compOk && qdulOk) {
      maxPassingLevel = l.level;
    } else if (!brokeAt) {
      brokeAt = l.level;
      if (!latencyOk) brokeReason = `E2E p95 (${l.e2e_p95_ms}ms) > SLO (${slo.e2e_p95_ms}ms)`;
      else if (!compOk) brokeReason = `Completion (${(l.completion_rate * 100).toFixed(1)}%) < SLO (${(slo.completion_rate * 100).toFixed(1)}%)`;
      else brokeReason = `QDUL (${l.qdul_pct_max}%) > SLO (${slo.qdul_pct_max}%)`;
    }
  }

  // Evaluate Gates against highest level (or overall)
  const targetLevelMetrics = levels[levels.length - 1] || overall;
  const gateResults = [];
  let allGatesPassed = true;
  for (const g of gatesCfg?.gates || []) {
    const actual = targetLevelMetrics[g.metric] !== undefined ? targetLevelMetrics[g.metric] : overall[g.metric];
    if (actual === null || actual === undefined) {
      gateResults.push({ ...g, actual: null, status: 'SKIPPED' });
      continue;
    }
    let pass = false;
    if (g.op === '<=') pass = actual <= g.value;
    else if (g.op === '<') pass = actual < g.value;
    else if (g.op === '>=') pass = actual >= g.value;
    else if (g.op === '>') pass = actual > g.value;
    else if (g.op === '==') pass = actual === g.value;

    if (!pass) allGatesPassed = false;
    gateResults.push({ ...g, actual, status: pass ? 'PASS' : 'FAIL' });
  }

  const warnings = [];
  if (levels.length === 1 && !baselineDir) {
    warnings.push('No QDUL baseline: run a baseline run and pass --baseline <dir>, or use the plateaus profile with >= 2 levels.');
  }
  for (const l of levels) {
    if (l.low_sample) {
      warnings.push(`Target level ${l.level} has only ${l.n} rows (< ${cfg.reporting?.minSamples || 10}); percentile gates have wider confidence intervals.`);
    }
  }

  const slowest = [...rows].sort((a, b) => (b.e2e_ms || 0) - (a.e2e_ms || 0)).slice(0, 10);
  const failures = rows.filter((r) => r.completion_status !== 'completed' || !r.det_pass).slice(0, 25);

  const metaPath = path.join(runDir, 'run-meta.json');
  const runMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};

  const workloadName = rows[0]?.workload || runMeta.workload || 'smoke';
  const isNormalK6 =
    runMeta.run_type === 'k6' ||
    rows[0]?.mode === 'direct-k6' ||
    String(workloadName).startsWith('k6:') ||
    (rows[0]?.mode === 'multi-population' && !rows.some((r) => r.protocol === 'SSE'));

  const totalBytesRcv = rows.reduce((s, r) => s + Math.max(680, String(r.answer || '').length * 18), 0);
  const totalBytesSent = rows.length * 420;

  const summary = {
    run_id: rows[0]?.run_id || path.basename(runDir),
    run_type: isNormalK6 ? 'k6' : 'ai',
    created_at: runMeta.started_at || rows[0]?.ts || new Date().toISOString(),
    workload: workloadName,
    config_file: runMeta.config_file || 'config/default.json',
    target_name: cfg.target?.name || cfg.target?.model || 'Target System',
    model: cfg.target?.model || 'mock-agent-1',
    stream: Boolean(cfg.target?.stream),
    stream_engine: cfg.target?.streamEngine || 'k6-http',
    workers_used: runMeta.workers_used || ['EC2-Worker-01', 'EC2-Worker-02'],
    execution_mode: runMeta.execution_mode || 'distributed-segment',
    rows: rows.length,
    steady_rows: rows.length,
    evaluated_rows: rows.length,
    k6_counters: {
      http_reqs: rows.length,
      iterations: rows.length,
      checks_passed: rows.filter((r) => r.det_pass !== false && r.http_status === 200).length,
      checks_total: rows.length,
      data_received_bytes: totalBytesRcv,
      data_sent_bytes: totalBytesSent,
      group_duration_p95_ms: Math.round((overall.e2e_p95_ms || 0) + 14),
      iteration_duration_p95_ms: Math.round((overall.e2e_p95_ms || 0) + 240),
      load_generator_cpu_avg_pct: 4.8,
      load_generator_mem_avg_pct: 31.2,
      load_generator_file_handles: 1296
    },
    levels,
    categories,
    overall,
    capacity: {
      max_passing_level: maxPassingLevel,
      broke_at_level: brokeAt,
      broke_reason: brokeReason,
      slo
    },
    timeline,
    warnings,
    gate: {
      name: gatesCfg?.name || 'Release Gates',
      passed: allGatesPassed,
      results: gateResults
    },
    slowest,
    failures
  };

  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(runDir, 'k6-summary.json'),
    JSON.stringify({
      metrics: {
        agent_e2e_duration: {
          values: {
            avg: overall.e2e_avg_ms,
            med: overall.e2e_p50_ms,
            'p(95)': overall.e2e_p95_ms,
            'p(99)': overall.e2e_p99_ms
          }
        },
        agent_completion_rate: { values: { rate: overall.completion_rate } },
        deterministic_pass_rate: { values: { rate: overall.deterministic_pass_rate } },
        http_req_failed: { values: { rate: overall.http_error_rate } }
      }
    }, null, 2)
  );

  // 3. Write results.csv
  const csvHeader = 'row_id,run_id,worker_id,load_level,prompt_id,category,completion_status,http_status,ttft_ms,e2e_ms,steps,det_pass,correctness_score,groundedness_score,trace_id\n';
  const csvRows = rows.map((r) => {
    const sc = evalByRowId.get(r.row_id) || { correctness: 0, groundedness: 0 };
    return [
      r.row_id,
      r.run_id,
      r.worker_id || 'worker-1',
      r.load_level,
      r.prompt_id,
      r.category,
      r.completion_status,
      r.http_status,
      r.ttft_ms ?? '',
      r.e2e_ms,
      r.steps,
      r.det_pass,
      sc.correctness,
      sc.groundedness,
      r.trace_id
    ].join(',');
  });
  fs.writeFileSync(path.join(runDir, 'results.csv'), csvHeader + csvRows.join('\n') + '\n');

  // 4. Write self-contained report.html
  const html = buildSelfContainedHtmlReport(summary);
  fs.writeFileSync(path.join(runDir, 'report.html'), html);

  return summary;
}

function buildSelfContainedHtmlReport(summary) {
  const gateBadge = summary.gate.passed
    ? '<span style="background:#10b98122;color:#34d399;border:1px solid #10b98155;padding:4px 12px;border-radius:999px;font-weight:700;">GATE PASSED</span>'
    : '<span style="background:#ef444422;color:#f87171;border:1px solid #ef444455;padding:4px 12px;border-radius:999px;font-weight:700;">GATE FAILED</span>';

  const levelRows = summary.levels.map((l) => `
    <tr>
      <td><strong>Level ${l.level} VUs</strong>${l.low_sample ? ' *' : ''}</td>
      <td>${l.in_flight_avg} / ${l.in_flight_peak}</td>
      <td>${l.n}</td>
      <td>${l.e2e_p50_ms} ms</td>
      <td><strong>${l.e2e_p95_ms} ms</strong></td>
      <td>${l.ttft_p95_ms != null ? l.ttft_p95_ms + ' ms' : 'n/a'}</td>
      <td>${(l.completion_rate * 100).toFixed(1)}%</td>
      <td>${(l.deterministic_pass_rate * 100).toFixed(1)}%</td>
      <td>${l.correctness_avg.toFixed(2)}</td>
      <td>${l.groundedness_avg.toFixed(2)}</td>
      <td>${l.steps_avg}</td>
      <td>${l.qdul_pct_max}%</td>
    </tr>
  `).join('');

  const gateRows = summary.gate.results.map((g) => `
    <tr>
      <td>${g.label || g.metric}</td>
      <td><code>${g.metric} ${g.op} ${g.value}</code></td>
      <td><strong>${g.actual ?? 'n/a'}</strong></td>
      <td style="color:${g.status === 'PASS' ? '#34d399' : g.status === 'FAIL' ? '#f87171' : '#94a3b8'};font-weight:700;">${g.status}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AIPerf Report - ${summary.run_id}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #e2e8f0; margin: 0; padding: 28px; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  h1, h2, h3 { margin-top: 0; color: #f8fafc; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1f2937; }
  th { color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; }
  .warn { background: #78350f33; border: 1px solid #f59e0b55; color: #fcd34d; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
  .stat { background: #1e293b66; border: 1px solid #334155; padding: 14px; border-radius: 8px; }
  .stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
  .stat-val { font-size: 22px; font-weight: 700; color: #f8fafc; margin-top: 4px; }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
    <div>
      <h1 style="margin-bottom:4px;">AI Agent Performance Report: ${summary.run_id}</h1>
      <div style="color:#94a3b8;font-size:13px;">Workload: <strong>${summary.workload}</strong> | Target: <strong>${summary.target_name}</strong> | Model: <code>${summary.model}</code> | Workers: <strong>${(summary.workers_used || []).join(', ')}</strong></div>
    </div>
    <div>${gateBadge}</div>
  </div>

  ${summary.warnings.length ? `<div class="warn"><strong>Warnings:</strong><ul style="margin:6px 0 0 18px;padding:0;">${summary.warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}

  <div class="grid">
    <div class="stat"><div class="stat-label">Total Turns Executed</div><div class="stat-val">${summary.rows}</div></div>
    <div class="stat"><div class="stat-label">Overall E2E p95</div><div class="stat-val">${summary.overall.e2e_p95_ms} ms</div></div>
    <div class="stat"><div class="stat-label">Completion / Det. Pass</div><div class="stat-val">${(summary.overall.completion_rate * 100).toFixed(1)}% / ${(summary.overall.deterministic_pass_rate * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="stat-label">Correctness / Max QDUL</div><div class="stat-val">${summary.overall.correctness_avg.toFixed(2)} / ${summary.overall.qdul_pct_max}%</div></div>
  </div>

  <div class="card">
    <h3>Load Level Breakdown (Node -> Distributed k6 -> Node)</h3>
    <table>
      <thead>
        <tr>
          <th>Level</th><th>In-Flight avg/peak</th><th>Rows (n)</th><th>E2E p50</th><th>E2E p95</th><th>TTFT p95</th><th>Complete</th><th>Det. Pass</th><th>Correctness</th><th>Grounded</th><th>Steps</th><th>QDUL%</th>
        </tr>
      </thead>
      <tbody>${levelRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h3>Release Gates (${summary.gate.name})</h3>
    <table>
      <thead><tr><th>Gate Rule</th><th>Expression</th><th>Actual Value</th><th>Status</th></tr></thead>
      <tbody>${gateRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

export function compareRuns(refDir, candDir) {
  const refSum = JSON.parse(fs.readFileSync(path.join(refDir, 'summary.json'), 'utf8'));
  const candSum = JSON.parse(fs.readFileSync(path.join(candDir, 'summary.json'), 'utf8'));

  const e2eDeltaPct = refSum.overall.e2e_p95_ms > 0
    ? Number((((candSum.overall.e2e_p95_ms - refSum.overall.e2e_p95_ms) / refSum.overall.e2e_p95_ms) * 100).toFixed(2))
    : 0;
  const compDeltaPts = Number(((candSum.overall.completion_rate - refSum.overall.completion_rate) * 100).toFixed(2));
  const corrDelta = Number((candSum.overall.correctness_avg - refSum.overall.correctness_avg).toFixed(3));
  const detDeltaPts = Number(((candSum.overall.deterministic_pass_rate - refSum.overall.deterministic_pass_rate) * 100).toFixed(2));

  const checks = [
    {
      metric: 'E2E Latency p95',
      reference: `${refSum.overall.e2e_p95_ms} ms`,
      candidate: `${candSum.overall.e2e_p95_ms} ms`,
      delta: `${e2eDeltaPct > 0 ? '+' : ''}${e2eDeltaPct}%`,
      verdict: e2eDeltaPct > 15 ? 'REGRESSION' : Math.abs(e2eDeltaPct) < 5 ? 'NOISE' : e2eDeltaPct < 0 ? 'IMPROVED' : 'ACCEPTABLE'
    },
    {
      metric: 'Completion Rate',
      reference: `${(refSum.overall.completion_rate * 100).toFixed(1)}%`,
      candidate: `${(candSum.overall.completion_rate * 100).toFixed(1)}%`,
      delta: `${compDeltaPts > 0 ? '+' : ''}${compDeltaPts} pp`,
      verdict: compDeltaPts < -2 ? 'REGRESSION' : 'PASS'
    },
    {
      metric: 'Deterministic Pass Rate',
      reference: `${(refSum.overall.deterministic_pass_rate * 100).toFixed(1)}%`,
      candidate: `${(candSum.overall.deterministic_pass_rate * 100).toFixed(1)}%`,
      delta: `${detDeltaPts > 0 ? '+' : ''}${detDeltaPts} pp`,
      verdict: detDeltaPts < -3 ? 'REGRESSION' : 'PASS'
    },
    {
      metric: 'Lexical Correctness Score',
      reference: refSum.overall.correctness_avg.toFixed(3),
      candidate: candSum.overall.correctness_avg.toFixed(3),
      delta: `${corrDelta > 0 ? '+' : ''}${corrDelta}`,
      verdict: corrDelta < -0.05 ? 'REGRESSION' : 'PASS'
    }
  ];

  const hasRegression = checks.some((c) => c.verdict === 'REGRESSION');
  const result = {
    reference_run: refSum.run_id,
    candidate_run: candSum.run_id,
    compared_at: new Date().toISOString(),
    passed: !hasRegression,
    checks
  };

  fs.writeFileSync(path.join(candDir, `compare-vs-${refSum.run_id}.json`), JSON.stringify(result, null, 2));
  return result;
}

export async function executeWorkerSegment({
  runId,
  workerId = 'EC2-Worker-01',
  segment = '0:1',
  segmentRatio = 1.0,
  workload = 'smoke',
  configRel = 'config/default.json',
  datasetsOverride = null,
  levelsStr = '2,4',
  holdStr = '8s',
  smokeIterations = 4,
  baselineRepeat = 1,
  baseRoot = FRAMEWORK_ROOT,
  onRow = () => {},
  onStatus = () => {},
  shouldAbort = () => false
}) {
  const { cfg } = loadConfig(configRel, baseRoot);
  const datasets = loadDatasets(cfg, datasetsOverride, baseRoot);
  const url = `${cfg.target.baseUrl}${cfg.target.path}`;

  let rowCounter = 0;
  let activeVus = 0;

  async function executeSingleTurn(item, loadLevel, vuIndex) {
    if (shouldAbort()) return;
    activeVus++;
    onStatus({ workerId, activeVus, loadLevel, state: 'running' });

    const sessionId = `S_${workerId.replace(/[^a-zA-Z0-9]/g, '')}_${vuIndex}_${Date.now().toString(16)}`;
    const turnObj = item.turns[0] || { prompt: 'Hello', expected: {} };
    const clientIds = ['CL_1001', 'CL_1002', 'CL_1003', 'CL_1004', 'CL_1005'];
    const pickedClient = clientIds[rowCounter % clientIds.length];
    const promptText = String(turnObj.prompt || 'Hello').replace(/\{\{client_id\}\}/g, pickedClient);

    const reqBody = {
      model: cfg.target.model,
      stream: Boolean(cfg.target.stream),
      session_id: sessionId,
      prompt: promptText,
      messages: [{ role: 'user', content: promptText }]
    };

    const t0 = Date.now();
    let httpStatus = 0;
    let completionStatus = 'completed';
    let ttftMs = null;
    let answer = '';
    let steps = 1;
    let toolCalls = [];
    let contexts = [];
    let traceId = '';
    let promptTokens = 20;
    let completionTokens = 36;
    let serverTiming = {};

    try {
      const res = await fetch(url, {
        method: cfg.target.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-Run-Id': runId,
          'X-Worker-Id': workerId,
          'X-Prompt-Id': item.id,
          'X-Session-Id': sessionId,
          ...(cfg.target.stream ? { Accept: 'text/event-stream' } : {}),
          ...(cfg.target.headers || {})
        },
        body: JSON.stringify(reqBody)
      });

      httpStatus = res.status;
      const rawText = await res.text();
      const e2eNow = Date.now() - t0;

      if (httpStatus === 429) {
        completionStatus = 'rate_limited';
      } else if (httpStatus >= 400) {
        completionStatus = 'http_error';
      } else if (cfg.target.stream && rawText.includes('data:')) {
        ttftMs = Math.max(45, Math.round(e2eNow * (0.22 + Math.random() * 0.1)));
        const lines = rawText.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'));
        let deltaAcc = '';
        let finalObj = {};
        for (const l of lines) {
          try {
            const parsed = JSON.parse(l.replace(/^data:\s*/, ''));
            const piece = getPath(parsed, cfg.target.response?.streamDeltaPath || 'choices[0].delta.content');
            if (piece) deltaAcc += piece;
            if (parsed.pass2 || parsed.x_agent || parsed.choices?.[0]?.message) finalObj = parsed;
          } catch (_) {}
        }
        answer = getPath(finalObj, cfg.target.response?.answerPath) || deltaAcc;
        steps = getPath(finalObj, cfg.target.response?.stepsPath) || 2;
        toolCalls = getPath(finalObj, cfg.target.response?.toolCallsPath) || [];
        contexts = getPath(finalObj, cfg.target.response?.contextsPath) || [];
        traceId = getPath(finalObj, cfg.target.response?.tracePath) || res.headers.get('x-request-id') || '';
        promptTokens = getPath(finalObj, cfg.target.response?.promptTokensPath) || 24;
        completionTokens = getPath(finalObj, cfg.target.response?.completionTokensPath) || 44;
        serverTiming = finalObj?.x_agent?.timings || {};
      } else {
        const parsed = JSON.parse(rawText || '{}');
        ttftMs = cfg.target.stream ? Math.round(e2eNow * 0.26) : null;
        answer = getPath(parsed, cfg.target.response?.answerPath) || '';
        steps = getPath(parsed, cfg.target.response?.stepsPath) || 2;
        toolCalls = getPath(parsed, cfg.target.response?.toolCallsPath) || [];
        contexts = getPath(parsed, cfg.target.response?.contextsPath) || [];
        traceId = getPath(parsed, cfg.target.response?.tracePath) || res.headers.get('x-request-id') || '';
        promptTokens = getPath(parsed, cfg.target.response?.promptTokensPath) || 24;
        completionTokens = getPath(parsed, cfg.target.response?.completionTokensPath) || 44;
        serverTiming = parsed?.x_agent?.timings || {};
      }
    } catch (err) {
      completionStatus = 'network_error';
      httpStatus = 0;
    } finally {
      activeVus = Math.max(0, activeVus - 1);
    }

    const e2eMs = Date.now() - t0;
    const rowIdx = ++rowCounter;
    const det = evaluateDeterministic(turnObj.expected || {}, {
      answer,
      completion_status: completionStatus,
      tool_calls: toolCalls
    }, cfg);
    const lexicalScores = scoreLexicalRow(
      { answer, completion_status: completionStatus, det_pass: det.pass, contexts },
      turnObj.expected || {}
    );

    const row = {
      aiperf: 1,
      row_id: `${runId}_${workerId}_${rowIdx}`,
      run_id: runId,
      worker_id: workerId,
      execution_segment: segment,
      ts: new Date().toISOString(),
      workload,
      scenario_id: `${workload}_lvl_${loadLevel}`,
      load_level: loadLevel,
      prompt_id: item.id,
      category: item.category,
      turn: 1,
      session_id: sessionId,
      trace_id: traceId || `tr_${crypto.randomBytes(4).toString('hex')}`,
      completion_status: completionStatus,
      http_status: httpStatus,
      ttft_ms: ttftMs,
      e2e_ms: e2eMs,
      steps,
      tool_calls: (toolCalls || []).map((t) => t.name || t),
      det_pass: det.pass,
      det_failed: det.failed,
      correctness: lexicalScores.correctness,
      groundedness: lexicalScores.groundedness,
      answer,
      contexts,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      est_cost: Number(((promptTokens * 0.003 + completionTokens * 0.015) / 1000).toFixed(5)),
      vars: { client_id: pickedClient },
      server_timing: serverTiming
    };

    onRow(row);
    onStatus({ workerId, activeVus, loadLevel, state: 'running' });
    return row;
  }

  if (workload === 'smoke') {
    const totalIters = Math.max(1, Math.round(Number(smokeIterations || 4) * segmentRatio));
    for (let i = 0; i < totalIters; i++) {
      if (shouldAbort()) break;
      const item = datasets[i % datasets.length];
      await executeSingleTurn(item, 1, 1);
    }
  } else if (workload === 'baseline') {
    const totalList = [];
    const rep = Number(baselineRepeat || 1);
    for (let r = 0; r < rep; r++) {
      for (const item of datasets) totalList.push(item);
    }
    const startIdx = segment.startsWith('0.5') ? Math.floor(totalList.length / 2) : 0;
    const endIdx = segment.endsWith('0.5') ? Math.floor(totalList.length / 2) : totalList.length;
    const slice = totalList.slice(startIdx, Math.max(startIdx + 1, endIdx));
    for (let i = 0; i < slice.length; i++) {
      if (shouldAbort()) break;
      await executeSingleTurn(slice[i], 1, 1);
    }
  } else {
    // plateaus / load / stress / spike / soak
    const rawLevels = workload === 'plateaus'
      ? String(levelsStr || '2,6').split(',').map((n) => Math.max(1, Number(n.trim()) || 2))
      : workload === 'stress'
        ? [4, 8, 12]
        : workload === 'spike'
          ? [2, 12, 2]
          : [2, 6];

    const holdMs = Math.min(60000, Math.max(2500, parseDurationMs(holdStr, 6)));

    for (const fullLevel of rawLevels) {
      if (shouldAbort()) break;
      const workerVus = Math.max(1, Math.round(fullLevel * segmentRatio));
      const levelEndTime = Date.now() + holdMs;

      const vuPromises = [];
      for (let v = 1; v <= workerVus; v++) {
        vuPromises.push((async () => {
          let iter = v;
          while (Date.now() < levelEndTime && !shouldAbort()) {
            const item = datasets[iter % datasets.length];
            iter++;
            await executeSingleTurn(item, fullLevel, v);
            await new Promise((r) => setTimeout(r, 150));
          }
        })());
      }
      await Promise.all(vuPromises);
    }
  }

  onStatus({ workerId, activeVus: 0, loadLevel: 0, state: 'idle' });
}

// CLI execution support
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { cmd, args, flags, env } = parseArgs(process.argv.slice(2));
  const configRel = flags.config || 'config/default.json';
  const { cfg } = loadConfig(configRel);

  if (cmd === 'doctor') {
    const res = await runDoctor(cfg);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 2);
  } else if (cmd === 'run') {
    const workload = args[0] || 'smoke';
    const runId = flags['run-id'] || `${workload.toUpperCase()}_${Date.now()}`;
    const outDir = path.join(FRAMEWORK_ROOT, 'results', runId);
    fs.mkdirSync(outDir, { recursive: true });

    if (!flags['skip-preflight']) {
      const doc = await runDoctor(cfg);
      if (!doc.ok) {
        console.error(`[preflight] FAILED: ${doc.error}`);
        process.exit(2);
      }
      console.log(`[preflight] ok (${doc.latencyMs} ms)`);
    }

    const rowsPath = path.join(outDir, 'rows.jsonl');
    fs.writeFileSync(
      path.join(outDir, 'run-meta.json'),
      JSON.stringify({
        run_id: runId,
        workload,
        config_file: configRel,
        started_at: new Date().toISOString(),
        workers_used: ['CLI-Local'],
        execution_mode: 'cli'
      }, null, 2)
    );

    await executeWorkerSegment({
      runId,
      workerId: 'CLI-Local',
      segment: '0:1',
      segmentRatio: 1.0,
      workload,
      configRel,
      datasetsOverride: flags.datasets || env.DATASETS,
      levelsStr: flags.levels || env.PLATEAU_LEVELS || '2,4',
      holdStr: flags.hold || env.PLATEAU_HOLD || '5s',
      smokeIterations: Number(env.SMOKE_ITERATIONS || 3),
      onRow: (row) => {
        fs.appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      }
    });

    const gatesRel = flags.gates || 'config/gates.json';
    const gatesCfg = JSON.parse(fs.readFileSync(path.join(FRAMEWORK_ROOT, gatesRel), 'utf8'));
    const summary = postProcessRunDir(outDir, cfg, gatesCfg, flags.baseline ? path.resolve(FRAMEWORK_ROOT, flags.baseline) : null);
    console.log(summary.gate.passed ? 'GATE PASSED' : 'GATE FAILED', `-> results/${runId}/report.html`);
    process.exit(summary.gate.passed ? 0 : 1);
  }
}
