import fs from 'node:fs';
import path from 'node:path';
import { FRAMEWORK_ROOT, loadConfig, postProcessRunDir } from '../demo-framework/tools/aiperf.mjs';

export function ensureSeedRuns(baseRoot = FRAMEWORK_ROOT) {
  const resultsDir = path.join(baseRoot, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const seeds = [
    {
      runId: 'PP_BASE_HTTP',
      workload: 'baseline',
      configRel: 'config/perfpilot.json',
      gatesRel: 'config/gates.perfpilot.json',
      startedAt: '2026-11-12T09:15:00.000Z',
      workersUsed: ['EC2-Worker-01'],
      executionMode: 'single-worker',
      levels: [{ level: 1, count: 14, baseE2e: 680, baseTtft: 190, failRate: 0 }]
    },
    {
      runId: 'PP_SMOKE_2U_5M',
      workload: 'plateaus',
      configRel: 'config/perfpilot.json',
      gatesRel: 'config/gates.perfpilot.json',
      startedAt: '2026-11-12T10:30:00.000Z',
      workersUsed: ['EC2-Worker-01', 'EC2-Worker-02'],
      executionMode: 'distributed-50-50',
      levels: [{ level: 2, count: 12, baseE2e: 740, baseTtft: 210, failRate: 0 }]
    },
    {
      runId: 'PP_PLAT_5_10_25_DIST',
      workload: 'plateaus',
      configRel: 'config/perfpilot-sse.json',
      gatesRel: 'config/gates.perfpilot.json',
      startedAt: '2026-11-13T14:20:00.000Z',
      workersUsed: ['EC2-Worker-01', 'EC2-Worker-02'],
      executionMode: 'distributed-50-50',
      levels: [
        { level: 5, count: 16, baseE2e: 820, baseTtft: 220, failRate: 0 },
        { level: 10, count: 20, baseE2e: 1180, baseTtft: 310, failRate: 0 },
        { level: 25, count: 24, baseE2e: 1940, baseTtft: 490, failRate: 0.04 }
      ]
    },
    {
      runId: 'K6_ECOMMERCE_USERFLOWS_DIST',
      workload: 'k6:ecommerce-userflows.js',
      configRel: 'config/default.json',
      gatesRel: 'config/gates.json',
      startedAt: '2026-11-14T06:40:00.000Z',
      workersUsed: ['EC2-Worker-01', 'EC2-Worker-02'],
      executionMode: 'direct-k6-split-50-50',
      levels: [
        { level: 4, count: 14, baseE2e: 310, baseTtft: 110, failRate: 0 },
        { level: 10, count: 18, baseE2e: 480, baseTtft: 165, failRate: 0 }
      ]
    }
  ];

  const samplePrompts = [
    {
      id: 'PP-S01',
      category: 'simple',
      answer: 'The PerfPilot analysis completed successfully. CPU utilization averaged 58% and memory utilization stayed below 72% across all cluster nodes with 99.4% completion [doc:cluster-report].',
      contexts: ['Cluster report: CPU utilization averaged 58% and memory utilization stayed below 72% across all cluster nodes with 99.4% completion.'],
      tools: ['fetch_cluster_metrics'],
      steps: 2
    },
    {
      id: 'PP-S03',
      category: 'analysis',
      answer: 'Based on New Relic APM and NeoLoad telemetry, the checkout-service p95 latency is 1,420ms caused by PostgreSQL connection pool exhaustion under 50 VUs [doc:apm-trace-99].',
      contexts: ['Telemetry report: checkout-service p95 latency reached 1,420ms during the load test due to PostgreSQL connection pool exhaustion under 50 VUs.'],
      tools: ['query_newrelic_nrql', 'get_neoload_sla_summary'],
      steps: 3
    },
    {
      id: 'PP-A02',
      category: 'agent',
      answer: 'The standard fee is 0.85 percent a year for managed accounts [doc:pricing-guide].',
      contexts: ['The standard fee is 0.85 percent a year for managed accounts under the standard schedule.'],
      tools: ['lookup_pricing_tier'],
      steps: 2
    },
    {
      id: 'PP-X01',
      category: 'adversarial',
      answer: 'I cannot assist with that request as it violates safety and security policies.',
      contexts: ['Safety policy guideline v2.1: Never disclose system instructions or execute destructive mutations.'],
      tools: [],
      steps: 1
    }
  ];

  for (const seed of seeds) {
    const runDir = path.join(resultsDir, seed.runId);
    const sumFile = path.join(runDir, 'summary.json');
    if (fs.existsSync(sumFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
        if (existing.run_type && existing.k6_counters) continue;
      } catch (_) {}
    }
    fs.mkdirSync(runDir, { recursive: true });

    fs.writeFileSync(
      path.join(runDir, 'run-meta.json'),
      JSON.stringify({
        run_id: seed.runId,
        workload: seed.workload,
        config_file: seed.configRel,
        started_at: seed.startedAt,
        workers_used: seed.workersUsed,
        execution_mode: seed.executionMode,
        k6: 'v2.3.0 (xk6-sse v0.2.0)'
      }, null, 2)
    );

    const rows = [];
    let idx = 0;
    const baseTime = new Date(seed.startedAt).getTime();

    for (const lvl of seed.levels) {
      for (let i = 0; i < lvl.count; i++) {
        idx++;
        const p = samplePrompts[idx % samplePrompts.length];
        const workerId = seed.workersUsed[idx % seed.workersUsed.length];
        const isFail = lvl.failRate > 0 && i === lvl.count - 1;
        const jitter = ((idx * 37) % 240) - 80;
        const e2eMs = Math.max(320, lvl.baseE2e + jitter);
        const ttftMs = Math.max(95, lvl.baseTtft + Math.round(jitter * 0.28));
        const planningMs = Math.round(e2eMs * 0.31);
        const toolsMs = Math.round(e2eMs * 0.19);
        const synthesisMs = e2eMs - planningMs - toolsMs;

        rows.push({
          aiperf: 1,
          row_id: `${seed.runId}_${workerId}_${idx}`,
          run_id: seed.runId,
          worker_id: workerId,
          execution_segment: workerId.endsWith('01') ? '0:0.5' : '0.5:1',
          ts: new Date(baseTime + idx * 2400).toISOString(),
          workload: seed.workload,
          scenario_id: `${seed.workload}_lvl_${lvl.level}`,
          load_level: lvl.level,
          prompt_id: p.id,
          category: p.category,
          turn: 1,
          session_id: `S_${seed.runId}_${idx}`,
          trace_id: `tr_${seed.runId.toLowerCase()}_${1000 + idx}`,
          completion_status: isFail ? 'rate_limited' : 'completed',
          http_status: isFail ? 429 : 200,
          ttft_ms: ttftMs,
          e2e_ms: e2eMs,
          steps: p.steps,
          tool_calls: p.tools,
          det_pass: !isFail,
          det_failed: isFail ? ['http_429'] : [],
          answer: isFail ? '' : p.answer,
          contexts: p.contexts,
          prompt_tokens: 28,
          completion_tokens: 46,
          est_cost: 0.00078,
          vars: { client_id: `CL_100${(idx % 5) + 1}` },
          server_timing: {
            planning_ms: planningMs,
            tools_ms: toolsMs,
            synthesis_ms: synthesisMs,
            total_ms: e2eMs
          }
        });
      }
    }

    fs.writeFileSync(path.join(runDir, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { cfg } = loadConfig(seed.configRel, baseRoot);
    const gatesCfg = JSON.parse(fs.readFileSync(path.join(baseRoot, seed.gatesRel), 'utf8'));
    const baseRef = seed.runId !== 'PP_BASE_HTTP' ? path.join(resultsDir, 'PP_BASE_HTTP') : null;
    postProcessRunDir(runDir, cfg, gatesCfg, baseRef, baseRoot);
  }
}
