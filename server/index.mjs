import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.UI_PORT || 4000);

let activeFrameworkRoot = process.env.AIPERF_FRAMEWORK_DIR || FRAMEWORK_ROOT;

let workerNodes = [
  {
    id: 'EC2-Worker-01',
    name: 'EC2-Worker-01 (Primary Load Node)',
    url: 'http://127.0.0.1:4101',
    region: 'ap-south-1a',
    instanceType: 'c6i.2xlarge (8 vCPU, 16GB)',
    privateIp: '10.24.1.101',
    mode: 'local-sim'
  },
  {
    id: 'EC2-Worker-02',
    name: 'EC2-Worker-02 (Secondary Load Node)',
    url: 'http://127.0.0.1:4102',
    region: 'ap-south-1b',
    instanceType: 'c6i.2xlarge (8 vCPU, 16GB)',
    privateIp: '10.24.2.102',
    mode: 'local-sim'
  }
];

let liveClients = new Set();
let activePipeline = null;

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

function listAllRuns() {
  const resultsDir = path.join(activeFrameworkRoot, 'results');
  if (!fs.existsSync(resultsDir)) return [];
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
  return runs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

async function fetchWorkerHealth(worker) {
  try {
    const res = await fetch(`${worker.url}/health`);
    const data = await res.json();
    return { ...worker, online: true, health: data };
  } catch (err) {
    return { ...worker, online: false, error: err.message, health: { status: 'offline', activeVus: 0, cpuPct: 0, memPct: 0 } };
  }
}

async function orchestrateDistributedRun(params) {
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
    distributionMode = 'split-50-50'
  } = params;

  const outDir = path.join(activeFrameworkRoot, 'results', runId);
  fs.mkdirSync(outDir, { recursive: true });
  const rowsPath = path.join(outDir, 'rows.jsonl');
  fs.writeFileSync(rowsPath, '');

  const { cfg } = loadConfig(configRel, activeFrameworkRoot);
  const gatesCfg = JSON.parse(fs.readFileSync(path.join(activeFrameworkRoot, gatesRel), 'utf8'));

  const selectedWorkers =
    distributionMode === 'worker-1-only'
      ? [workerNodes[0]]
      : distributionMode === 'worker-2-only'
        ? [workerNodes[1]]
        : [workerNodes[0], workerNodes[1]];

  activePipeline = {
    runId,
    workload,
    configRel,
    gatesRel,
    distributionMode,
    workersUsed: selectedWorkers.map((w) => w.id),
    startedAt: new Date().toISOString(),
    stage: 'stage1_preflight', // stage1_preflight -> stage2_k6_distributed -> stage3_postprocess -> completed / failed
    rows: [],
    logs: [],
    workerStats: {},
    doctorResult: null,
    summary: null
  };

  broadcast('pipeline_state', activePipeline);
  logPipeline('Stage 1: Node Pre-Flight', `Starting pipeline for Run ID: ${runId} (${workload})`, 'info');

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

  // Write run-meta.json
  const runMeta = {
    run_id: runId,
    workload,
    config_file: configRel,
    gates_file: gatesRel,
    started_at: activePipeline.startedAt,
    workers_used: selectedWorkers.map((w) => w.id),
    execution_mode: distributionMode,
    k6: 'v2.3.0 (distributed segment mode)',
    target: {
      name: cfg.target.name,
      baseUrl: cfg.target.baseUrl,
      path: cfg.target.path,
      model: cfg.target.model,
      stream: cfg.target.stream
    }
  };
  fs.writeFileSync(path.join(outDir, 'run-meta.json'), JSON.stringify(runMeta, null, 2));

  // STAGE 2: Distributed k6 execution across Worker Agents
  activePipeline.stage = 'stage2_k6_distributed';
  broadcast('pipeline_state', activePipeline);

  if (mode === 'multi-population') {
    logPipeline(
      'Stage 1: Bundle & Sync',
      `Packaging full framework project "${projectId}" (flows/, lib/, data/, config/) and syncing bundle to ${selectedWorkers.map((w) => `${w.id} (${w.privateIp})`).join(' & ')}...`,
      'success'
    );
  }

  const workerPromises = selectedWorkers.map((worker, idx) => {
    const isTwoWorkers = selectedWorkers.length === 2;
    const segment = !isTwoWorkers ? '0:1' : idx === 0 ? '0:0.5' : '0.5:1';
    const segmentRatio = !isTwoWorkers || distributionMode === 'multi-protocol-http-sse' ? 1.0 : 0.5;
    const workerConfig = distributionMode === 'multi-protocol-http-sse' && idx === 1 ? secondaryConfigRel : configRel;

    if (mode === 'multi-population') {
      const assignedSummary = (populations || [])
        .map((p) => `${p.populationId}:${idx === 0 ? p.injector1Pct : p.injector2Pct}%`)
        .join(', ');
      logPipeline(
        'Stage 2: Multi-Injector Populations',
        `Triggering injector ${worker.id} (${worker.privateIp}) with Population matrix [${assignedSummary}]`,
        'info'
      );
    } else {
      logPipeline(
        'Stage 2: Distributed k6',
        `Dispatching k6 workload "${workload}" to ${worker.id} (${worker.privateIp}) [segment=${segment}, config=${workerConfig}]`,
        'info'
      );
    }

    return new Promise(async (resolve) => {
      // Subscribe to worker's SSE stream for this run
      const abortCtrl = new AbortController();
      try {
        const streamRes = await fetch(`${worker.url}/stream`, { signal: abortCtrl.signal });
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

                if (evType === 'row' && payload.run_id === runId) {
                  fs.appendFileSync(rowsPath, JSON.stringify(payload) + '\n');
                  activePipeline.rows.push(payload);
                  broadcast('live_row', payload);
                  logPipeline(
                    'Stage 2: Distributed k6',
                    `[${payload.worker_id}] Turn ${payload.prompt_id} (${payload.category}) -> HTTP ${payload.http_status} in ${payload.e2e_ms}ms (TTFT: ${payload.ttft_ms ?? 'n/a'}ms, det_pass: ${payload.det_pass})`,
                    payload.det_pass ? 'info' : 'warn'
                  );
                } else if (evType === 'status') {
                  activePipeline.workerStats[worker.id] = payload;
                  broadcast('worker_status', payload);
                } else if (evType === 'completed' && payload.runId === runId) {
                  logPipeline('Stage 2: Distributed k6', `[${worker.id}] Finished segment ${segment} (${payload.rowsCompleted} turns completed).`, 'success');
                  abortCtrl.abort();
                  resolve();
                } else if (evType === 'error' && payload.runId === runId) {
                  logPipeline('Stage 2: Distributed k6', `[${worker.id}] Error: ${payload.error}`, 'error');
                  abortCtrl.abort();
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            workerIndex: idx,
            projectId,
            populations,
            scriptRelPath,
            selectedScenarios,
            envVars,
            vusOverride,
            durationOverride,
            runId,
            segment,
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
        logPipeline('Stage 2: Distributed k6', `Failed communicating with ${worker.id}: ${err.message}`, 'error');
        resolve();
      }
    });
  });

  await Promise.all(workerPromises);

  // STAGE 3: Unified Node Post-Processing (cleanup -> evaluate -> aggregate -> gates -> report.html)
  activePipeline.stage = 'stage3_postprocess';
  broadcast('pipeline_state', activePipeline);
  logPipeline('Stage 3: Node Post-Process', `Merged ${activePipeline.rows.length} rows from [${selectedWorkers.map((w) => w.id).join(', ')}] into results/${runId}/rows.jsonl`, 'info');
  logPipeline('Stage 3: Node Post-Process', `Running cleanup.mjs -> evaluate.mjs (lexical) -> aggregate.mjs (QDUL & CI) -> gate.mjs -> report.mjs...`, 'info');

  try {
    const baseDir = baselineRunId ? path.join(activeFrameworkRoot, 'results', baselineRunId) : null;
    const summary = postProcessRunDir(outDir, cfg, gatesCfg, baseDir, activeFrameworkRoot);
    activePipeline.summary = summary;
    activePipeline.stage = 'completed';
    logPipeline(
      'Stage 3: Node Post-Process',
      `Post-processing complete! Verdict: ${summary.gate.passed ? 'GATE PASSED (Exit 0)' : 'GATE FAILED (Exit 1)'} — E2E p95: ${summary.overall.e2e_p95_ms}ms, Completion: ${(summary.overall.completion_rate * 100).toFixed(1)}%`,
      summary.gate.passed ? 'success' : 'warn'
    );
    broadcast('pipeline_state', activePipeline);
    broadcast('run_completed', summary);
  } catch (err) {
    activePipeline.stage = 'failed';
    logPipeline('Stage 3: Node Post-Process', `Post-processing failed: ${err.message}`, 'error');
    broadcast('pipeline_state', activePipeline);
  }
}

async function startAllServices() {
  ensureSeedRuns(activeFrameworkRoot);
  await startMockAgent(8089);
  await startWorkerAgent({
    workerId: 'EC2-Worker-01',
    port: 4101,
    region: 'ap-south-1a',
    instanceType: 'c6i.2xlarge',
    privateIp: '10.24.1.101'
  });
  await startWorkerAgent({
    workerId: 'EC2-Worker-02',
    port: 4102,
    region: 'ap-south-1b',
    instanceType: 'c6i.2xlarge',
    privateIp: '10.24.2.102'
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = urlObj.pathname;

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
      const workersHealth = await Promise.all(workerNodes.map(fetchWorkerHealth));
      let mockHealth = { status: 'offline' };
      try {
        const mRes = await fetch('http://127.0.0.1:8089/health');
        mockHealth = await mRes.json();
      } catch (_) {}

      const configs = listDirJsonFiles('config');
      const datasets = [...listDirJsonFiles('data'), ...listDirJsonFiles('data/vars')];
      const suites = listDirJsonFiles('suites');
      const k6Files = [...listDirJsonFiles('k6'), ...listDirJsonFiles('k6/flows')];
      const projects = listFrameworkProjects(activeFrameworkRoot);
      const runs = listAllRuns();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          frameworkRoot: activeFrameworkRoot,
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
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { projectName, files } = JSON.parse(raw || '{}');
      const saved = saveUploadedProject(projectName, files, activeFrameworkRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, project: saved, projects: listFrameworkProjects(activeFrameworkRoot) }));
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

    // Get specific run details
    if (req.method === 'GET' && pathname.startsWith('/api/runs/')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = parts[2];
      const runDir = path.join(activeFrameworkRoot, 'results', runId);

      if (!fs.existsSync(runDir)) {
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

      const summary = fs.existsSync(path.join(runDir, 'summary.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'))
        : null;
      const meta = fs.existsSync(path.join(runDir, 'run-meta.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'run-meta.json'), 'utf8'))
        : {};
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary, meta, rows, evals }));
      return;
    }

    // Save Note / Star on a Run
    if (req.method === 'POST' && pathname.startsWith('/api/runs/') && pathname.endsWith('/note')) {
      const parts = pathname.split('/').filter(Boolean);
      const runId = parts[2];
      const sumPath = path.join(activeFrameworkRoot, 'results', runId, 'summary.json');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (fs.existsSync(sumPath)) {
        const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        if (body.note !== undefined) sum.note = body.note;
        if (body.starred !== undefined) sum.starred = Boolean(body.starred);
        fs.writeFileSync(sumPath, JSON.stringify(sum, null, 2));
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

      orchestrateDistributedRun(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true }));
      return;
    }

    // Stop active run across workers
    if (req.method === 'POST' && pathname === '/api/runs/stop') {
      await Promise.all(
        workerNodes.map((w) =>
          fetch(`${w.url}/job/stop`, { method: 'POST' }).catch(() => {})
        )
      );
      logPipeline('Abort', 'User requested stop across all EC2 worker nodes.', 'warn');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Re-evaluate / Re-gate / Rebuild Report on an existing run (Stage 19-23 offline)
    if (req.method === 'POST' && pathname === '/api/runs/reprocess') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { runId, configRel = 'config/perfpilot.json', gatesRel = 'config/gates.perfpilot.json', baselineRunId = '' } = JSON.parse(raw || '{}');
      const runDir = path.join(activeFrameworkRoot, 'results', runId);
      const { cfg } = loadConfig(configRel, activeFrameworkRoot);
      const gatesCfg = JSON.parse(fs.readFileSync(path.join(activeFrameworkRoot, gatesRel), 'utf8'));
      const baseDir = baselineRunId ? path.join(activeFrameworkRoot, 'results', baselineRunId) : null;
      const summary = postProcessRunDir(runDir, cfg, gatesCfg, baseDir, activeFrameworkRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, summary }));
      return;
    }

    // Compare two runs
    if (req.method === 'POST' && pathname === '/api/compare') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { referenceRunId, candidateRunId } = JSON.parse(raw || '{}');
      const refDir = path.join(activeFrameworkRoot, 'results', referenceRunId);
      const candDir = path.join(activeFrameworkRoot, 'results', candidateRunId);
      const result = compareRuns(refDir, candDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Read / Write Framework Config, Dataset, or k6 Script files
    if (req.method === 'GET' && pathname === '/api/file') {
      const rel = urlObj.searchParams.get('path') || 'config/default.json';
      const safePath = path.resolve(activeFrameworkRoot, rel);
      if (!safePath.startsWith(path.resolve(activeFrameworkRoot)) || !fs.existsSync(safePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
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
      const safePath = path.resolve(activeFrameworkRoot, rel);
      if (!safePath.startsWith(path.resolve(activeFrameworkRoot))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden path' }));
        return;
      }
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: rel }));
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
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workers: workerNodes, frameworkRoot: activeFrameworkRoot }));
      return;
    }

    // Serve Frontend UI
    const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
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

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n======================================================================`);
    console.log(`  AIPerf Cloud k6 Orchestrator & Web UI listening on:`);
    console.log(`  👉 http://127.0.0.1:${PORT}`);
    console.log(`  • Mock AI Agent (PerfPilot + OpenAI SSE): http://127.0.0.1:8089`);
    console.log(`  • EC2-Worker-01 Agent Simulator:          http://127.0.0.1:4101`);
    console.log(`  • EC2-Worker-02 Agent Simulator:          http://127.0.0.1:4102`);
    console.log(`======================================================================\n`);
  });
}

startAllServices();
