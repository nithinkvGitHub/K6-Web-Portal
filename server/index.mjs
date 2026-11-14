import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startMockAgent } from '../demo-framework/mock/mock-agent.mjs';
import {
  FRAMEWORK_ROOT,
  loadConfig,
  runDoctor,
  postProcessRunDir,
  compareRuns
} from '../demo-framework/tools/aiperf.mjs';
import { inspectK6Script } from '../demo-framework/tools/direct-k6-runner.mjs';
import {
  listFrameworkProjects,
  saveUploadedProject,
  generateCompositeK6Script
} from '../demo-framework/tools/population-orchestrator.mjs';
import { startWorkerAgent } from './worker-agent.mjs';
import { ensureSeedRuns } from './seed-runs.mjs';
import { buildK6ExportCsvFiles, createZipBuffer } from './k6-zip-exporter.mjs';
import { computeSegmentSlices, sampleHostResources } from './stats-engine.mjs';
import {
  detectK6Binary,
  exportPrometheusFormat,
  exportInfluxLineProtocol,
  exportJUnitXml
} from './k6-cli-bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.UI_PORT || 4000);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

let activeFrameworkRoot = process.env.AIPERF_FRAMEWORK_DIR || FRAMEWORK_ROOT;

function isSafeSubpath(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(candidatePath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function getLocalIpAddresses() {
  const ips = new Set(['127.0.0.1', 'localhost', '::1']);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.address) ips.add(net.address);
    }
  }
  return ips;
}

let workerNodes = [
  {
    id: 'EC2-Worker-01',
    name: 'EC2-Worker-01 (Web Portal Host)',
    url: 'http://127.0.0.1:4101',
    region: 'ap-south-1a',
    instanceType: `${os.cpus().length} vCPU / ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
    privateIp: '127.0.0.1',
    isLocalHost: true,
    mode: 'local-host'
  },
  {
    id: 'EC2-Worker-02',
    name: 'EC2-Worker-02 (Secondary Injector)',
    url: 'http://127.0.0.1:4102',
    region: 'ap-south-1b',
    instanceType: `${os.cpus().length} vCPU / ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
    privateIp: '127.0.0.1',
    isLocalHost: false,
    mode: 'secondary-node'
  }
];

let liveClients = new Set();
let activePipeline = null;
let activeRunAbortController = null;
let runsIndexCache = null;

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of liveClients) {
    try {
      res.write(payload);
    } catch {
      liveClients.delete(res);
    }
  }
}

function logPipeline(stage, message, level = 'info') {
  const entry = { ts: new Date().toISOString(), stage, message, level };
  if (activePipeline) {
    activePipeline.logs.push(entry);
    if (activePipeline.consoleLogPath) {
      try {
        fs.appendFileSync(
          activePipeline.consoleLogPath,
          `[${entry.ts}] [${level.toUpperCase()}] [${stage}] ${message}\n`
        );
      } catch (_) {}
    }
  }
  broadcast('log', entry);
}

function listDirJsonFiles(subDir) {
  const full = path.join(activeFrameworkRoot, subDir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.json') || f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.csv'))
    .map((f) => `${subDir}/${f}`);
}

function invalidateRunsIndex() {
  runsIndexCache = null;
}

function listAllRuns(forceRebuild = false) {
  const resultsDir = path.join(activeFrameworkRoot, 'results');
  if (!fs.existsSync(resultsDir)) return [];
  const indexFile = path.join(resultsDir, 'runs-index.json');

  if (!forceRebuild && runsIndexCache) {
    return runsIndexCache;
  }

  const dirs = fs.readdirSync(resultsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const runs = [];
  for (const d of dirs) {
    const sumPath = path.join(resultsDir, d.name, 'summary.json');
    if (fs.existsSync(sumPath)) {
      try {
        const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        runs.push(sum);
      } catch (_) {}
    }
  }
  runs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  runsIndexCache = runs;
  try {
    fs.writeFileSync(indexFile, JSON.stringify({ updated_at: new Date().toISOString(), count: runs.length, runs }, null, 2));
  } catch (_) {}
  return runs;
}

async function fetchWorkerHealth(worker, idx = 0) {
  const localIps = getLocalIpAddresses();
  let isLocal = Boolean(worker.isLocalHost);
  try {
    const u = new URL(worker.url);
    if (idx === 0 && localIps.has(u.hostname)) isLocal = true;
  } catch (_) {}

  try {
    const headers = process.env.AIPERF_TOKEN ? { 'X-AIPerf-Token': process.env.AIPERF_TOKEN } : {};
    const res = await fetch(`${worker.url}/health`, { headers, signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    return { ...worker, isLocalHost: isLocal, online: true, health: data };
  } catch (err) {
    return {
      ...worker,
      isLocalHost: isLocal,
      online: false,
      error: err.message,
      health: { status: 'offline', activeVus: 0, cpuPct: 0, memPct: 0, fileHandles: 0 }
    };
  }
}

export async function orchestrateDistributedRun(params) {
  const {
    mode = 'aiperf', // 'aiperf' | 'direct-k6' | 'multi-population'
    projectId = 'enterprise-omni-framework',
    populations = [],
    scriptRelPath = 'k6/flows/ecommerce-userflows.js',
    selectedScenarios = null,
    envVars = {},
    vusOverride = null,
    durationOverride = null,
    runId = `RUN_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    workload = mode === 'multi-population'
      ? `multipop:${projectId}`
      : mode === 'direct-k6'
        ? `k6:${path.basename(scriptRelPath)}`
        : 'plateaus',
    configRel = 'config/perfpilot.json',
    secondaryConfigRel = 'config/perfpilot-sse.json',
    gatesRel = 'config/gates.perfpilot.json',
    datasetsOverride = null,
    levelsStr = '2,4',
    holdStr = '6s',
    smokeIterations = 4,
    baselineRepeat = 1,
    baselineRunId = '',
    skipPreflight = mode === 'direct-k6' || mode === 'multi-population',
    distributionMode = 'worker-1-only',
    selectedWorkerIds = null,
    counterProfile = null,
    webhookUrl = process.env.AIPERF_WEBHOOK_URL || null
  } = params;

  const outDir = path.join(activeFrameworkRoot, 'results', runId);
  if (!isSafeSubpath(path.join(activeFrameworkRoot, 'results'), outDir)) {
    throw new Error(`Invalid runId: ${runId}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const rowsPath = path.join(outDir, 'rows.jsonl');
  const consoleLogPath = path.join(outDir, 'console.log');
  fs.writeFileSync(rowsPath, '');
  fs.writeFileSync(consoleLogPath, '');

  const { cfg } = loadConfig(configRel, activeFrameworkRoot);
  const gatesCfg = JSON.parse(fs.readFileSync(path.join(activeFrameworkRoot, gatesRel), 'utf8'));

  // Resolve N selected workers dynamically
  let selectedWorkers = [];
  if (Array.isArray(selectedWorkerIds) && selectedWorkerIds.length > 0) {
    selectedWorkers = workerNodes.filter((w) => selectedWorkerIds.includes(w.id));
  }
  if (selectedWorkers.length === 0) {
    if (distributionMode === 'worker-1-only') selectedWorkers = [workerNodes[0]];
    else if (distributionMode === 'worker-2-only' && workerNodes[1]) selectedWorkers = [workerNodes[1]];
    else if (distributionMode === 'split-all') selectedWorkers = [...workerNodes];
    else selectedWorkers = workerNodes.slice(0, 2);
  }
  selectedWorkers = selectedWorkers.filter(Boolean);
  if (selectedWorkers.length === 0) selectedWorkers = [workerNodes[0]];

  // Compute exact k6 execution segments for N selected workers
  const segmentSlices = computeSegmentSlices(selectedWorkers.length);
  const k6BinInfo = detectK6Binary();

  // Inspect script thresholds if direct-k6 mode, or project counterProfile if multi-population mode
  let scriptThresholds = {};
  let resolvedCounterProfile = counterProfile;
  if (mode === 'direct-k6') {
    try {
      const inspected = inspectK6Script(scriptRelPath, activeFrameworkRoot);
      scriptThresholds = inspected.thresholds || {};
    } catch (_) {}
    if (!resolvedCounterProfile) resolvedCounterProfile = 'k6';
  } else if (mode === 'multi-population') {
    const projects = listFrameworkProjects(activeFrameworkRoot);
    const proj = projects.find((p) => p.id === projectId);
    if (!resolvedCounterProfile && proj?.counterProfile && proj.counterProfile !== 'auto') {
      resolvedCounterProfile = proj.counterProfile;
    }
  }

  activeRunAbortController = new AbortController();
  const runSignal = activeRunAbortController.signal;

  activePipeline = {
    runId,
    mode,
    workload,
    configRel,
    gatesRel,
    distributionMode,
    selectedWorkers: selectedWorkers.map((w) => ({ id: w.id, url: w.url, privateIp: w.privateIp })),
    workersUsed: selectedWorkers.map((w) => w.id),
    segmentSlices,
    startedAt: new Date().toISOString(),
    stage: 'stage1_preflight',
    aborted: false,
    consoleLogPath,
    rows: [],
    logs: [],
    workerStats: {},
    doctorResult: null,
    summary: null
  };

  broadcast('pipeline_state', activePipeline);
  logPipeline(
    'Stage 1: Node Pre-Flight',
    `Starting pipeline for Run ID: ${runId} (${workload}) across ${selectedWorkers.length} injector(s): [${selectedWorkers.map((w) => w.id).join(', ')}]`,
    'info'
  );

  // STAGE 1: Node Pre-flight (doctor.mjs)
  if (!skipPreflight) {
    logPipeline('Stage 1: Node Pre-Flight', `Executing tools/lib/doctor.mjs probe against ${cfg.target.baseUrl}${cfg.target.path}...`, 'info');
    const doc = await runDoctor(cfg, activeFrameworkRoot);
    activePipeline.doctorResult = doc;
    broadcast('pipeline_state', activePipeline);

    if (!doc.ok) {
      activePipeline.stage = 'failed';
      logPipeline('Stage 1: Node Pre-Flight', `[FATAL] Preflight failed: ${doc.error}`, 'error');
      broadcast('pipeline_state', activePipeline);
      return;
    }
    logPipeline('Stage 1: Node Pre-Flight', `[preflight] ok (${doc.latencyMs} ms) — Answer & response mappings verified.`, 'success');
  } else {
    logPipeline('Stage 1: Node Pre-Flight', `Skipped preflight probe (--skip-preflight enabled).`, 'warn');
  }

  if (runSignal.aborted || activePipeline.aborted) {
    return;
  }

  // Write run-meta.json with full injector selection, segment matrix, and engine info
  const runMeta = {
    run_id: runId,
    mode,
    workload,
    counter_profile: resolvedCounterProfile || null,
    config_file: configRel,
    gates_file: gatesRel,
    script_path: mode === 'direct-k6' ? scriptRelPath : null,
    script_thresholds: scriptThresholds,
    started_at: activePipeline.startedAt,
    status: 'RUNNING',
    workers_used: selectedWorkers.map((w) => w.id),
    selected_injectors: selectedWorkers.map((w, idx) => ({
      id: w.id,
      url: w.url,
      privateIp: w.privateIp,
      segment: segmentSlices[idx]?.segment || '0:1',
      ratio: segmentSlices[idx]?.ratio || 1
    })),
    population_matrix: mode === 'multi-population' ? populations : null,
    execution_mode: distributionMode,
    engine_used: k6BinInfo.available ? `k6-cli (${k6BinInfo.version})` : 'node-http-measured',
    target: {
      name: cfg.target.name,
      baseUrl: cfg.target.baseUrl,
      path: cfg.target.path,
      model: cfg.target.model,
      stream: cfg.target.stream
    }
  };
  fs.writeFileSync(path.join(outDir, 'run-meta.json'), JSON.stringify(runMeta, null, 2));

  // STAGE 2: Distributed execution across selected Load Injectors
  activePipeline.stage = 'stage2_k6_distributed';
  broadcast('pipeline_state', activePipeline);

  if (mode === 'multi-population') {
    logPipeline(
      'Stage 1: Bundle & Sync',
      `Packaging full framework project "${projectId}" (flows/, lib/, data/, config/) and syncing bundle to ${selectedWorkers.map((w) => `${w.id} (${w.privateIp})`).join(' & ')}...`,
      'success'
    );
  }

  const authHeaders = process.env.AIPERF_TOKEN ? { 'X-AIPerf-Token': process.env.AIPERF_TOKEN } : {};

  const workerPromises = selectedWorkers.map((worker, idx) => {
    const slice = segmentSlices[idx] || { segment: '0:1', sequence: '0,1', ratio: 1.0 };
    const segment = slice.segment;
    const segmentSequence = slice.sequence;
    const segmentRatio = distributionMode === 'multi-protocol-http-sse' ? 1.0 : slice.ratio;
    const workerConfig = distributionMode === 'multi-protocol-http-sse' && idx === 1 ? secondaryConfigRel : configRel;

    if (mode === 'multi-population') {
      const assignedSummary = (populations || [])
        .map((p) => {
          const share = selectedWorkers.length === 1
            ? 100
            : p.injectorWeights?.[worker.id] ?? (idx === 0 ? p.injector1Pct : idx === 1 ? p.injector2Pct : Math.round(100 / selectedWorkers.length));
          return `${p.populationId}:${share}%`;
        })
        .join(', ');
      logPipeline(
        'Stage 2: Multi-Injector Populations',
        `Triggering injector ${worker.id} (${worker.privateIp}) with Population matrix [${assignedSummary}]`,
        'info'
      );
    } else {
      logPipeline(
        'Stage 2: Distributed k6',
        `Dispatching workload "${workload}" to ${worker.id} (${worker.privateIp}) [segment=${segment}, seq=${segmentSequence}, engine=${runMeta.engine_used}]`,
        'info'
      );
    }

    return new Promise(async (resolve) => {
      const streamAbortCtrl = new AbortController();
      const onGlobalAbort = () => {
        try { streamAbortCtrl.abort(); } catch (_) {}
        resolve();
      };
      runSignal.addEventListener('abort', onGlobalAbort, { once: true });

      try {
        const streamRes = await fetch(`${worker.url}/stream`, {
          headers: authHeaders,
          signal: streamAbortCtrl.signal
        });
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();

        (async () => {
          let buf = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const chunks = buf.split('\n\n');
              buf = chunks.pop() || '';
              for (const chunk of chunks) {
                const lines = chunk.split('\n');
                const evLine = lines.find((l) => l.startsWith('event:'));
                const dataLine = lines.find((l) => l.startsWith('data:'));
                if (!evLine || !dataLine) continue;
                const evType = evLine.replace('event:', '').trim();
                const payload = JSON.parse(dataLine.replace('data:', '').trim());

                if (evType === 'row' && payload.run_id === runId && !activePipeline?.aborted) {
                  fs.appendFileSync(rowsPath, JSON.stringify(payload) + '\n');
                  activePipeline.rows.push(payload);
                  broadcast('live_row', payload);
                  logPipeline(
                    'Stage 2: Distributed k6',
                    `[${payload.worker_id}] Turn ${payload.prompt_id} (${payload.category}) -> HTTP ${payload.http_status} in ${payload.e2e_ms}ms (TTFT: ${payload.ttft_ms ?? 'n/a'}ms, check: ${payload.det_pass})`,
                    payload.det_pass ? 'info' : 'warn'
                  );
                } else if (evType === 'status') {
                  if (activePipeline) activePipeline.workerStats[worker.id] = payload;
                  broadcast('worker_status', payload);
                } else if (evType === 'completed' && payload.runId === runId) {
                  logPipeline('Stage 2: Distributed k6', `[${worker.id}] Finished segment ${segment} (${payload.rowsCompleted} turns completed).`, 'success');
                  streamAbortCtrl.abort();
                  resolve();
                } else if (evType === 'aborted') {
                  logPipeline('Stage 2: Distributed k6', `[${worker.id}] Aborted segment ${segment} (${payload.rowsCompleted || 0} turns before stop).`, 'warn');
                  streamAbortCtrl.abort();
                  resolve();
                } else if (evType === 'error' && payload.runId === runId) {
                  logPipeline('Stage 2: Distributed k6', `[${worker.id}] Error: ${payload.error}`, 'error');
                  streamAbortCtrl.abort();
                  resolve();
                }
              }
            }
          } catch (_) {
            resolve();
          }
        })();

        // Trigger the job on the worker
        await fetch(`${worker.url}/job/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            mode,
            workerIndex: idx,
            workerCount: selectedWorkers.length,
            projectId,
            populations,
            scriptRelPath,
            selectedScenarios,
            envVars,
            vusOverride,
            durationOverride,
            runId,
            segment,
            segmentSequence,
            segmentRatio,
            workload,
            configRel: workerConfig,
            datasetsOverride,
            levelsStr,
            holdStr,
            smokeIterations,
            baselineRepeat,
            baseRoot: activeFrameworkRoot
          })
        });
      } catch (err) {
        if (!runSignal.aborted) {
          logPipeline('Stage 2: Distributed k6', `Failed communicating with ${worker.id}: ${err.message}`, 'error');
        }
        resolve();
      }
    });
  });

  await Promise.all(workerPromises);

  // CRITICAL: If run was stopped/aborted by the user, do NOT run Stage 3 post-processing into a false PASSED state!
  if (runSignal.aborted || activePipeline?.aborted || activePipeline?.stage === 'stopped') {
    runMeta.status = 'ABORTED';
    runMeta.stopped_at = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'run-meta.json'), JSON.stringify(runMeta, null, 2));

    const abortedSummary = {
      run_id: runId,
      run_type: mode === 'direct-k6' ? 'k6' : 'ai',
      status: 'ABORTED',
      created_at: activePipeline?.startedAt || new Date().toISOString(),
      workload,
      config_file: configRel,
      target_name: cfg.target?.name || 'Target System',
      model: cfg.target?.model || 'mock-agent-1',
      stream: Boolean(cfg.target?.stream),
      stream_engine: runMeta.engine_used,
      workers_used: selectedWorkers.map((w) => w.id),
      selected_injectors: runMeta.selected_injectors,
      execution_mode: distributionMode,
      rows: activePipeline?.rows?.length || 0,
      steady_rows: activePipeline?.rows?.length || 0,
      evaluated_rows: 0,
      levels: [],
      categories: {},
      overall: {
        n: activePipeline?.rows?.length || 0,
        e2e_p50_ms: 0,
        e2e_p95_ms: 0,
        e2e_p99_ms: 0,
        e2e_avg_ms: 0,
        e2e_stdev_ms: 0,
        ttft_p50_ms: null,
        ttft_p95_ms: null,
        completion_rate: 0,
        http_error_rate: 0,
        deterministic_pass_rate: 0,
        correctness_avg: 0,
        groundedness_avg: 0,
        qdul_pct_max: 0
      },
      timeline: [],
      time_series: [],
      warnings: ['Run was manually stopped by user before completion.'],
      gate: {
        name: gatesCfg?.name || 'Release Gates',
        passed: false,
        aborted: true,
        results: []
      },
      slowest: [],
      failures: []
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(abortedSummary, null, 2));
    invalidateRunsIndex();
    logPipeline('Abort', `Run ${runId} marked as ABORTED (${abortedSummary.rows} partial turns saved).`, 'warn');
    broadcast('pipeline_state', activePipeline);
    return;
  }

  // STAGE 3: Unified Node Post-Processing (cleanup -> evaluate -> aggregate -> gates -> report.html)
  activePipeline.stage = 'stage3_postprocess';
  broadcast('pipeline_state', activePipeline);
  logPipeline('Stage 3: Node Post-Process', `Merged ${activePipeline.rows.length} rows from [${selectedWorkers.map((w) => w.id).join(', ')}] into results/${runId}/rows.jsonl`, 'info');
  logPipeline('Stage 3: Node Post-Process', `Running cleanup -> evaluate (lexical) -> aggregate (sample stdev n-1, QDUL & time buckets) -> gate -> report.html...`, 'info');

  try {
    runMeta.status = 'COMPLETED';
    runMeta.completed_at = new Date().toISOString();
    runMeta.host_telemetry = sampleHostResources();
    fs.writeFileSync(path.join(outDir, 'run-meta.json'), JSON.stringify(runMeta, null, 2));

    const baseDir = baselineRunId ? path.join(activeFrameworkRoot, 'results', baselineRunId) : null;
    const summary = postProcessRunDir(outDir, cfg, gatesCfg, baseDir, activeFrameworkRoot);
    invalidateRunsIndex();
    activePipeline.summary = summary;
    activePipeline.stage = 'completed';
    logPipeline(
      'Stage 3: Node Post-Process',
      `Post-processing complete! Verdict: ${summary.gate.passed ? 'GATE PASSED (Exit 0)' : 'GATE FAILED (Exit 1)'} — E2E p95: ${summary.overall.e2e_p95_ms}ms (stdev: ${summary.overall.e2e_stdev_ms}ms), Completion: ${(summary.overall.completion_rate * 100).toFixed(1)}%`,
      summary.gate.passed ? 'success' : 'warn'
    );
    broadcast('pipeline_state', activePipeline);
    broadcast('run_completed', summary);

    // Optional CI Webhook Notification
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'run_completed',
          run_id: summary.run_id,
          passed: summary.gate.passed,
          overall: summary.overall,
          created_at: summary.created_at
        })
      }).catch(() => {});
    }
  } catch (err) {
    activePipeline.stage = 'failed';
    logPipeline('Stage 3: Node Post-Process', `Post-processing failed: ${err.message}`, 'error');
    broadcast('pipeline_state', activePipeline);
  }
}

export async function startAllServices({ port = PORT, bindHost = BIND_HOST } = {}) {
  ensureSeedRuns(activeFrameworkRoot);
  await startMockAgent(8089);
  await startWorkerAgent({
    workerId: 'EC2-Worker-01',
    port: 4101,
    region: 'ap-south-1a',
    instanceType: `${os.cpus().length} vCPU / ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
    privateIp: '127.0.0.1',
    isLocalHost: true,
    bindHost
  });
  await startWorkerAgent({
    workerId: 'EC2-Worker-02',
    port: 4102,
    region: 'ap-south-1b',
    instanceType: `${os.cpus().length} vCPU / ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
    privateIp: '127.0.0.1',
    isLocalHost: false,
    bindHost
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AIPerf-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = urlObj.pathname;

    // Optional API token guard when AIPERF_TOKEN is configured
    const requiredToken = process.env.AIPERF_TOKEN;
    if (requiredToken && pathname.startsWith('/api/') && pathname !== '/api/stream') {
      const provided =
        req.headers['x-aiperf-token'] ||
        urlObj.searchParams.get('token') ||
        String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (provided !== requiredToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: valid AIPERF_TOKEN required' }));
        return;
      }
    }

    // Live SSE Stream for Web UI
    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      if (activePipeline) {
        res.write(`event: pipeline_state\ndata: ${JSON.stringify(activePipeline)}\n\n`);
      }
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return;
    }

    // Overview API
    if (req.method === 'GET' && pathname === '/api/overview') {
      const workersHealth = await Promise.all(workerNodes.map((w, i) => fetchWorkerHealth(w, i)));
      let mockHealth = { status: 'offline' };
      try {
        const mRes = await fetch('http://127.0.0.1:8089/health', { signal: AbortSignal.timeout(2000) });
        mockHealth = await mRes.json();
      } catch (_) {}

      const configs = listDirJsonFiles('config');
      const datasets = [...listDirJsonFiles('data'), ...listDirJsonFiles('data/vars')];
      const suites = listDirJsonFiles('suites');
      const k6Files = [...listDirJsonFiles('k6'), ...listDirJsonFiles('k6/flows')];
      const projects = listFrameworkProjects(activeFrameworkRoot);
      const runs = listAllRuns();
      const k6Binary = detectK6Binary();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          frameworkRoot: activeFrameworkRoot,
          hostname: os.hostname(),
          k6Binary,
          mockAgent: mockHealth,
          workers: workersHealth,
          files: { configs, datasets, suites, k6Files },
          projects,
          runs,
          activePipeline
        })
      );
      return;
    }

    // Upload Full Multi-File Framework Project Folder
    if (req.method === 'POST' && pathname === '/api/projects/upload') {
      try {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 30 * 1024 * 1024) {
            throw new Error('Upload payload exceeds 30 MB limit');
          }
        }
        const { projectName, files } = JSON.parse(raw || '{}');
        const saved = saveUploadedProject(projectName, files, activeFrameworkRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, project: saved, projects: listFrameworkProjects(activeFrameworkRoot) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Preview Generated Composite Multi-Population k6 Script
    if (req.method === 'POST' && pathname === '/api/projects/preview-runner') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { projectId, populations } = JSON.parse(raw || '{}');
      const projects = listFrameworkProjects(activeFrameworkRoot);
      const proj = projects.find((p) => p.id === projectId) || projects[0];
      const script = generateCompositeK6Script(proj, populations);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, script }));
      return;
    }

    // Delete a Run
    if (req.method === 'DELETE' && pathname.startsWith('/api/runs/')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = parts[2];
      const resultsRoot = path.join(activeFrameworkRoot, 'results');
      const runDir = path.join(resultsRoot, runId);
      if (!runId || !isSafeSubpath(resultsRoot, runDir) || !fs.existsSync(runDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Run not found' }));
        return;
      }
      fs.rmSync(runDir, { recursive: true, force: true });
      invalidateRunsIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: runId, runs: listAllRuns(true) }));
      return;
    }

    // Get specific run details & exports
    if (req.method === 'GET' && pathname.startsWith('/api/runs/')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = parts[2];
      const resultsRoot = path.join(activeFrameworkRoot, 'results');
      const runDir = path.join(resultsRoot, runId);

      if (!runId || !isSafeSubpath(resultsRoot, runDir) || !fs.existsSync(runDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found' }));
        return;
      }

      if (parts[3] === 'html') {
        const htmlPath = path.join(runDir, 'report.html');
        const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '<h1>No report.html found</h1>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (parts[3] === 'csv') {
        const csvPath = path.join(runDir, 'results.csv');
        const csv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : 'row_id,run_id\n';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${runId}-results.csv"`
        });
        res.end(csv);
        return;
      }

      const loadSummaryAndRows = () => {
        const summary = fs.existsSync(path.join(runDir, 'summary.json'))
          ? JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'))
          : { run_id: runId };
        const rows = fs.existsSync(path.join(runDir, 'rows.jsonl'))
          ? fs
              .readFileSync(path.join(runDir, 'rows.jsonl'), 'utf8')
              .split('\n')
              .filter((l) => l.trim().startsWith('{'))
              .map((l) => {
                try { return JSON.parse(l); } catch { return null; }
              })
              .filter(Boolean)
          : [];
        return { summary, rows };
      };

      if (parts[3] === 'junit.xml') {
        const { summary } = loadSummaryAndRows();
        const xml = exportJUnitXml(summary);
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${runId}-junit.xml"`
        });
        res.end(xml);
        return;
      }

      if (parts[3] === 'export-prometheus') {
        const { summary } = loadSummaryAndRows();
        const prom = exportPrometheusFormat(summary);
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Disposition': `attachment; filename="${runId}-metrics.prom"`
        });
        res.end(prom);
        return;
      }

      if (parts[3] === 'export-influx') {
        const { summary, rows } = loadSummaryAndRows();
        const influx = exportInfluxLineProtocol(summary, rows);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${runId}-influx.lp"`
        });
        res.end(influx);
        return;
      }

      if (parts[3] === 'export-zip' || parts[3] === 'export-files') {
        const { summary, rows } = loadSummaryAndRows();
        const csvFilesMap = buildK6ExportCsvFiles(summary, rows);

        if (parts[3] === 'export-files') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ run_id: runId, file_count: Object.keys(csvFilesMap).length, files: csvFilesMap }));
          return;
        }

        const zipBuf = createZipBuffer(csvFilesMap);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${runId}-k6-export.zip"`,
          'Content-Length': zipBuf.length
        });
        res.end(zipBuf);
        return;
      }

      const { summary, rows } = loadSummaryAndRows();
      const meta = fs.existsSync(path.join(runDir, 'run-meta.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'run-meta.json'), 'utf8'))
        : {};
      const evals = fs.existsSync(path.join(runDir, 'evals.jsonl'))
        ? fs
            .readFileSync(path.join(runDir, 'evals.jsonl'), 'utf8')
            .split('\n')
            .filter((l) => l.trim().startsWith('{'))
            .map((l) => {
              try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean)
        : [];
      const consoleLog = fs.existsSync(path.join(runDir, 'console.log'))
        ? fs.readFileSync(path.join(runDir, 'console.log'), 'utf8')
        : '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary, meta, rows, evals, consoleLog }));
      return;
    }

    // Save Note / Star on a Run
    if (req.method === 'POST' && pathname.startsWith('/api/runs/') && pathname.endsWith('/note')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = parts[2];
      const resultsRoot = path.join(activeFrameworkRoot, 'results');
      const sumPath = path.join(resultsRoot, runId, 'summary.json');
      if (!isSafeSubpath(resultsRoot, sumPath)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (fs.existsSync(sumPath)) {
        const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        if (body.note !== undefined) sum.note = body.note;
        if (body.starred !== undefined) sum.starred = Boolean(body.starred);
        fs.writeFileSync(sumPath, JSON.stringify(sum, null, 2));
        invalidateRunsIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summary: sum }));
        return;
      }
    }

    // Inspect Direct k6 Multi-Scenario Script
    if (req.method === 'GET' && pathname === '/api/k6/inspect') {
      const scriptRel = urlObj.searchParams.get('script') || 'k6/flows/ecommerce-userflows.js';
      try {
        const info = inspectK6Script(scriptRel, activeFrameworkRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Run Doctor Preflight
    if (req.method === 'POST' && pathname === '/api/doctor') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { configRel = 'config/default.json' } = JSON.parse(raw || '{}');
      const { cfg } = loadConfig(configRel, activeFrameworkRoot);
      const doc = await runDoctor(cfg, activeFrameworkRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(doc));
      return;
    }

    // Start Distributed Run
    if (req.method === 'POST' && pathname === '/api/runs/start') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = JSON.parse(raw || '{}');

      if (activePipeline && (activePipeline.stage === 'stage1_preflight' || activePipeline.stage === 'stage2_k6_distributed')) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'A test run is already in progress' }));
        return;
      }

      orchestrateDistributedRun(params).catch((err) => {
        logPipeline('Error', `Orchestration error: ${err.message}`, 'error');
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true }));
      return;
    }

    // Stop active run across ONLY the participating workers
    if (req.method === 'POST' && pathname === '/api/runs/stop') {
      const targetWorkers = activePipeline?.selectedWorkers?.length
        ? activePipeline.selectedWorkers
        : workerNodes;

      if (activePipeline) {
        activePipeline.aborted = true;
        activePipeline.stage = 'stopped';
      }
      if (activeRunAbortController) {
        try { activeRunAbortController.abort(); } catch (_) {}
      }

      const authHeaders = process.env.AIPERF_TOKEN ? { 'X-AIPerf-Token': process.env.AIPERF_TOKEN } : {};
      await Promise.all(
        targetWorkers.map((w) =>
          fetch(`${w.url}/job/stop`, { method: 'POST', headers: authHeaders }).catch(() => {})
        )
      );

      if (activePipeline) {
        broadcast('pipeline_state', activePipeline);
      }
      logPipeline(
        'Abort',
        `User stopped active run across participating load injectors: [${targetWorkers.map((w) => w.id).join(', ')}].`,
        'warn'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stoppedWorkers: targetWorkers.map((w) => w.id) }));
      return;
    }

    // Re-evaluate / Re-gate / Rebuild Report on an existing run
    if (req.method === 'POST' && pathname === '/api/runs/reprocess') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { runId, configRel = 'config/perfpilot.json', gatesRel = 'config/gates.perfpilot.json', baselineRunId = '' } = JSON.parse(raw || '{}');
      const resultsRoot = path.join(activeFrameworkRoot, 'results');
      const runDir = path.join(resultsRoot, runId);
      if (!isSafeSubpath(resultsRoot, runDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden path' }));
        return;
      }
      const { cfg } = loadConfig(configRel, activeFrameworkRoot);
      const gatesCfg = JSON.parse(fs.readFileSync(path.join(activeFrameworkRoot, gatesRel), 'utf8'));
      const baseDir = baselineRunId ? path.join(resultsRoot, baselineRunId) : null;
      const summary = postProcessRunDir(runDir, cfg, gatesCfg, baseDir, activeFrameworkRoot);
      invalidateRunsIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, summary }));
      return;
    }

    // Compare two runs
    if (req.method === 'POST' && pathname === '/api/compare') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { referenceRunId, candidateRunId } = JSON.parse(raw || '{}');
      const resultsRoot = path.join(activeFrameworkRoot, 'results');
      const refDir = path.join(resultsRoot, referenceRunId);
      const candDir = path.join(resultsRoot, candidateRunId);
      if (!isSafeSubpath(resultsRoot, refDir) || !isSafeSubpath(resultsRoot, candDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden run path' }));
        return;
      }
      const result = compareRuns(refDir, candDir, resultsRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Read / Write Framework Config, Dataset, or k6 Script files (with strict path.relative check)
    if (req.method === 'GET' && pathname === '/api/file') {
      const rel = urlObj.searchParams.get('path') || 'config/default.json';
      const safePath = path.resolve(activeFrameworkRoot, rel);
      if (!isSafeSubpath(activeFrameworkRoot, safePath) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found or outside workspace' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: rel, content: fs.readFileSync(safePath, 'utf8') }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/file') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { path: rel, content } = JSON.parse(raw || '{}');
      const safePath = path.resolve(activeFrameworkRoot, String(rel || ''));
      if (!rel || !isSafeSubpath(activeFrameworkRoot, safePath)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden path outside framework root' }));
        return;
      }
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, String(content ?? ''), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: rel }));
      return;
    }

    // Dynamic Load Injector Registration (supports N workers)
    if (req.method === 'POST' && pathname === '/api/cluster/register') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const id = String(body.id || `EC2-Worker-0${workerNodes.length + 1}`).trim();
      const url = String(body.url || `http://127.0.0.1:${4100 + workerNodes.length + 1}`).trim();
      const region = String(body.region || 'ap-south-1c').trim();
      const privateIp = String(body.privateIp || '10.24.3.103').trim();
      const instanceType = String(body.instanceType || 'c6i.2xlarge').trim();
      const spawnLocalSimulator = Boolean(body.spawnLocal);

      if (spawnLocalSimulator) {
        try {
          const u = new URL(url);
          await startWorkerAgent({
            workerId: id,
            port: Number(u.port || 4103),
            region,
            instanceType,
            privateIp,
            isLocalHost: false,
            bindHost
          });
        } catch (_) {}
      }

      const existingIdx = workerNodes.findIndex((w) => w.id === id);
      const nodeEntry = {
        id,
        name: body.name || `${id} (${region})`,
        url,
        region,
        instanceType,
        privateIp,
        isLocalHost: false,
        mode: spawnLocalSimulator ? 'local-sim' : 'remote'
      };
      if (existingIdx >= 0) workerNodes[existingIdx] = nodeEntry;
      else workerNodes.push(nodeEntry);

      const workersHealth = await Promise.all(workerNodes.map((w, i) => fetchWorkerHealth(w, i)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worker: nodeEntry, workers: workersHealth }));
      return;
    }

    // Update Worker Cluster or Framework Root settings
    if (req.method === 'POST' && pathname === '/api/cluster/config') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (Array.isArray(body.workers) && body.workers.length > 0) {
        workerNodes = body.workers;
      }
      if (body.frameworkRoot && fs.existsSync(body.frameworkRoot)) {
        activeFrameworkRoot = body.frameworkRoot;
        invalidateRunsIndex();
      }
      const workersHealth = await Promise.all(workerNodes.map((w, i) => fetchWorkerHealth(w, i)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workers: workersHealth, frameworkRoot: activeFrameworkRoot }));
      return;
    }

    // Serve Frontend UI safely
    const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (isSafeSubpath(PUBLIC_DIR, filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime =
        ext === '.html' ? 'text/html; charset=utf-8' :
        ext === '.js' ? 'application/javascript; charset=utf-8' :
        ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(filePath));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[server] Port ${port} is already in use.`);
        resolve({ server: null, port, alreadyRunning: true });
      } else {
        throw err;
      }
    });
    server.listen(port, bindHost, () => {
      const k6Bin = detectK6Binary();
      console.log(`\n======================================================================`);
      console.log(`  AIPerf Cloud k6 Orchestrator & Web UI listening on:`);
      console.log(`  👉 http://${bindHost}:${port}`);
      console.log(`  • Engine Mode: ${k6Bin.available ? `Native k6 CLI (${k6Bin.version})` : 'Measured Node HTTP Simulation (install k6 for native CLI)'}`);
      console.log(`  • Mock AI Agent (PerfPilot + OpenAI SSE): http://127.0.0.1:8089`);
      console.log(`  • Load Injector 01 (Web Portal Host):     http://127.0.0.1:4101`);
      console.log(`  • Load Injector 02 (Secondary Node):      http://127.0.0.1:4102`);
      console.log(`======================================================================\n`);
      resolve({ server, port, alreadyRunning: false });
    });
  });
}

const argv1Norm = (process.argv[1] || '').replace(/\\/g, '/');
if (argv1Norm && import.meta.url === `file:///${argv1Norm}`) {
  startAllServices();
}
