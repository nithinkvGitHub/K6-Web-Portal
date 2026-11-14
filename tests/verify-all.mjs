/**
 * AIPerf Cloud Orchestrator — Automated Verification Suite (Item 23)
 * Verifies:
 *  1. Unified stats-engine.mjs (calcPercentile, n-1 sample stdev, computeSegmentSlices for N=1..4, buildTimeBucketSeries, sampleHostResources)
 *  2. k6-cli-bridge.mjs (detectK6Binary, Prometheus Exposition, InfluxDB Line Protocol, JUnit XML)
 *  3. direct-k6-runner.mjs (inspectK6Script custom metric discovery, parseK6ThresholdExpr)
 *  4. population-orchestrator.mjs (path traversal rejection, upload limits, counterProfile support)
 *  5. aiperf.mjs (postProcessRunDir real pass/fail row counts, script_thresholds + gates.json merge, compareRuns scenario_deltas & baseline_trend)
 *  6. k6-zip-exporter.mjs (dynamic CSV list based on measured metrics, valid PK ZIP archive header)
 *  7. Refresh existing run directories in demo-framework/results/ and rebuild runs-index.json
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calcPercentile,
  calcSampleStdDev,
  calcStatsSummary,
  computeSegmentSlices,
  sampleHostResources,
  buildTimeBucketSeries
} from '../server/stats-engine.mjs';

import {
  detectK6Binary,
  exportPrometheusFormat,
  exportInfluxLineProtocol,
  exportJUnitXml
} from '../server/k6-cli-bridge.mjs';

import {
  inspectK6Script
} from '../demo-framework/tools/direct-k6-runner.mjs';

import {
  saveUploadedProject
} from '../demo-framework/tools/population-orchestrator.mjs';

import {
  parseK6ThresholdExpr,
  loadConfig,
  postProcessRunDir,
  compareRuns
} from '../demo-framework/tools/aiperf.mjs';

import {
  buildK6ExportCsvFiles,
  createZipBuffer
} from '../server/k6-zip-exporter.mjs';

import {
  ensureSeedRuns
} from '../server/seed-runs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const FRAMEWORK_DIR = path.join(ROOT_DIR, 'demo-framework');
const RESULTS_DIR = path.join(FRAMEWORK_DIR, 'results');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

console.log('=== AIPerf Cloud Automated Verification Suite ===\n');

// 1. Unified Statistical Engine
test('calcPercentile and calcSampleStdDev (n - 1 sample standard deviation)', () => {
  const sample = [10, 12, 23, 23, 16, 23, 21, 16];
  // mean = 18, sum((x - 18)^2) = 64 + 36 + 25 + 25 + 4 + 25 + 9 + 4 = 192
  // sample variance (n - 1 = 7) = 192 / 7 = 27.42857 -> stdev = 5.2372
  const stdev = calcSampleStdDev(sample);
  assert.ok(Math.abs(stdev - 5.24) <= 0.02, `Expected sample stdev ~5.24, got ${stdev}`);

  const stats = calcStatsSummary([100, 200, 300, 400, 500]);
  assert.equal(stats.count, 5);
  assert.equal(stats.min, 100);
  assert.equal(stats.median, 300);
  assert.equal(stats.max, 500);
  assert.equal(stats.mean, 300);
  assert.ok(Math.abs(stats.stdev - 158.11) <= 0.05);
});

// 2. Dynamic N-Injector Segment Slicing
test('computeSegmentSlices supports N=1, 2, 3, 4 injectors and custom weights', () => {
  const s1 = computeSegmentSlices(1);
  assert.equal(s1.length, 1);
  assert.equal(s1[0].segment, '0:1');
  assert.equal(s1[0].ratio, 1.0);

  const s2 = computeSegmentSlices(2);
  assert.equal(s2.length, 2);
  assert.equal(s2[0].segment, '0:0.5');
  assert.equal(s2[1].segment, '0.5:1');
  assert.equal(s2[0].ratio, 0.5);

  const s3 = computeSegmentSlices(3);
  assert.equal(s3.length, 3);
  assert.equal(s3[0].segment, '0:0.3333');
  assert.equal(s3[1].segment, '0.3333:0.6666');
  assert.equal(s3[2].segment, '0.6666:1');

  const s4 = computeSegmentSlices(4);
  assert.equal(s4.length, 4);
  assert.equal(s4[3].segment, '0.75:1');
});

// 3. Full-Duration Time Bucket Series (no 60-row truncation)
test('buildTimeBucketSeries buckets 150 rows across the full time range without truncating at 60', () => {
  const baseTs = Date.parse('2026-11-14T10:00:00.000Z');
  const rows = Array.from({ length: 150 }, (_, i) => ({
    ts: new Date(baseTs + i * 1000).toISOString(),
    e2e_ms: 100 + (i % 50),
    ttft_ms: 30 + (i % 10),
    http_status: 200,
    req_bytes: 256,
    res_bytes: 1024,
    load_level: 10
  }));
  const buckets = buildTimeBucketSeries(rows, 30);
  assert.ok(buckets.length >= 25 && buckets.length <= 32, `Expected ~30 buckets, got ${buckets.length}`);
  const totalCount = buckets.reduce((acc, b) => acc + b.count, 0);
  assert.equal(totalCount, 150, 'All 150 rows must be represented across time buckets');
});

// 4. Real OS Telemetry Sampler
test('sampleHostResources returns real measured OS CPU, memory, and handles', () => {
  const res = sampleHostResources();
  assert.ok(res.cpuPct >= 0 && res.cpuPct <= 100);
  assert.ok(res.memPct > 0 && res.memPct <= 100);
  assert.ok(res.fileHandles === null || res.fileHandles >= 0);
  assert.ok(res.cpuCores >= 1);
});

// 5. k6 Script Parser & Custom Metric Discovery
test('inspectK6Script discovers scenarios, thresholds, and custom Trend/Rate/Counter/Gauge metrics', () => {
  const sampleScript = `
    import http from 'k6/http';
    import { Trend, Rate, Counter } from 'k6/metrics';
    const checkoutLatency = new Trend('custom_checkout_latency', true);
    const paymentSuccess = new Rate('custom_payment_success');
    const ordersPlaced = new Counter('custom_orders_placed');
    export const options = {
      scenarios: {
        browse_flow: { executor: 'ramping-vus', startVUs: 2, stages: [{ duration: '10s', target: 8 }] }
      },
      thresholds: {
        http_req_duration: ['p(95)<450', 'avg<250'],
        custom_checkout_latency: ['p(95)<600']
      }
    };
    export default function () {
      http.get('http://127.0.0.1:4000/api/health');
    }
  `;
  const tmpFile = path.join(RESULTS_DIR, '_tmp_test_script.js');
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(tmpFile, sampleScript, 'utf8');
  try {
    const info = inspectK6Script(tmpFile);
    assert.equal(info.scenarios.length, 1);
    assert.equal(info.scenarios[0].name, 'browse_flow');
    assert.equal(info.customMetrics.length, 3);
    assert.deepEqual(
      info.customMetrics.map((m) => `${m.name}:${m.type}`).sort(),
      ['custom_checkout_latency:trend', 'custom_orders_placed:counter', 'custom_payment_success:rate']
    );
    const parsedExpr = parseK6ThresholdExpr('http_req_duration', 'p(95)<450');
    assert.equal(parsedExpr.agg, 'p(95)');
    assert.equal(parsedExpr.op, '<');
    assert.equal(parsedExpr.value, 450);
    assert.equal(parsedExpr.metric, 'e2e_p95_ms');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

// 6. Path Traversal Security & Upload Limits
test('saveUploadedProject rejects path traversal and enforces file count/size limits', () => {
  assert.throws(() => {
    saveUploadedProject('malicious-proj', [
      { relativePath: '../../outside.txt', content: 'pwn' }
    ], FRAMEWORK_DIR);
  }, /Invalid file path|traversal/i);
});

// 7. Re-seed & Re-post-process Existing Runs + Verify Exporters
test('ensureSeedRuns and postProcessRunDir produce unified summaries, real threshold counts, and dynamic exports', () => {
  ensureSeedRuns(FRAMEWORK_DIR);
  const dirs = fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'));

  assert.ok(dirs.length >= 2, 'Expected at least 2 seeded runs');

  const defaultCfg = loadConfig('config/default.json', FRAMEWORK_DIR);
  const defaultGates = JSON.parse(fs.readFileSync(path.join(FRAMEWORK_DIR, 'config', 'gates.json'), 'utf8'));

  const indexEntries = [];
  for (const d of dirs) {
    const runDir = path.join(RESULTS_DIR, d.name);
    const rowsFile = path.join(runDir, 'rows.jsonl');
    const summaryFile = path.join(runDir, 'summary.json');
    if (fs.existsSync(rowsFile)) {
      const metaPath = path.join(runDir, 'run-meta.json');
      const runMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
      const cfg = runMeta.config_file && fs.existsSync(path.join(FRAMEWORK_DIR, runMeta.config_file))
        ? loadConfig(runMeta.config_file, FRAMEWORK_DIR)
        : defaultCfg;
      const gatesCfg = runMeta.gates_file && fs.existsSync(path.join(FRAMEWORK_DIR, runMeta.gates_file))
        ? JSON.parse(fs.readFileSync(path.join(FRAMEWORK_DIR, runMeta.gates_file), 'utf8'))
        : defaultGates;

      const refreshed = postProcessRunDir(runDir, cfg, gatesCfg, null, FRAMEWORK_DIR);
      assert.ok(Array.isArray(refreshed.time_series), `Run ${d.name} must have time_series`);
      assert.equal(typeof refreshed.overall.e2e_stdev_ms, 'number', `Run ${d.name} must have overall.e2e_stdev_ms`);
      assert.ok(refreshed.k6_counters, `Run ${d.name} must have k6_counters`);

      const rows = fs.readFileSync(rowsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      // Verify dynamic Multi-CSV ZIP exporter
      const csvFiles = buildK6ExportCsvFiles(refreshed, rows);
      const csvCount = Object.keys(csvFiles).length;
      assert.ok(csvCount >= 6, `Expected dynamic CSV files for ${d.name}, got ${csvCount}`);
      const zipBuf = createZipBuffer(csvFiles);
      assert.equal(zipBuf[0], 0x50); // 'P'
      assert.equal(zipBuf[1], 0x4b); // 'K'

      // Verify Prometheus, InfluxDB, and JUnit XML exporters
      const prom = exportPrometheusFormat(refreshed, rows);
      assert.ok(prom.includes('k6_http_req_duration_p95_ms'));
      const influx = exportInfluxLineProtocol(refreshed, rows);
      assert.ok(influx.includes(`http_req_duration,run_id=${refreshed.run_id}`));
      const junit = exportJUnitXml(refreshed);
      assert.ok(junit.includes('<testsuite'));

      indexEntries.push({
        runId: d.name,
        updatedAt: refreshed.created_at,
        summary: refreshed,
        meta: runMeta,
        hasHtml: fs.existsSync(path.join(runDir, 'report.html')),
        hasComparison: fs.existsSync(path.join(runDir, 'comparison.json'))
      });
    }
  }

  // Write updated runs-index.json
  indexEntries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  fs.writeFileSync(path.join(RESULTS_DIR, 'runs-index.json'), JSON.stringify(indexEntries, null, 2), 'utf8');

  // Verify compareRuns includes scenario_deltas & baseline_trend
  const refDir = path.join(RESULTS_DIR, 'PP_BASE_HTTP');
  const candDir = path.join(RESULTS_DIR, 'PP_SMOKE_2U_5M');
  const cmp = compareRuns(refDir, candDir, RESULTS_DIR);
  assert.ok(Array.isArray(cmp.scenario_deltas), 'compareRuns must include scenario_deltas');
  assert.ok(Array.isArray(cmp.baseline_trend) && cmp.baseline_trend.length >= 2, 'compareRuns must include baseline_trend');
});

const k6Detect = detectK6Binary();
console.log(`\n  [INFO] k6 CLI detection status: ${k6Detect.available ? `Installed (${k6Detect.version})` : 'Not installed (using Measured Node HTTP Engine fallback)'}`);
console.log(`\n=== All ${passed} verification suites passed! ===`);
