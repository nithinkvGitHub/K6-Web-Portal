// server/stats-engine.mjs
// Unified Statistical & Telemetry Engine used across Worker Agents, Post-Processor, Exporter, and API
// Eliminates formula mismatches (uses sample stdev n-1 consistently) and provides real OS resource sampling & time-bucketing.

import os from 'node:os';

export function calcPercentile(sortedNums, p) {
  if (!sortedNums || !sortedNums.length) return 0;
  const idx = Math.min(
    sortedNums.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1)
  );
  return Number(sortedNums[idx]);
}

export function calcSampleStdDev(nums, precomputedMean = null) {
  if (!nums || nums.length <= 1) return 0;
  const mean = precomputedMean !== null
    ? precomputedMean
    : nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

export function calcStatsSummary(values = [], decimals = 2) {
  const nums = values.map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const count = nums.length;
  if (!count) {
    return { count: 0, min: null, mean: null, median: null, p90: null, p95: null, p99: null, max: null, stdev: null };
  }
  const round = (v) => Number(v.toFixed(decimals));
  const min = round(nums[0]);
  const max = round(nums[count - 1]);
  const rawMean = nums.reduce((a, b) => a + b, 0) / count;
  const mean = round(rawMean);
  const median = round(calcPercentile(nums, 50));
  const p90 = round(calcPercentile(nums, 90));
  const p95 = round(calcPercentile(nums, 95));
  const p99 = round(calcPercentile(nums, 99));
  const stdev = count > 1 ? round(calcSampleStdDev(nums, rawMean)) : 0;

  return { count, min, mean, median, p90, p95, p99, max, stdev };
}

/**
 * Computes k6 --execution-segment strings and ratios for N selected injectors.
 * Optionally accepts custom weights [w1, w2, ...].
 */
export function computeSegmentSlices(workerCount, weights = null) {
  const n = Math.max(1, Number(workerCount) || 1);
  if (n === 1) {
    return [{ index: 0, segment: '0:1', ratio: 1.0, start: 0, end: 1 }];
  }
  const normWeights = Array.isArray(weights) && weights.length === n && weights.some((w) => w > 0)
    ? weights.map((w) => Math.max(0, Number(w) || 0))
    : Array.from({ length: n }, () => 1);
  const totalW = normWeights.reduce((a, b) => a + b, 0) || n;

  const slices = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const ratio = normWeights[i] / totalW;
    const next = i === n - 1 ? 1 : Number((cursor + ratio).toFixed(4));
    const segStart = cursor === 0 ? '0' : String(cursor);
    const segEnd = next === 1 ? '1' : String(next);
    slices.push({
      index: i,
      segment: `${segStart}:${segEnd}`,
      ratio: Number(ratio.toFixed(4)),
      start: cursor,
      end: next
    });
    cursor = next;
  }
  return slices;
}

/**
 * Samples real OS CPU, Memory, and active handle count on the current host.
 */
let lastCpuInfo = os.cpus();
export function sampleHostResources() {
  const currentCpus = os.cpus();
  let idleDiff = 0;
  let totalDiff = 0;

  for (let i = 0; i < currentCpus.length; i++) {
    const prev = lastCpuInfo[i]?.times || currentCpus[i].times;
    const curr = currentCpus[i].times;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
    idleDiff += Math.max(0, curr.idle - prev.idle);
    totalDiff += Math.max(0, currTotal - prevTotal);
  }
  lastCpuInfo = currentCpus;

  const cpuPct = totalDiff > 0
    ? Number((((totalDiff - idleDiff) / totalDiff) * 100).toFixed(1))
    : 0;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = totalMem > 0
    ? Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1))
    : 0;

  const fileHandles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles().length
    : null;

  return {
    cpuPct,
    memPct,
    fileHandles,
    hostname: os.hostname(),
    platform: os.platform(),
    cpuCores: currentCpus.length
  };
}

/**
 * Aggregates all rows across the full duration of a run into time buckets (no 60-row truncation).
 */
export function buildTimeBucketSeries(rows = [], targetBuckets = 30) {
  if (!rows || !rows.length) return [];
  const valid = rows
    .map((r) => ({ r, t: new Date(r.ts).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  if (!valid.length) return [];
  const minT = valid[0].t;
  const maxT = valid[valid.length - 1].t;
  const spanMs = Math.max(1000, maxT - minT);
  const bucketMs = Math.max(1000, Math.ceil(spanMs / Math.max(1, targetBuckets)));

  const buckets = new Map();
  for (const { r, t } of valid) {
    const bIdx = Math.floor((t - minT) / bucketMs);
    if (!buckets.has(bIdx)) {
      buckets.set(bIdx, []);
    }
    buckets.get(bIdx).push(r);
  }

  const series = [];
  const maxBucketIdx = Math.floor((maxT - minT) / bucketMs);
  for (let b = 0; b <= maxBucketIdx; b++) {
    const list = buckets.get(b) || [];
    const elapsedSec = Math.round(((b * bucketMs) / 1000));
    const bucketTs = new Date(minT + b * bucketMs).toISOString();
    const e2es = list.map((x) => Number(x.e2e_ms)).filter((v) => Number.isFinite(v)).sort((a, c) => a - c);
    const ttfts = list.map((x) => Number(x.ttft_ms)).filter((v) => Number.isFinite(v) && v > 0).sort((a, c) => a - c);
    const vus = list.length ? Math.max(...list.map((x) => Number(x.load_level || 1))) : 0;
    const errors = list.filter((x) => Number(x.http_status) >= 400 || x.completion_status !== 'completed').length;
    const rps = Number((list.length / (bucketMs / 1000)).toFixed(2));

    series.push({
      bucketIndex: b,
      elapsedSec,
      ts: bucketTs,
      count: list.length,
      rps,
      vus,
      errors,
      errorRatePct: list.length ? Number(((errors / list.length) * 100).toFixed(2)) : 0,
      e2eAvg: e2es.length ? Math.round(e2es.reduce((a, c) => a + c, 0) / e2es.length) : null,
      e2eP50: e2es.length ? Math.round(calcPercentile(e2es, 50)) : null,
      e2eP90: e2es.length ? Math.round(calcPercentile(e2es, 90)) : null,
      e2eP95: e2es.length ? Math.round(calcPercentile(e2es, 95)) : null,
      e2eP99: e2es.length ? Math.round(calcPercentile(e2es, 99)) : null,
      ttftAvg: ttfts.length ? Math.round(ttfts.reduce((a, c) => a + c, 0) / ttfts.length) : null,
      ttftP95: ttfts.length ? Math.round(calcPercentile(ttfts, 95)) : null,
      planningAvg: list.some((x) => x.server_timing?.planning_ms != null)
        ? Math.round(list.reduce((s, x) => s + Number(x.server_timing?.planning_ms || 0), 0) / list.length)
        : null,
      toolsAvg: list.some((x) => x.server_timing?.tools_ms != null)
        ? Math.round(list.reduce((s, x) => s + Number(x.server_timing?.tools_ms || 0), 0) / list.length)
        : null,
      synthesisAvg: list.some((x) => x.server_timing?.synthesis_ms != null)
        ? Math.round(list.reduce((s, x) => s + Number(x.server_timing?.synthesis_ms || 0), 0) / list.length)
        : null
    });
  }
  return series;
}
