// server/k6-zip-exporter.mjs
// Dynamically generates the Grafana Cloud k6 Multi-File CSV Export Bundle (metrics.csv + metric_*.csv inside a .zip archive)
// Uses unified sample standard deviation (n - 1) from stats-engine.mjs and only exports metrics actually measured in the run.

import { calcStatsSummary } from './stats-engine.mjs';

function csvQuote(val) {
  if (val === null || val === undefined || val === '') return '""';
  if (typeof val === 'number') return String(val);
  const s = String(val).replace(/"/g, '""');
  return `"${s}"`;
}

function calcStats(values = []) {
  const s = calcStatsSummary(values);
  return {
    count: s.count,
    min: s.min,
    mean: s.avg,
    median: s.med,
    p95: s.p95,
    p99: s.p99,
    max: s.max,
    stdev: s.count > 1 ? s.stdev : '""'
  };
}

function mapWorkerToLoadZone(workerId = 'EC2-Worker-01') {
  const clean = String(workerId || 'injector-1').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  if (clean.includes('02') || clean.includes('worker-2')) return `aws:ap-south-1b:${clean}`;
  if (clean.includes('03') || clean.includes('worker-3')) return `aws:ap-south-1c:${clean}`;
  return `aws:ap-south-1a:${clean}`;
}

export function buildK6ExportCsvFiles(summary, rows = []) {
  const isAiRun =
    summary?.run_type === 'ai' ||
    summary?.counter_profile === 'ai' ||
    rows.some((r) => r.prompt_tokens > 0 || (r.server_timing && r.server_timing.planning_ms > 0));

  // Group rows into 12-second time buckets (matching Grafana Cloud k6 12s aggregation buckets)
  const timestamps = rows.map((r) => new Date(r.ts).getTime()).filter((t) => Number.isFinite(t));
  const minTs = timestamps.length ? Math.min(...timestamps) : Date.now() - 12000;
  const bucketMs = 12000;

  const bucketedRows = new Map();
  for (const r of rows) {
    const t = new Date(r.ts).getTime() || minTs;
    const bIndex = Math.max(0, Math.floor((t - minTs) / bucketMs));
    const bucketIso = new Date(minTs + bIndex * bucketMs)
      .toISOString()
      .replace('.000Z', '+00:00')
      .replace(/\.\d+Z$/, '+00:00');
    if (!bucketedRows.has(bucketIso)) bucketedRows.set(bucketIso, []);
    bucketedRows.get(bucketIso).push(r);
  }

  const TREND_HEADER = '"time","metric","scenario","group","load_zone","tags","count","min","mean","median","p95","p99","max","stdev"';
  const HTTP_TREND_HEADER = '"time","metric","group","scenario","name","method","status","expected_response","load_zone","tags","count","min","mean","median","p95","p99","max","stdev"';
  const HTTP_RATE_HEADER = '"time","metric","group","scenario","name","method","status","expected_response","load_zone","tags","nz_count","count"';
  const RATE_HEADER = '"time","metric","scenario","group","load_zone","tags","nz_count","count"';
  const CHECKS_HEADER = '"time","metric","scenario","group","check","load_zone","tags","nz_count","count"';
  const COUNTER_HEADER = '"time","metric","scenario","group","load_zone","tags","count"';
  const GAUGE_HEADER = '"time","metric","scenario","group","load_zone","tags","count","min","mean","max","last"';

  const httpReqDurationLines = [HTTP_TREND_HEADER];
  const httpReqFailedLines = [HTTP_RATE_HEADER];
  const checksLines = [CHECKS_HEADER];
  const groupDurationLines = [TREND_HEADER];
  const iterDurationLines = [TREND_HEADER];
  const iterationsLines = [COUNTER_HEADER];
  const dataReceivedLines = [COUNTER_HEADER];
  const dataSentLines = [COUNTER_HEADER];
  const userflowChecksLines = [RATE_HEADER];
  const vusLines = [GAUGE_HEADER];
  const vusMaxLines = [GAUGE_HEADER];
  const lgCpuLines = [GAUGE_HEADER];
  const lgMemLines = [GAUGE_HEADER];
  const lgFilesLines = [GAUGE_HEADER];

  // Dynamic per-scenario / per-flow trend files
  const scenarioTrendMap = new Map(); // metricName -> lines[]
  // Dynamic custom metrics discovered from script / rows
  const customMetricLinesMap = new Map(); // metricName -> { type, origin, lines[] }

  // AI-specific metric CSV lines
  const aiTtftLines = [TREND_HEADER];
  const aiCorrectnessLines = [TREND_HEADER];
  const aiGroundednessLines = [TREND_HEADER];
  const aiStagePlanningLines = [TREND_HEADER];
  const aiStageToolsLines = [TREND_HEADER];
  const aiStageSynthesisLines = [TREND_HEADER];

  const distinctWorkers = Array.from(new Set(rows.map((r) => r.worker_id || 'EC2-Worker-01')));

  for (const [timeIso, bRows] of bucketedRows.entries()) {
    const byKey = new Map();
    for (const r of bRows) {
      const scenario = r.population_id || r.scenario_id || 'default_scenario';
      const group = r.group_name || `::UserFlow: ${r.category || scenario}`;
      const loadZone = mapWorkerToLoadZone(r.worker_id);
      const method = r.protocol || (r.ttft_ms ? 'SSE' : 'POST');
      const status = String(r.http_status ?? 200);
      const urlName = r.url_name || `http://127.0.0.1:8089/${scenario}/${r.prompt_id || 'req'}`;
      const key = `${scenario}||${group}||${loadZone}||${method}||${status}||${urlName}`;
      if (!byKey.has(key)) {
        byKey.set(key, { scenario, group, loadZone, method, status, urlName, list: [] });
      }
      byKey.get(key).list.push(r);
    }

    for (const grp of byKey.values()) {
      const { scenario, group, loadZone, method, status, urlName, list } = grp;
      const runIdStr = summary?.run_id || 'run';
      const tagsStr = `{'url': '${urlName}', 'flow': '${scenario}', 'proto': 'HTTP/1.1', 'run_id': '${runIdStr}', 'worker': '${loadZone}'}`;
      const flowTagsStr = `{'flow': '${scenario}', 'run_id': '${runIdStr}', 'worker': '${loadZone}'}`;

      const durations = list.map((x) => Number(x.e2e_ms || 0));
      const st = calcStats(durations);
      const expectedResp = status === '200' ? 'true' : 'false';
      const failedCount = list.filter((x) => Number(x.http_status ?? 200) >= 400 || Number(x.http_status) === 0).length;
      const passedChecks = list.filter((x) => x.det_pass !== false && Number(x.http_status ?? 200) === 200).length;

      // metric_http_req_duration.csv
      httpReqDurationLines.push([
        csvQuote(timeIso),
        csvQuote('http_req_duration'),
        csvQuote(group),
        csvQuote(scenario),
        csvQuote(urlName),
        csvQuote(method),
        csvQuote(status),
        csvQuote(expectedResp),
        csvQuote(loadZone),
        csvQuote(tagsStr),
        st.count, st.min, st.mean, st.median, st.p95, st.p99, st.max, st.stdev
      ].join(','));

      // metric_http_req_failed.csv
      httpReqFailedLines.push([
        csvQuote(timeIso),
        csvQuote('http_req_failed'),
        csvQuote(group),
        csvQuote(scenario),
        csvQuote(urlName),
        csvQuote(method),
        csvQuote(status),
        csvQuote(expectedResp),
        csvQuote(loadZone),
        csvQuote(tagsStr),
        failedCount,
        st.count
      ].join(','));

      // metric_checks.csv
      checksLines.push([
        csvQuote(timeIso),
        csvQuote('checks'),
        csvQuote(scenario),
        csvQuote(group),
        csvQuote(`${scenario} status 200`),
        csvQuote(loadZone),
        csvQuote(flowTagsStr),
        passedChecks,
        st.count
      ].join(','));

      // Measured group_duration & iteration_duration (only from rows that recorded them, or fallback to measured e2e_ms)
      const measuredGrpVals = list.map((x) => x.group_duration_ms ?? x.e2e_ms).filter((v) => v != null).map(Number);
      if (measuredGrpVals.length > 0) {
        const grpDur = calcStats(measuredGrpVals);
        groupDurationLines.push([
          csvQuote(timeIso), csvQuote('group_duration'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
          grpDur.count, grpDur.min, grpDur.mean, grpDur.median, grpDur.p95, grpDur.p99, grpDur.max, grpDur.stdev
        ].join(','));
      }

      const measuredIterVals = list.map((x) => x.iteration_duration_ms ?? x.e2e_ms).filter((v) => v != null).map(Number);
      if (measuredIterVals.length > 0) {
        const iterDur = calcStats(measuredIterVals);
        iterDurationLines.push([
          csvQuote(timeIso), csvQuote('iteration_duration'), csvQuote(scenario), csvQuote(''), csvQuote(loadZone), csvQuote(flowTagsStr),
          iterDur.count, iterDur.min, iterDur.mean, iterDur.median, iterDur.p95, iterDur.p99, iterDur.max, iterDur.stdev
        ].join(','));
      }

      iterationsLines.push([csvQuote(timeIso), csvQuote('iterations'), csvQuote(scenario), csvQuote(''), csvQuote(loadZone), csvQuote(flowTagsStr), st.count].join(','));

      // Measured bytes received & sent
      const measuredRcv = list.filter((x) => x.res_bytes != null).reduce((acc, x) => acc + Number(x.res_bytes || 0), 0);
      if (measuredRcv > 0) {
        dataReceivedLines.push([csvQuote(timeIso), csvQuote('data_received'), csvQuote(scenario), csvQuote(''), csvQuote(loadZone), csvQuote(flowTagsStr), measuredRcv].join(','));
      }
      const measuredSnt = list.filter((x) => x.req_bytes != null).reduce((acc, x) => acc + Number(x.req_bytes || 0), 0);
      if (measuredSnt > 0) {
        dataSentLines.push([csvQuote(timeIso), csvQuote('data_sent'), csvQuote(scenario), csvQuote(''), csvQuote(loadZone), csvQuote(flowTagsStr), measuredSnt].join(','));
      }

      userflowChecksLines.push([
        csvQuote(timeIso), csvQuote('userflow_checks_passed'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr), passedChecks, st.count
      ].join(','));

      // Dynamic flow_<scenario>_duration trend
      const cleanScen = scenario.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const flowMetricName = cleanScen.startsWith('flow_') ? `${cleanScen}_duration` : `flow_${cleanScen}_duration`;
      if (!scenarioTrendMap.has(flowMetricName)) {
        scenarioTrendMap.set(flowMetricName, [TREND_HEADER]);
      }
      scenarioTrendMap.get(flowMetricName).push([
        csvQuote(timeIso), csvQuote(flowMetricName), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
        st.count, st.min, st.mean, st.median, st.p95, st.p99, st.max, st.stdev
      ].join(','));

      // Dynamic custom metrics on rows
      const customNamesInList = new Set();
      for (const x of list) {
        if (x.custom_metrics && typeof x.custom_metrics === 'object') {
          for (const k of Object.keys(x.custom_metrics)) customNamesInList.add(k);
        }
      }
      for (const cmName of customNamesInList) {
        const cmVals = list.map((x) => x.custom_metrics?.[cmName]).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
        if (!cmVals.length) continue;
        if (!customMetricLinesMap.has(cmName)) {
          customMetricLinesMap.set(cmName, { type: 'trend', origin: 'script', lines: [TREND_HEADER] });
        }
        const cmSt = calcStats(cmVals);
        customMetricLinesMap.get(cmName).lines.push([
          csvQuote(timeIso), csvQuote(cmName), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
          cmSt.count, cmSt.min, cmSt.mean, cmSt.median, cmSt.p95, cmSt.p99, cmSt.max, cmSt.stdev
        ].join(','));
      }

      // AI-specific measured metrics
      if (isAiRun) {
        const ttftVals = list.map((x) => x.ttft_ms).filter((v) => v != null && Number(v) > 0).map(Number);
        if (ttftVals.length > 0) {
          const ttftSt = calcStats(ttftVals);
          aiTtftLines.push([
            csvQuote(timeIso), csvQuote('time_to_first_token'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            ttftSt.count, ttftSt.min, ttftSt.mean, ttftSt.median, ttftSt.p95, ttftSt.p99, ttftSt.max, ttftSt.stdev
          ].join(','));
        }

        const corrVals = list.map((x) => x.correctness).filter((v) => v != null).map(Number);
        if (corrVals.length > 0) {
          const corrSt = calcStats(corrVals);
          aiCorrectnessLines.push([
            csvQuote(timeIso), csvQuote('ai_lexical_correctness'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            corrSt.count, corrSt.min, corrSt.mean, corrSt.median, corrSt.p95, corrSt.p99, corrSt.max, corrSt.stdev
          ].join(','));
        }

        const grndVals = list.map((x) => x.groundedness).filter((v) => v != null).map(Number);
        if (grndVals.length > 0) {
          const grndSt = calcStats(grndVals);
          aiGroundednessLines.push([
            csvQuote(timeIso), csvQuote('ai_groundedness'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            grndSt.count, grndSt.min, grndSt.mean, grndSt.median, grndSt.p95, grndSt.p99, grndSt.max, grndSt.stdev
          ].join(','));
        }

        const planVals = list.map((x) => x.server_timing?.planning_ms).filter((v) => v != null).map(Number);
        if (planVals.length > 0) {
          const planSt = calcStats(planVals);
          aiStagePlanningLines.push([
            csvQuote(timeIso), csvQuote('stage_planning_duration'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            planSt.count, planSt.min, planSt.mean, planSt.median, planSt.p95, planSt.p99, planSt.max, planSt.stdev
          ].join(','));
        }

        const toolsVals = list.map((x) => x.server_timing?.tools_ms).filter((v) => v != null).map(Number);
        if (toolsVals.length > 0) {
          const toolsSt = calcStats(toolsVals);
          aiStageToolsLines.push([
            csvQuote(timeIso), csvQuote('stage_tools_duration'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            toolsSt.count, toolsSt.min, toolsSt.mean, toolsSt.median, toolsSt.p95, toolsSt.p99, toolsSt.max, toolsSt.stdev
          ].join(','));
        }

        const synthVals = list.map((x) => x.server_timing?.synthesis_ms).filter((v) => v != null).map(Number);
        if (synthVals.length > 0) {
          const synthSt = calcStats(synthVals);
          aiStageSynthesisLines.push([
            csvQuote(timeIso), csvQuote('stage_synthesis_duration'), csvQuote(scenario), csvQuote(group), csvQuote(loadZone), csvQuote(flowTagsStr),
            synthSt.count, synthSt.min, synthSt.mean, synthSt.median, synthSt.p95, synthSt.p99, synthSt.max, synthSt.stdev
          ].join(','));
        }
      }
    }

    // Per-Worker Gauge Metrics (vus, vus_max, and measured OS CPU / Memory / File Handles)
    distinctWorkers.forEach((wId, zIdx) => {
      const zone = mapWorkerToLoadZone(wId);
      const zRows = bRows.filter((r) => (r.worker_id || 'EC2-Worker-01') === wId);
      if (!zRows.length) return;
      const vusVals = zRows.map((r) => Number(r.load_level || 1));
      const minVu = Math.min(...vusVals);
      const maxVu = Math.max(...vusVals);
      const meanVu = Number((vusVals.reduce((a, b) => a + b, 0) / vusVals.length).toFixed(4));
      const lastVu = vusVals[vusVals.length - 1];
      const sysTags = `{'instance_id': '${zIdx}', 'worker_id': '${wId}', 'run_id': '${summary?.run_id || 'run'}'}`;

      vusLines.push([csvQuote(timeIso), csvQuote('vus'), csvQuote(''), csvQuote(''), csvQuote(zone), csvQuote(sysTags), vusVals.length, minVu, meanVu, maxVu, lastVu].join(','));
      vusMaxLines.push([csvQuote(timeIso), csvQuote('vus_max'), csvQuote(''), csvQuote(''), csvQuote(zone), csvQuote(sysTags), vusVals.length, maxVu, maxVu, maxVu, maxVu].join(','));

      const cpuVals = zRows.map((r) => r.host_resources?.cpuPct).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
      if (cpuVals.length > 0) {
        const cMin = Math.min(...cpuVals);
        const cMax = Math.max(...cpuVals);
        const cMean = Number((cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length).toFixed(4));
        const cLast = cpuVals[cpuVals.length - 1];
        lgCpuLines.push([csvQuote(timeIso), csvQuote('load_generator_cpu_percent'), csvQuote(''), csvQuote(''), csvQuote(zone), csvQuote(sysTags), cpuVals.length, cMin, cMean, cMax, cLast].join(','));
      }

      const memVals = zRows.map((r) => r.host_resources?.memPct).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
      if (memVals.length > 0) {
        const mMin = Math.min(...memVals);
        const mMax = Math.max(...memVals);
        const mMean = Number((memVals.reduce((a, b) => a + b, 0) / memVals.length).toFixed(4));
        const mLast = memVals[memVals.length - 1];
        lgMemLines.push([csvQuote(timeIso), csvQuote('load_generator_memory_used_percent'), csvQuote(''), csvQuote(''), csvQuote(zone), csvQuote(sysTags), memVals.length, mMin, mMean, mMax, mLast].join(','));
      }

      const fhVals = zRows.map((r) => r.host_resources?.fileHandles).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
      if (fhVals.length > 0) {
        const fMin = Math.min(...fhVals);
        const fMax = Math.max(...fhVals);
        const fMean = Number((fhVals.reduce((a, b) => a + b, 0) / fhVals.length).toFixed(2));
        const fLast = fhVals[fhVals.length - 1];
        lgFilesLines.push([csvQuote(timeIso), csvQuote('load_generator_file_handles'), csvQuote(''), csvQuote(''), csvQuote(zone), csvQuote(sysTags), fhVals.length, fMin, fMean, fMax, fLast].join(','));
      }
    });
  }

  const files = {};
  const catalogRows = [['"metric"', '"type"', '"origin"']];

  function registerMetricFile(metricName, type, origin, linesArray) {
    if (!linesArray || linesArray.length <= 1) return; // Only include metrics that have actual data rows!
    catalogRows.push([csvQuote(metricName), csvQuote(type), csvQuote(origin)]);
    files[`metric_${metricName}.csv`] = linesArray.join('\r\n') + '\r\n';
  }

  registerMetricFile('checks', 'rate', 'builtin', checksLines);
  registerMetricFile('data_received', 'counter', 'builtin', dataReceivedLines);
  registerMetricFile('data_sent', 'counter', 'builtin', dataSentLines);
  registerMetricFile('group_duration', 'trend', 'builtin', groupDurationLines);
  registerMetricFile('http_req_duration', 'trend', 'builtin', httpReqDurationLines);
  registerMetricFile('http_req_failed', 'rate', 'builtin', httpReqFailedLines);
  registerMetricFile('iteration_duration', 'trend', 'builtin', iterDurationLines);
  registerMetricFile('iterations', 'counter', 'builtin', iterationsLines);
  registerMetricFile('load_generator_cpu_percent', 'gauge', 'builtin', lgCpuLines);
  registerMetricFile('load_generator_file_handles', 'gauge', 'builtin', lgFilesLines);
  registerMetricFile('load_generator_memory_used_percent', 'gauge', 'builtin', lgMemLines);
  registerMetricFile('userflow_checks_passed', 'rate', 'script', userflowChecksLines);
  registerMetricFile('vus', 'gauge', 'builtin', vusLines);
  registerMetricFile('vus_max', 'gauge', 'builtin', vusMaxLines);

  for (const [flowMetricName, lines] of scenarioTrendMap.entries()) {
    registerMetricFile(flowMetricName, 'trend', 'script', lines);
  }

  for (const [cmName, cmObj] of customMetricLinesMap.entries()) {
    registerMetricFile(cmName, cmObj.type, cmObj.origin, cmObj.lines);
  }

  if (isAiRun) {
    registerMetricFile('time_to_first_token', 'trend', 'aiperf', aiTtftLines);
    registerMetricFile('ai_lexical_correctness', 'trend', 'aiperf', aiCorrectnessLines);
    registerMetricFile('ai_groundedness', 'trend', 'aiperf', aiGroundednessLines);
    registerMetricFile('stage_planning_duration', 'trend', 'aiperf', aiStagePlanningLines);
    registerMetricFile('stage_tools_duration', 'trend', 'aiperf', aiStageToolsLines);
    registerMetricFile('stage_synthesis_duration', 'trend', 'aiperf', aiStageSynthesisLines);
  }

  files['metrics.csv'] = catalogRows.map((r) => r.join(',')).join('\r\n') + '\r\n';
  return files;
}

// Pure Node.js Uncompressed ZIP Builder (Zero external npm packages needed)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipBuffer(filesMap) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [filename, contentStr] of Object.entries(filesMap)) {
    const nameBuf = Buffer.from(filename, 'utf8');
    const dataBuf = Buffer.isBuffer(contentStr) ? contentStr : Buffer.from(String(contentStr), 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + size;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const count = Object.keys(filesMap).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}
