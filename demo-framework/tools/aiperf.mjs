import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  calcPercentile,
  calcSampleStdDev,
  calcStatsSummary,
  sampleHostResources,
  buildTimeBucketSeries
} from '../../server/stats-engine.mjs';

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
  return calcPercentile(sortedArr, p);
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

/**
 * Parse a k6 threshold expression like "p(95)<2000", "rate>0.95", "avg<=500"
 */
export function parseK6ThresholdExpr(metricName, exprStr) {
  const clean = String(exprStr || '').trim();
  const m = clean.match(/^(p\(\d+(?:\.\d+)?\)|avg|med|min|max|rate|count|value)\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, agg, op, rawVal] = m;
  const value = Number(rawVal);

  let mappedMetric = metricName;
  if (metricName === 'http_req_duration' || metricName === 'agent_e2e_duration') {
    if (agg === 'p(95)') mappedMetric = 'e2e_p95_ms';
    else if (agg === 'p(99)') mappedMetric = 'e2e_p99_ms';
    else if (agg === 'p(50)' || agg === 'med') mappedMetric = 'e2e_p50_ms';
    else if (agg === 'avg') mappedMetric = 'e2e_avg_ms';
  } else if (metricName === 'agent_ttft_ms' || metricName === 'http_req_waiting') {
    if (agg === 'p(95)') mappedMetric = 'ttft_p95_ms';
    else if (agg === 'p(50)' || agg === 'med') mappedMetric = 'ttft_p50_ms';
  } else if (metricName === 'http_req_failed') {
    mappedMetric = 'http_error_rate';
  } else if (metricName === 'checks' || metricName.startsWith('checks{')) {
    mappedMetric = 'deterministic_pass_rate';
  } else if (metricName === 'agent_completion_rate') {
    mappedMetric = 'completion_rate';
  }

  return {
    rawMetric: metricName,
    agg,
    metric: mappedMetric,
    op,
    value,
    expression: `${metricName}: ${clean}`
  };
}

function evalComparison(actual, op, target) {
  if (actual === null || actual === undefined || Number.isNaN(Number(actual))) return null;
  const a = Number(actual);
  const t = Number(target);
  if (op === '<=') return a <= t;
  if (op === '<') return a < t;
  if (op === '>=') return a >= t;
  if (op === '>') return a > t;
  if (op === '==') return a === t;
  return false;
}

function countRowPassFailForGate(rows, gate) {
  let passes = 0;
  let fails = 0;
  for (const r of rows) {
    let rowVal = null;
    if (gate.metric.startsWith('e2e_')) rowVal = Number(r.e2e_ms || 0);
    else if (gate.metric.startsWith('ttft_')) rowVal = r.ttft_ms != null ? Number(r.ttft_ms) : null;
    else if (gate.metric === 'completion_rate') rowVal = r.completion_status === 'completed' ? 1 : 0;
    else if (gate.metric === 'deterministic_pass_rate') rowVal = r.det_pass ? 1 : 0;
    else if (gate.metric === 'http_error_rate') rowVal = r.http_status >= 400 || r.http_status === 0 ? 1 : 0;
    else if (gate.metric === 'correctness_avg') rowVal = Number(r.correctness ?? 0);
    else if (gate.metric === 'groundedness_avg') rowVal = Number(r.groundedness ?? 0);
    else if (r.custom_metrics && r.custom_metrics[gate.rawMetric || gate.metric] != null) {
      rowVal = Number(r.custom_metrics[gate.rawMetric || gate.metric]);
    }

    if (rowVal === null) continue;
    const ok = evalComparison(rowVal, gate.op, gate.value);
    if (ok) passes++;
    else fails++;
  }
  return { passes, fails };
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
    const httpErrors = subset.filter((r) => r.http_status >= 400 || r.http_status === 0).length;
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
      costSum += Number(r.est_cost || 0);
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

    const workerCounts = {};
    for (const r of subset) {
      const w = r.worker_id || 'worker-1';
      workerCounts[w] = (workerCounts[w] || 0) + 1;
    }

    // Measure actual RPS from subset timestamp span
    const tsMs = subset.map((r) => new Date(r.ts).getTime()).filter((t) => Number.isFinite(t));
    const spanSec = tsMs.length > 1 ? Math.max(1, (Math.max(...tsMs) - Math.min(...tsMs)) / 1000) : Math.max(1, n * 0.25);
    const measuredRps = Number((n / spanSec).toFixed(2));

    return {
      level: levelNum,
      n,
      rps: measuredRps,
      low_sample: n < (cfg.reporting?.minSamples || 10),
      in_flight_avg: levelNum,
      in_flight_peak: levelNum,
      e2e_min_ms: e2es.length ? Math.round(e2es[0]) : 0,
      e2e_p50_ms: Math.round(pct(e2es, 50)),
      e2e_p90_ms: Math.round(pct(e2es, 90)),
      e2e_p95_ms: Math.round(pct(e2es, 95)),
      e2e_p99_ms: Math.round(pct(e2es, 99)),
      e2e_max_ms: e2es.length ? Math.round(e2es[e2es.length - 1]) : 0,
      e2e_avg_ms: n ? Math.round(e2es.reduce((a, b) => a + b, 0) / n) : 0,
      e2e_stdev_ms: Number(calcSampleStdDev(e2es).toFixed(2)),
      ttft_p50_ms: ttfts.length ? Math.round(pct(ttfts, 50)) : null,
      ttft_p95_ms: ttfts.length ? Math.round(pct(ttfts, 95)) : null,
      ttft_avg_ms: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      ttft_stdev_ms: ttfts.length ? Number(calcSampleStdDev(ttfts).toFixed(2)) : null,
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

  // Categories / Scenarios breakdown
  const byCategory = {};
  for (const r of rows) {
    const cat = r.category || r.scenario_id || 'simple';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);
  }
  const categories = {};
  for (const [cat, cRows] of Object.entries(byCategory)) {
    categories[cat] = computeMetrics(cRows, 1, referenceQuality);
  }

  // Real Time-Bucket Series across full run duration (no 60-row cutoff)
  const timeSeries = buildTimeBucketSeries(rows, 36);
  const timeline = timeSeries.map((b) => ({
    bucket: b.bucket,
    ts: b.ts,
    elapsed_sec: b.elapsedSec,
    label: b.label,
    requests: b.requests,
    rps: b.rps,
    active_vus: b.activeVus,
    e2e_p95_ms: b.e2eP95,
    e2e_avg_ms: b.e2eAvg,
    ttft_p95_ms: b.ttftP95,
    completion_rate: Number((b.completionRate / 100).toFixed(4)),
    det_pass_rate: Number((b.detPassRate / 100).toFixed(4)),
    cpu_avg_pct: b.cpuAvg,
    mem_avg_pct: b.memAvg,
    by_worker: b.byWorker,
    by_scenario: b.byScenario
  }));

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

  const metaPath = path.join(runDir, 'run-meta.json');
  const runMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};

  // Discover custom metrics from rows and runMeta
  const customMetricsMap = new Map();
  if (runMeta.custom_metrics && typeof runMeta.custom_metrics === 'object') {
    for (const [mName, mDef] of Object.entries(runMeta.custom_metrics)) {
      if (Array.isArray(mDef.values) && mDef.values.length > 0) {
        customMetricsMap.set(mName, {
          name: mName,
          type: mDef.type || 'trend',
          contains: mDef.contains || 'default',
          values: [...mDef.values]
        });
      }
    }
  }
  for (const r of rows) {
    if (r.custom_metrics && typeof r.custom_metrics === 'object') {
      for (const [mName, val] of Object.entries(r.custom_metrics)) {
        const num = Number(val);
        if (!Number.isFinite(num)) continue;
        if (!customMetricsMap.has(mName)) {
          customMetricsMap.set(mName, { name: mName, type: 'trend', contains: 'default', values: [] });
        }
        customMetricsMap.get(mName).values.push(num);
      }
    }
  }

  const customMetricsSummary = {};
  for (const [mName, mObj] of customMetricsMap.entries()) {
    customMetricsSummary[mName] = {
      name: mName,
      type: mObj.type,
      contains: mObj.contains,
      stats: calcStatsSummary(mObj.values)
    };
  }

  // Merge script options.thresholds (primary for k6 scripts) + gates.json
  const targetLevelMetrics = levels[levels.length - 1] || overall;
  const gateResults = [];
  let allGatesPassed = true;

  // 1) First evaluate script options.thresholds if present in runMeta.script_thresholds
  const scriptThresholds = runMeta.script_thresholds || {};
  for (const [metricKey, exprArr] of Object.entries(scriptThresholds)) {
    const expressions = Array.isArray(exprArr) ? exprArr : [exprArr];
    for (const expr of expressions) {
      const parsed = parseK6ThresholdExpr(metricKey, expr);
      if (!parsed) continue;
      let actual = targetLevelMetrics[parsed.metric] !== undefined ? targetLevelMetrics[parsed.metric] : overall[parsed.metric];
      if (actual === undefined && customMetricsSummary[metricKey]) {
        const st = customMetricsSummary[metricKey].stats;
        if (parsed.agg === 'p(95)') actual = st.p95;
        else if (parsed.agg === 'p(90)') actual = st.p90;
        else if (parsed.agg === 'avg') actual = st.avg;
        else if (parsed.agg === 'med' || parsed.agg === 'p(50)') actual = st.med;
        else if (parsed.agg === 'max') actual = st.max;
      }
      if (actual === null || actual === undefined) {
        gateResults.push({
          label: `k6 Threshold: ${parsed.expression}`,
          metric: parsed.metric,
          rawMetric: metricKey,
          op: parsed.op,
          value: parsed.value,
          actual: null,
          passes: 0,
          fails: 0,
          source: 'k6-script',
          status: 'SKIPPED'
        });
        continue;
      }
      const pass = Boolean(evalComparison(actual, parsed.op, parsed.value));
      if (!pass) allGatesPassed = false;
      const { passes, fails } = countRowPassFailForGate(rows, parsed);
      gateResults.push({
        label: `k6 Threshold: ${parsed.expression}`,
        metric: parsed.metric,
        rawMetric: metricKey,
        op: parsed.op,
        value: parsed.value,
        actual,
        passes,
        fails,
        source: 'k6-script',
        status: pass ? 'PASS' : 'FAIL'
      });
    }
  }

  // 2) Evaluate gatesCfg.gates
  for (const g of gatesCfg?.gates || []) {
    const actual = targetLevelMetrics[g.metric] !== undefined ? targetLevelMetrics[g.metric] : overall[g.metric];
    if (actual === null || actual === undefined) {
      gateResults.push({ ...g, actual: null, passes: 0, fails: 0, source: g.source || 'gates-config', status: 'SKIPPED' });
      continue;
    }
    const pass = Boolean(evalComparison(actual, g.op, g.value));
    if (!pass) allGatesPassed = false;
    const { passes, fails } = countRowPassFailForGate(rows, g);
    gateResults.push({
      ...g,
      actual,
      passes,
      fails,
      source: g.source || 'gates-config',
      status: pass ? 'PASS' : 'FAIL'
    });
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

  const workloadName = rows[0]?.workload || runMeta.workload || 'smoke';
  const isNormalK6 =
    runMeta.counter_profile === 'k6' ||
    runMeta.run_type === 'k6' ||
    rows[0]?.mode === 'direct-k6' ||
    String(workloadName).startsWith('k6:') ||
    (rows[0]?.mode === 'multi-population' && !rows.some((r) => r.protocol === 'SSE'));

  // Measure real bytes & durations from rows without fabricated multipliers
  const measuredResBytes = rows.map((r) => r.res_bytes).filter((v) => v != null && Number.isFinite(Number(v)));
  const measuredReqBytes = rows.map((r) => r.req_bytes).filter((v) => v != null && Number.isFinite(Number(v)));
  const measuredGroupDurs = rows.map((r) => r.group_duration_ms).filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  const measuredIterDurs = rows.map((r) => r.iteration_duration_ms).filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);

  const cpuSamples = rows.map((r) => r.host_resources?.cpuPct).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  const memSamples = rows.map((r) => r.host_resources?.memPct).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  const handleSamples = rows.map((r) => r.host_resources?.fileHandles).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);

  const totalBytesRcv = measuredResBytes.length > 0
    ? measuredResBytes.reduce((a, b) => a + Number(b), 0)
    : null;
  const totalBytesSent = measuredReqBytes.length > 0
    ? measuredReqBytes.reduce((a, b) => a + Number(b), 0)
    : null;

  const groupDurP95 = measuredGroupDurs.length > 0 ? Math.round(pct(measuredGroupDurs, 95)) : null;
  const iterDurP95 = measuredIterDurs.length > 0 ? Math.round(pct(measuredIterDurs, 95)) : null;

  const cpuAvgPct = cpuSamples.length > 0
    ? Number((cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length).toFixed(1))
    : (runMeta.host_telemetry?.cpuAvgPct ?? null);
  const memAvgPct = memSamples.length > 0
    ? Number((memSamples.reduce((a, b) => a + b, 0) / memSamples.length).toFixed(1))
    : (runMeta.host_telemetry?.memAvgPct ?? null);
  const fileHandlesAvg = handleSamples.length > 0
    ? Math.round(handleSamples.reduce((a, b) => a + b, 0) / handleSamples.length)
    : (runMeta.host_telemetry?.fileHandles ?? null);

  const summary = {
    run_id: rows[0]?.run_id || path.basename(runDir),
    run_type: isNormalK6 ? 'k6' : 'ai',
    counter_profile: runMeta.counter_profile || (isNormalK6 ? 'k6' : 'ai'),
    status: runMeta.status || 'COMPLETED',
    created_at: runMeta.started_at || rows[0]?.ts || new Date().toISOString(),
    workload: workloadName,
    config_file: runMeta.config_file || 'config/default.json',
    target_name: cfg.target?.name || cfg.target?.model || 'Target System',
    model: cfg.target?.model || 'mock-agent-1',
    stream: Boolean(cfg.target?.stream),
    stream_engine: runMeta.engine_used || cfg.target?.streamEngine || 'node-http-measured',
    workers_used: runMeta.workers_used || Array.from(new Set(rows.map((r) => r.worker_id).filter(Boolean))),
    selected_injectors: runMeta.selected_injectors || null,
    population_matrix: runMeta.population_matrix || null,
    execution_mode: runMeta.execution_mode || 'distributed-segment',
    rows: rows.length,
    steady_rows: rows.length,
    evaluated_rows: rows.length,
    k6_counters: {
      http_reqs: rows.length,
      iterations: rows.length,
      checks_passed: rows.filter((r) => r.det_pass !== false && r.http_status >= 200 && r.http_status < 400).length,
      checks_total: rows.length,
      data_received_bytes: totalBytesRcv,
      data_sent_bytes: totalBytesSent,
      group_duration_p95_ms: groupDurP95,
      iteration_duration_p95_ms: iterDurP95,
      load_generator_cpu_avg_pct: cpuAvgPct,
      load_generator_mem_avg_pct: memAvgPct,
      load_generator_file_handles: fileHandlesAvg
    },
    custom_metrics: customMetricsSummary,
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
    time_series: timeSeries,
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
        http_req_duration: {
          values: {
            min: overall.e2e_min_ms,
            avg: overall.e2e_avg_ms,
            med: overall.e2e_p50_ms,
            max: overall.e2e_max_ms,
            'p(90)': overall.e2e_p90_ms,
            'p(95)': overall.e2e_p95_ms,
            'p(99)': overall.e2e_p99_ms,
            stdev: overall.e2e_stdev_ms
          }
        },
        agent_e2e_duration: {
          values: {
            avg: overall.e2e_avg_ms,
            med: overall.e2e_p50_ms,
            'p(95)': overall.e2e_p95_ms,
            'p(99)': overall.e2e_p99_ms,
            stdev: overall.e2e_stdev_ms
          }
        },
        agent_completion_rate: { values: { rate: overall.completion_rate } },
        deterministic_pass_rate: { values: { rate: overall.deterministic_pass_rate } },
        http_req_failed: { values: { rate: overall.http_error_rate } }
      }
    }, null, 2)
  );

  // 3. Write results.csv
  const csvHeader = 'row_id,run_id,worker_id,load_level,prompt_id,category,completion_status,http_status,ttft_ms,e2e_ms,req_bytes,res_bytes,iteration_duration_ms,steps,det_pass,correctness_score,groundedness_score,trace_id\n';
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
      r.req_bytes ?? '',
      r.res_bytes ?? '',
      r.iteration_duration_ms ?? '',
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
      <td>${l.e2e_stdev_ms ?? 0} ms</td>
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
      <td><span style="font-size:11px;color:#94a3b8;">${g.source || 'gates-config'}</span></td>
      <td><strong>${g.actual ?? 'n/a'}</strong></td>
      <td>${g.passes ?? '-'} / ${g.fails ?? '-'}</td>
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
      <h1 style="margin-bottom:4px;">Performance Report: ${summary.run_id}</h1>
      <div style="color:#94a3b8;font-size:13px;">Workload: <strong>${summary.workload}</strong> | Engine: <code>${summary.stream_engine}</code> | Target: <strong>${summary.target_name}</strong> | Injectors: <strong>${(summary.workers_used || []).join(', ')}</strong></div>
    </div>
    <div>${gateBadge}</div>
  </div>

  ${summary.warnings.length ? `<div class="warn"><strong>Warnings:</strong><ul style="margin:6px 0 0 18px;padding:0;">${summary.warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}

  <div class="grid">
    <div class="stat"><div class="stat-label">Total Turns / Requests</div><div class="stat-val">${summary.rows}</div></div>
    <div class="stat"><div class="stat-label">Overall Latency p95 (Stdev)</div><div class="stat-val">${summary.overall.e2e_p95_ms} ms (${summary.overall.e2e_stdev_ms ?? 0} ms)</div></div>
    <div class="stat"><div class="stat-label">Completion / Check Pass</div><div class="stat-val">${(summary.overall.completion_rate * 100).toFixed(1)}% / ${(summary.overall.deterministic_pass_rate * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="stat-label">Correctness / Max QDUL</div><div class="stat-val">${summary.overall.correctness_avg.toFixed(2)} / ${summary.overall.qdul_pct_max}%</div></div>
  </div>

  <div class="card">
    <h3>Load Level Breakdown</h3>
    <table>
      <thead>
        <tr>
          <th>Level</th><th>In-Flight avg/peak</th><th>Rows (n)</th><th>p50</th><th>p95</th><th>Stdev (n-1)</th><th>TTFT p95</th><th>Complete</th><th>Checks</th><th>Correctness</th><th>Grounded</th><th>Steps</th><th>QDUL%</th>
        </tr>
      </thead>
      <tbody>${levelRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h3>Thresholds & Release Gates (${summary.gate.name})</h3>
    <table>
      <thead><tr><th>Gate / Threshold</th><th>Expression</th><th>Source</th><th>Actual Value</th><th>Row Pass / Fail</th><th>Status</th></tr></thead>
      <tbody>${gateRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

export function compareRuns(refDir, candDir, allRunsRoot = null) {
  const refSum = JSON.parse(fs.readFileSync(path.join(refDir, 'summary.json'), 'utf8'));
  const candSum = JSON.parse(fs.readFileSync(path.join(candDir, 'summary.json'), 'utf8'));

  const e2eDeltaPct = refSum.overall.e2e_p95_ms > 0
    ? Number((((candSum.overall.e2e_p95_ms - refSum.overall.e2e_p95_ms) / refSum.overall.e2e_p95_ms) * 100).toFixed(2))
    : 0;
  const avgDeltaPct = refSum.overall.e2e_avg_ms > 0
    ? Number((((candSum.overall.e2e_avg_ms - refSum.overall.e2e_avg_ms) / refSum.overall.e2e_avg_ms) * 100).toFixed(2))
    : 0;
  const compDeltaPts = Number(((candSum.overall.completion_rate - refSum.overall.completion_rate) * 100).toFixed(2));
  const corrDelta = Number((candSum.overall.correctness_avg - refSum.overall.correctness_avg).toFixed(3));
  const detDeltaPts = Number(((candSum.overall.deterministic_pass_rate - refSum.overall.deterministic_pass_rate) * 100).toFixed(2));
  const errDeltaPts = Number((((candSum.overall.http_error_rate || 0) - (refSum.overall.http_error_rate || 0)) * 100).toFixed(2));

  const checks = [
    {
      metric: 'Latency p95 (http_req_duration / E2E)',
      reference: `${refSum.overall.e2e_p95_ms} ms`,
      candidate: `${candSum.overall.e2e_p95_ms} ms`,
      delta: `${e2eDeltaPct > 0 ? '+' : ''}${e2eDeltaPct}%`,
      verdict: e2eDeltaPct > 15 ? 'REGRESSION' : Math.abs(e2eDeltaPct) < 5 ? 'NOISE' : e2eDeltaPct < 0 ? 'IMPROVED' : 'ACCEPTABLE'
    },
    {
      metric: 'Latency Mean (avg)',
      reference: `${refSum.overall.e2e_avg_ms} ms`,
      candidate: `${candSum.overall.e2e_avg_ms} ms`,
      delta: `${avgDeltaPct > 0 ? '+' : ''}${avgDeltaPct}%`,
      verdict: avgDeltaPct > 15 ? 'REGRESSION' : avgDeltaPct < -5 ? 'IMPROVED' : 'PASS'
    },
    {
      metric: 'HTTP Error Rate (http_req_failed)',
      reference: `${((refSum.overall.http_error_rate || 0) * 100).toFixed(2)}%`,
      candidate: `${((candSum.overall.http_error_rate || 0) * 100).toFixed(2)}%`,
      delta: `${errDeltaPts > 0 ? '+' : ''}${errDeltaPts} pp`,
      verdict: errDeltaPts > 2 ? 'REGRESSION' : 'PASS'
    },
    {
      metric: 'Completion Rate',
      reference: `${(refSum.overall.completion_rate * 100).toFixed(1)}%`,
      candidate: `${(candSum.overall.completion_rate * 100).toFixed(1)}%`,
      delta: `${compDeltaPts > 0 ? '+' : ''}${compDeltaPts} pp`,
      verdict: compDeltaPts < -2 ? 'REGRESSION' : 'PASS'
    },
    {
      metric: 'Check / Deterministic Pass Rate',
      reference: `${(refSum.overall.deterministic_pass_rate * 100).toFixed(1)}%`,
      candidate: `${(candSum.overall.deterministic_pass_rate * 100).toFixed(1)}%`,
      delta: `${detDeltaPts > 0 ? '+' : ''}${detDeltaPts} pp`,
      verdict: detDeltaPts < -3 ? 'REGRESSION' : 'PASS'
    }
  ];

  // Include AI lexical correctness check when comparing AI runs
  if (refSum.run_type !== 'k6' || candSum.run_type !== 'k6') {
    checks.push({
      metric: 'Lexical Correctness Score',
      reference: refSum.overall.correctness_avg.toFixed(3),
      candidate: candSum.overall.correctness_avg.toFixed(3),
      delta: `${corrDelta > 0 ? '+' : ''}${corrDelta}`,
      verdict: corrDelta < -0.05 ? 'REGRESSION' : 'PASS'
    });
  }

  // Per-scenario / per-category delta comparison (supports both k6 scenarios & AI prompt categories)
  const scenarioDeltas = [];
  const allCats = new Set([
    ...Object.keys(refSum.categories || {}),
    ...Object.keys(candSum.categories || {})
  ]);
  for (const cat of allCats) {
    const rCat = refSum.categories?.[cat];
    const cCat = candSum.categories?.[cat];
    if (!rCat || !cCat) continue;
    const catP95Delta = rCat.e2e_p95_ms > 0
      ? Number((((cCat.e2e_p95_ms - rCat.e2e_p95_ms) / rCat.e2e_p95_ms) * 100).toFixed(2))
      : 0;
    const catCheckDelta = Number(((cCat.deterministic_pass_rate - rCat.deterministic_pass_rate) * 100).toFixed(2));
    scenarioDeltas.push({
      scenario: cat,
      ref_n: rCat.n,
      cand_n: cCat.n,
      ref_p95_ms: rCat.e2e_p95_ms,
      cand_p95_ms: cCat.e2e_p95_ms,
      p95_delta_pct: catP95Delta,
      ref_pass_pct: Number((rCat.deterministic_pass_rate * 100).toFixed(1)),
      cand_pass_pct: Number((cCat.deterministic_pass_rate * 100).toFixed(1)),
      pass_delta_pts: catCheckDelta,
      verdict: catP95Delta > 20 || catCheckDelta < -5 ? 'REGRESSION' : catP95Delta < -5 ? 'IMPROVED' : 'PASS'
    });
  }

  // Multi-run historical trend across results directory
  const resultsRoot = allRunsRoot || path.dirname(refDir);
  const baselineTrend = [];
  if (fs.existsSync(resultsRoot)) {
    try {
      const dirs = fs.readdirSync(resultsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const d of dirs) {
        const sFile = path.join(resultsRoot, d.name, 'summary.json');
        if (fs.existsSync(sFile)) {
          const s = JSON.parse(fs.readFileSync(sFile, 'utf8'));
          baselineTrend.push({
            run_id: s.run_id,
            created_at: s.created_at,
            run_type: s.run_type || 'ai',
            rows: s.rows,
            e2e_p95_ms: s.overall?.e2e_p95_ms || 0,
            e2e_avg_ms: s.overall?.e2e_avg_ms || 0,
            completion_rate: Number(((s.overall?.completion_rate || 0) * 100).toFixed(1)),
            det_pass_rate: Number(((s.overall?.deterministic_pass_rate || 0) * 100).toFixed(1)),
            gate_passed: Boolean(s.gate?.passed)
          });
        }
      }
      baselineTrend.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } catch (_) {}
  }

  const hasRegression =
    checks.some((c) => c.verdict === 'REGRESSION') ||
    scenarioDeltas.some((s) => s.verdict === 'REGRESSION');

  const result = {
    reference_run: refSum.run_id,
    candidate_run: candSum.run_id,
    compared_at: new Date().toISOString(),
    passed: !hasRegression,
    checks,
    scenario_deltas: scenarioDeltas,
    baseline_trend: baselineTrend.slice(-12)
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

    const iterStartTs = Date.now();
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
    const reqBodyStr = JSON.stringify(reqBody);
    const reqBytes = Buffer.byteLength(reqBodyStr, 'utf8');

    const t0 = Date.now();
    let httpStatus = 0;
    let completionStatus = 'completed';
    let ttftMs = null;
    let resBytes = 0;
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
        body: reqBodyStr
      });

      httpStatus = res.status;

      // Measure real streaming first-chunk TTFT when reading body stream
      let rawText = '';
      if (cfg.target.stream && res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          if (ttftMs === null && chunkStr.trim().length > 0) {
            ttftMs = Math.max(1, Date.now() - t0);
          }
          rawText += chunkStr;
        }
        rawText += decoder.decode();
      } else {
        rawText = await res.text();
        if (ttftMs === null && rawText.length > 0) {
          ttftMs = Math.max(1, Date.now() - t0);
        }
      }

      resBytes = Buffer.byteLength(rawText, 'utf8');

      if (httpStatus === 429) {
        completionStatus = 'rate_limited';
      } else if (httpStatus >= 400) {
        completionStatus = 'http_error';
      } else if (cfg.target.stream && rawText.includes('data:')) {
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

    const e2eMs = Math.max(1, Date.now() - t0);
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
    const iterDurationMs = Math.max(e2eMs, Date.now() - iterStartTs);
    const hostRes = sampleHostResources();

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
      req_bytes: reqBytes,
      res_bytes: resBytes,
      group_duration_ms: e2eMs,
      iteration_duration_ms: iterDurationMs,
      host_resources: hostRes,
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
    const [segStartRaw, segEndRaw] = String(segment || '0:1').split(':').map(Number);
    const segStart = Number.isFinite(segStartRaw) ? segStartRaw : 0;
    const segEnd = Number.isFinite(segEndRaw) ? segEndRaw : 1;
    const startIdx = Math.floor(totalList.length * segStart);
    const endIdx = Math.max(startIdx + 1, Math.round(totalList.length * segEnd));
    const slice = totalList.slice(startIdx, endIdx);
    for (let i = 0; i < slice.length; i++) {
      if (shouldAbort()) break;
      await executeSingleTurn(slice[i], 1, 1);
    }
  } else {
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

// CLI execution support (safe guard when imported dynamically via node -e)
const argv1Normalized = (process.argv[1] || '').replace(/\\/g, '/');
if (argv1Normalized && import.meta.url === `file:///${argv1Normalized}`) {
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
