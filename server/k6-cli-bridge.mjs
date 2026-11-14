// server/k6-cli-bridge.mjs
// Real k6 CLI Binary Detection, Child-Process Execution (--execution-segment + --out json),
// Streaming NDJSON Point/Metric Parser, and Prometheus / InfluxDB Exporters.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sampleHostResources } from './stats-engine.mjs';

let cachedK6Info = null;

/**
 * Detects whether a real `k6` binary is available on the system PATH or standard install locations.
 */
export function detectK6Binary(forceRefresh = false) {
  if (cachedK6Info && !forceRefresh) return cachedK6Info;

  const candidates = [
    process.env.K6_BIN,
    'k6',
    'k6.exe',
    'C:\\Program Files\\k6\\k6.exe',
    'C:\\ProgramData\\chocolatey\\bin\\k6.exe',
    path.join(os.homedir(), 'scoop', 'shims', 'k6.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'k6', 'k6.exe'),
    '/usr/bin/k6',
    '/usr/local/bin/k6',
    '/opt/homebrew/bin/k6'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 2500, windowsHide: true });
      if (res.status === 0 && res.stdout) {
        const versionLine = res.stdout.trim().split('\n')[0];
        const verMatch = versionLine.match(/v\d+\.\d+\.\d+/);
        cachedK6Info = {
          available: true,
          binaryPath: bin,
          version: verMatch ? verMatch[0] : versionLine,
          rawOutput: versionLine,
          engineLabel: `k6 ${verMatch ? verMatch[0] : 'CLI'}`
        };
        return cachedK6Info;
      }
    } catch (_) {
      // try next candidate
    }
  }

  cachedK6Info = {
    available: false,
    binaryPath: null,
    version: null,
    rawOutput: 'k6 binary not found on PATH (using Node HTTP Simulation Engine)',
    engineLabel: `Node.js ${process.version} HTTP Sim`
  };
  return cachedK6Info;
}

/**
 * Spawns a real `k6 run` process when k6 is installed and streams parsed telemetry rows & custom metrics.
 */
export function runRealK6Process({
  k6BinaryPath,
  scriptFullPath,
  runId,
  workerId,
  segment = '0:1',
  envVars = {},
  outJsonPath = null,
  onRow = () => {},
  onStatus = () => {},
  onMetricDef = () => {},
  shouldAbort = () => false
}) {
  return new Promise((resolve, reject) => {
    const tmpJsonPath = outJsonPath || path.join(os.tmpdir(), `${runId}_${workerId}_k6_raw.json`);
    const args = ['run', '--execution-segment', segment, '--out', `json=${tmpJsonPath}`];

    const mergedEnv = {
      ...envVars,
      RUN_ID: runId,
      WORKER_ID: workerId
    };
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (v !== undefined && v !== null && v !== '') {
        args.push('-e', `${k}=${v}`);
      }
    }
    args.push(scriptFullPath);

    let rowIdx = 0;
    let activeVus = 1;
    let readOffset = 0;
    let remainder = '';
    const customMetrics = new Map();

    // Ensure empty output file before spawning
    try { fs.writeFileSync(tmpJsonPath, ''); } catch (_) {}

    const child = spawn(k6BinaryPath, args, {
      cwd: path.dirname(scriptFullPath),
      env: { ...process.env, ...mergedEnv },
      windowsHide: true
    });

    const parseJsonLines = (chunkText) => {
      const full = remainder + chunkText;
      const lines = full.split('\n');
      remainder = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'Metric' && obj.metric) {
            customMetrics.set(obj.metric, {
              name: obj.metric,
              type: obj.data?.type || 'trend',
              contains: obj.data?.contains || 'default'
            });
            onMetricDef(customMetrics.get(obj.metric));
          } else if (obj.type === 'Point' && obj.metric === 'vus') {
            activeVus = Math.max(0, Number(obj.data?.value || 0));
            const hostRes = sampleHostResources();
            onStatus({
              workerId,
              activeVus,
              loadLevel: activeVus,
              cpuPct: hostRes.cpuPct,
              memPct: hostRes.memPct,
              fileHandles: hostRes.fileHandles,
              state: 'running'
            });
          } else if (obj.type === 'Point' && obj.metric === 'http_req_duration') {
            rowIdx++;
            const tags = obj.data?.tags || {};
            const e2eMs = Math.round(Number(obj.data?.value || 0));
            const status = Number(tags.status || 200);
            const scen = tags.scenario || 'default';
            const grp = String(tags.group || '').replace(/^::/, '') || scen;
            const hostRes = sampleHostResources();

            const row = {
              aiperf: 1,
              mode: 'real-k6',
              engine: 'k6-cli',
              row_id: `${runId}_${workerId}_${rowIdx}`,
              run_id: runId,
              worker_id: workerId,
              execution_segment: segment,
              ts: obj.data?.time || new Date().toISOString(),
              workload: `k6:${path.basename(scriptFullPath)}`,
              population_id: scen,
              scenario_id: scen,
              load_level: Math.max(1, activeVus),
              prompt_id: tags.name || tags.url || `REQ_${rowIdx}`,
              category: grp,
              protocol: tags.method || 'HTTP',
              turn: 1,
              session_id: `K6_${workerId}_${rowIdx}`,
              trace_id: `k6_${rowIdx}`,
              completion_status: status >= 400 ? 'http_error' : 'completed',
              http_status: status,
              ttft_ms: null,
              e2e_ms: e2eMs,
              steps: 1,
              tool_calls: [],
              det_pass: status >= 200 && status < 400,
              det_failed: status >= 400 ? [`HTTP ${status}`] : [],
              correctness: status < 400 ? 1 : 0,
              groundedness: status < 400 ? 1 : 0,
              answer: `[k6 Point] ${tags.method || 'GET'} ${tags.url || tags.name || ''} -> HTTP ${status} (${e2eMs}ms)`,
              host_resources: hostRes
            };
            onRow(row);
          }
        } catch (_) {}
      }
    };

    const tailTimer = setInterval(() => {
      if (shouldAbort()) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
      try {
        if (fs.existsSync(tmpJsonPath)) {
          const stat = fs.statSync(tmpJsonPath);
          if (stat.size > readOffset) {
            const fd = fs.openSync(tmpJsonPath, 'r');
            const buf = Buffer.alloc(stat.size - readOffset);
            fs.readSync(fd, buf, 0, buf.length, readOffset);
            fs.closeSync(fd);
            readOffset = stat.size;
            parseJsonLines(buf.toString('utf8'));
          }
        }
      } catch (_) {}
    }, 200);

    child.on('error', (err) => {
      clearInterval(tailTimer);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(tailTimer);
      try {
        if (fs.existsSync(tmpJsonPath)) {
          const stat = fs.statSync(tmpJsonPath);
          if (stat.size > readOffset) {
            const fd = fs.openSync(tmpJsonPath, 'r');
            const buf = Buffer.alloc(stat.size - readOffset);
            fs.readSync(fd, buf, 0, buf.length, readOffset);
            fs.closeSync(fd);
            parseJsonLines(buf.toString('utf8'));
          }
        }
      } catch (_) {}
      resolve({ exitCode: code, rowsEmitted: rowIdx, customMetrics: Array.from(customMetrics.values()) });
    });
  });
}

/**
 * Exports a run's metrics in Prometheus Exposition Format (.prom)
 */
export function exportPrometheusFormat(summary, rows = []) {
  const runId = summary?.run_id || 'unknown';
  const lines = [
    `# HELP k6_http_reqs_total Total HTTP requests / AI turns executed`,
    `# TYPE k6_http_reqs_total counter`,
    `k6_http_reqs_total{run_id="${runId}",run_type="${summary?.run_type || 'k6'}"} ${rows.length}`,
    `# HELP k6_http_req_duration_p95_ms 95th percentile response duration in milliseconds`,
    `# TYPE k6_http_req_duration_p95_ms gauge`,
    `k6_http_req_duration_p95_ms{run_id="${runId}"} ${summary?.overall?.e2e_p95_ms ?? 0}`,
    `# HELP k6_http_req_duration_p50_ms 50th percentile response duration in milliseconds`,
    `# TYPE k6_http_req_duration_p50_ms gauge`,
    `k6_http_req_duration_p50_ms{run_id="${runId}"} ${summary?.overall?.e2e_p50_ms ?? 0}`,
    `# HELP k6_checks_pass_rate Fraction of deterministic/k6 check assertions passing`,
    `# TYPE k6_checks_pass_rate gauge`,
    `k6_checks_pass_rate{run_id="${runId}"} ${summary?.overall?.deterministic_pass_rate ?? 1}`
  ];
  if (summary?.overall?.ttft_p95_ms != null) {
    lines.push(
      `# HELP aiperf_ttft_p95_ms 95th percentile Time-to-First-Token in milliseconds`,
      `# TYPE aiperf_ttft_p95_ms gauge`,
      `aiperf_ttft_p95_ms{run_id="${runId}"} ${summary.overall.ttft_p95_ms}`
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Exports a run's rows in InfluxDB Line Protocol (.lp)
 */
export function exportInfluxLineProtocol(summary, rows = []) {
  const runId = summary?.run_id || 'unknown';
  return rows
    .map((r) => {
      const tsNs = new Date(r.ts || Date.now()).getTime() * 1000000;
      const scen = String(r.population_id || r.scenario_id || 'default').replace(/[\s,=]/g, '_');
      const worker = String(r.worker_id || 'worker1').replace(/[\s,=]/g, '_');
      const status = Number(r.http_status || 200);
      const e2e = Number(r.e2e_ms || 0);
      const ttftField = r.ttft_ms != null ? `,ttft_ms=${Number(r.ttft_ms)}` : '';
      const bytesInField = r.res_bytes != null ? `,data_received=${Number(r.res_bytes)}i` : '';
      const bytesOutField = r.req_bytes != null ? `,data_sent=${Number(r.req_bytes)}i` : '';
      return `http_req_duration,run_id=${runId},worker=${worker},scenario=${scen},status=${status} value=${e2e}${ttftField}${bytesInField}${bytesOutField} ${tsNs}`;
    })
    .join('\n') + '\n';
}

/**
 * Exports a run's gates and checks as JUnit XML for CI/CD systems (Jenkins, GitHub Actions, GitLab CI)
 */
export function exportJUnitXml(summary) {
  const gates = summary?.gate?.results || [];
  const failures = gates.filter((g) => g.status === 'FAIL').length;
  const escXml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const testCases = gates
    .map((g) => {
      const name = escXml(`${g.metric} ${g.op} ${g.value} (${g.label || g.source || 'gate'})`);
      if (g.status === 'FAIL') {
        return `    <testcase classname="aiperf.gates.${escXml(summary?.run_id)}" name="${name}">
      <failure message="Expected ${escXml(g.metric)} ${escXml(g.op)} ${escXml(g.value)}, actual was ${escXml(g.actual)}"/>
    </testcase>`;
      }
      return `    <testcase classname="aiperf.gates.${escXml(summary?.run_id)}" name="${name}"/>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="AIPerf-${escXml(summary?.run_id)}" tests="${gates.length}" failures="${failures}" timestamp="${escXml(summary?.created_at || new Date().toISOString())}">
${testCases}
</testsuite>
`;
}
