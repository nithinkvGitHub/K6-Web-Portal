import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FRAMEWORK_ROOT } from './aiperf.mjs';
import { sampleHostResources } from '../../server/stats-engine.mjs';
import { detectK6Binary, runRealK6Process } from '../../server/k6-cli-bridge.mjs';

export function inspectK6Script(scriptRelPath, baseRoot = FRAMEWORK_ROOT) {
  const fullPath = path.resolve(baseRoot, scriptRelPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Script not found: ${scriptRelPath}`);
  }
  const src = fs.readFileSync(fullPath, 'utf8');

  const scenarios = [];
  const thresholds = {};
  const groups = [];
  const checks = [];
  const customMetrics = [];

  // Find group('...') names
  const groupRx = /group\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = groupRx.exec(src)) !== null) {
    groups.push(m[1]);
  }

  // Find check keys: 'status is 200': (r) => ...
  const checkKeyRx = /['"`]([^'"`]+)['"`]\s*:\s*\([a-zA-Z0-9_]+\)\s*=>/g;
  while ((m = checkKeyRx.exec(src)) !== null) {
    checks.push(m[1]);
  }

  // Discover custom k6 metrics: new Trend('my_metric'), new Rate('...'), new Counter('...'), new Gauge('...')
  const customMetricRx = /new\s+(Trend|Rate|Counter|Gauge)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = customMetricRx.exec(src)) !== null) {
    customMetrics.push({
      type: m[1].toLowerCase(),
      name: m[2]
    });
  }

  // Extract export const options = { ... } using balanced braces (supports any indentation)
  const optStartMatch = src.match(/export\s+(?:const|let|var)\s+options\s*=\s*\{/);
  let optionsLiteral = null;
  if (optStartMatch) {
    const startBraceIdx = optStartMatch.index + optStartMatch[0].length - 1;
    let depth = 0;
    let inStr = null;
    for (let i = startBraceIdx; i < src.length; i++) {
      const ch = src[i];
      const prev = i > 0 ? src[i - 1] : '';
      if (inStr) {
        if (ch === inStr && prev !== '\\') inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          optionsLiteral = src.slice(startBraceIdx, i + 1);
          break;
        }
      }
    }
  }
  if (optionsLiteral) {
    try {
      const fn = new Function('__ENV', `return (${optionsLiteral});`);
      const evaluated = fn({});
      if (evaluated.scenarios) {
        for (const [scName, scCfg] of Object.entries(evaluated.scenarios)) {
          scenarios.push({
            name: scName,
            executor: scCfg.executor || 'shared-iterations',
            exec: scCfg.exec || 'default',
            vus: scCfg.vus || scCfg.startVUs || scCfg.preAllocatedVUs || 4,
            maxVUs: scCfg.maxVUs || (scCfg.stages ? Math.max(...scCfg.stages.map((s) => s.target || 1)) : scCfg.vus || 4),
            duration: scCfg.duration || scCfg.maxDuration || (scCfg.stages ? scCfg.stages.map((s) => s.duration).join(' -> ') : '10s'),
            rate: scCfg.rate || null,
            stages: scCfg.stages || null,
            tags: scCfg.tags || {}
          });
        }
      }
      if (evaluated.thresholds) {
        Object.assign(thresholds, evaluated.thresholds);
      }
    } catch (_) {}
  }

  if (scenarios.length === 0) {
    scenarios.push({
      name: 'default_scenario',
      executor: 'ramping-vus',
      exec: 'default',
      vus: 4,
      maxVUs: 8,
      duration: '10s',
      tags: { flow: path.basename(scriptRelPath, '.js') }
    });
  }

  const k6Bin = detectK6Binary();

  return {
    scriptPath: scriptRelPath,
    scenarios,
    thresholds,
    groups,
    checks,
    customMetrics,
    k6BinaryAvailable: k6Bin.available,
    k6BinaryVersion: k6Bin.version,
    cliCommandPreview: `k6 run --execution-segment "0:0.5" --execution-segment-sequence "0,0.5,1" --summary-export results/<run_id>/k6-summary.json ${scriptRelPath}`
  };
}

export async function executeDirectK6Segment({
  runId,
  workerId = 'EC2-Worker-01',
  segment = '0:0.5',
  segmentSequence = '0,0.5,1',
  segmentRatio = 0.5,
  scriptRelPath = 'k6/flows/ecommerce-userflows.js',
  selectedScenarios = null,
  envVars = {},
  vusOverride = null,
  durationOverride = null,
  useRealK6 = true,
  baseRoot = FRAMEWORK_ROOT,
  onRow = () => {},
  onStatus = () => {},
  shouldAbort = () => false
}) {
  const inspected = inspectK6Script(scriptRelPath, baseRoot);
  const baseUrl = envVars.BASE_URL || 'http://127.0.0.1:8089';

  // Prefer real k6 binary when installed on the host
  const k6Bin = detectK6Binary();
  if (useRealK6 && k6Bin.available) {
    const fullScriptPath = path.resolve(baseRoot, scriptRelPath);
    const outDir = path.join(baseRoot, 'results', runId);
    const res = await runRealK6Process({
      k6BinaryPath: k6Bin.binaryPath,
      scriptPath: fullScriptPath,
      runId,
      workerId,
      segment,
      segmentSequence,
      envVars: { BASE_URL: baseUrl, ...envVars },
      vusOverride,
      durationOverride,
      outDir,
      onRow,
      onStatus,
      shouldAbort
    });
    if (res.ok || shouldAbort()) {
      return { engine: 'k6-cli-native', customMetrics: res.customMetrics };
    }
  }

  const activeScenarios = Array.isArray(selectedScenarios) && selectedScenarios.length > 0
    ? inspected.scenarios.filter((s) => selectedScenarios.includes(s.name))
    : inspected.scenarios;

  let rowCounter = 0;
  let activeVus = 0;

  async function runScenarioIteration(sc, vuIndex, iterIndex) {
    if (shouldAbort()) return;
    activeVus++;
    const targetVus = Number(vusOverride || sc.maxVUs || sc.vus || 4);
    onStatus({ workerId, activeVus, loadLevel: targetVus, state: 'running', scenario: sc.name });

    const iterStartTs = Date.now();
    const isGetFlow = sc.name.includes('catalog') || sc.name.includes('identity') || sc.name.includes('health');
    const endpoint = isGetFlow
      ? `${baseUrl}/stats`
      : sc.name.includes('checkout')
        ? `${baseUrl}/modules/agent_mcp_bridge/api/agent`
        : `${baseUrl}/v1/chat/completions`;

    const reqPayloadStr = isGetFlow
      ? ''
      : JSON.stringify({
          model: 'k6-userflow-target',
          prompt: `Execute userflow ${sc.name} (${sc.exec}) iteration ${iterIndex}`
        });
    const reqBytes = Buffer.byteLength(reqPayloadStr, 'utf8') + 180; // HTTP request headers + body

    const t0 = Date.now();
    let httpStatus = 200;
    let completionStatus = 'completed';
    let bodyText = '';
    let firstByteMs = null;

    try {
      const res = await fetch(endpoint, {
        method: isGetFlow ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-Run-Id': runId,
          'X-Worker-Id': workerId,
          'X-Scenario': sc.name,
          'X-Exec-Fn': sc.exec
        },
        body: isGetFlow ? undefined : reqPayloadStr
      });
      httpStatus = res.status;
      firstByteMs = Math.max(1, Date.now() - t0);
      bodyText = await res.text();
      if (httpStatus === 429) completionStatus = 'rate_limited';
      else if (httpStatus >= 400) completionStatus = 'http_error';
    } catch (err) {
      httpStatus = 0;
      completionStatus = 'network_error';
    } finally {
      activeVus = Math.max(0, activeVus - 1);
    }

    const e2eMs = Math.max(1, Date.now() - t0);
    const waitingMs = firstByteMs ?? e2eMs;
    const resBytes = Buffer.byteLength(bodyText, 'utf8');
    const idx = ++rowCounter;
    const checkPassed = httpStatus === 200 && bodyText.length > 2;

    // Populate any discovered custom metrics with measured values
    const rowCustomMetrics = {};
    for (const cm of inspected.customMetrics || []) {
      if (cm.type === 'rate') rowCustomMetrics[cm.name] = checkPassed ? 1 : 0;
      else if (cm.type === 'counter') rowCustomMetrics[cm.name] = 1;
      else rowCustomMetrics[cm.name] = e2eMs;
    }

    const iterDurationMs = Math.max(e2eMs, Date.now() - iterStartTs);
    const hostRes = sampleHostResources();

    const row = {
      aiperf: 1,
      mode: 'direct-k6',
      engine: 'node-http-measured',
      row_id: `${runId}_${workerId}_${idx}`,
      run_id: runId,
      worker_id: workerId,
      execution_segment: segment,
      ts: new Date().toISOString(),
      workload: `k6:${path.basename(scriptRelPath)}`,
      scenario_id: sc.name,
      exec_fn: sc.exec,
      executor: sc.executor,
      load_level: targetVus,
      prompt_id: `${sc.name}#${sc.exec}`,
      category: sc.tags?.flow || sc.name,
      turn: iterIndex,
      session_id: `VU_${vuIndex}_ITER_${iterIndex}`,
      trace_id: `k6_${crypto.randomBytes(4).toString('hex')}`,
      completion_status: completionStatus,
      http_status: httpStatus,
      ttft_ms: waitingMs,
      e2e_ms: e2eMs,
      req_bytes: reqBytes,
      res_bytes: resBytes,
      group_duration_ms: e2eMs,
      iteration_duration_ms: iterDurationMs,
      host_resources: hostRes,
      custom_metrics: Object.keys(rowCustomMetrics).length ? rowCustomMetrics : undefined,
      steps: 1,
      tool_calls: [sc.exec],
      det_pass: checkPassed,
      det_failed: checkPassed ? [] : ['check_failed'],
      correctness: checkPassed ? 1.0 : 0.0,
      groundedness: checkPassed ? 1.0 : 0.0,
      answer: `[Scenario: ${sc.name} | Function: ${sc.exec}() | Executor: ${sc.executor}] HTTP ${httpStatus} (${e2eMs}ms, ${resBytes}B) — Payload: ${bodyText.slice(0, 180)}`,
      contexts: [`Script: ${scriptRelPath}`, `Tags: ${JSON.stringify(sc.tags || {})}`],
      prompt_tokens: 0,
      completion_tokens: 0,
      est_cost: 0,
      vars: envVars,
      server_timing: {
        planning_ms: 0,
        tools_ms: waitingMs,
        synthesis_ms: Math.max(0, e2eMs - waitingMs),
        total_ms: e2eMs
      }
    };

    onRow(row);
    onStatus({ workerId, activeVus, loadLevel: targetVus, state: 'running', scenario: sc.name });
  }

  const durMs = durationOverride
    ? Math.min(30000, Math.max(3000, parseFloat(durationOverride) * 1000))
    : 6500;

  await Promise.all(
    activeScenarios.map(async (sc) => {
      const fullVus = Number(vusOverride || sc.maxVUs || sc.vus || 4);
      const workerVus = Math.max(1, Math.round(fullVus * segmentRatio));
      const endTs = Date.now() + durMs;

      const vuTasks = [];
      for (let v = 1; v <= workerVus; v++) {
        vuTasks.push(
          (async () => {
            let iter = 1;
            while (Date.now() < endTs && !shouldAbort()) {
              await runScenarioIteration(sc, v, iter++);
              await new Promise((r) => setTimeout(r, 180));
            }
          })()
        );
      }
      await Promise.all(vuTasks);
    })
  );

  onStatus({ workerId, activeVus: 0, loadLevel: 0, state: 'idle' });
  return { engine: 'node-http-measured', customMetrics: {} };
}
