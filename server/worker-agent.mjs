import http from 'node:http';
import os from 'node:os';
import { executeWorkerSegment } from '../demo-framework/tools/aiperf.mjs';
import { executeDirectK6Segment } from '../demo-framework/tools/direct-k6-runner.mjs';
import { executePopulationSegmentOnWorker } from '../demo-framework/tools/population-orchestrator.mjs';
import { sampleHostResources } from './stats-engine.mjs';
import { detectK6Binary } from './k6-cli-bridge.mjs';

export function startWorkerAgent({
  workerId = 'EC2-Worker-01',
  port = 4101,
  region = 'ap-south-1a',
  instanceType = 'c6i.2xlarge',
  privateIp = '127.0.0.1',
  isLocalHost = false,
  bindHost = process.env.BIND_HOST || '127.0.0.1'
}) {
  const initialRes = sampleHostResources();
  const k6Info = detectK6Binary();

  let state = {
    workerId,
    port,
    region,
    instanceType,
    privateIp,
    isLocalHost,
    hostname: os.hostname(),
    status: 'idle', // idle | running | stopping
    currentRunId: null,
    executionSegment: null,
    activeVus: 0,
    loadLevel: 0,
    rowsCompleted: 0,
    lastRowTs: null,
    cpuPct: initialRes.cpuPct,
    memPct: initialRes.memPct,
    fileHandles: initialRes.fileHandles,
    k6Available: k6Info.available,
    k6Version: k6Info.version,
    engineMode: k6Info.available ? 'k6-cli-native' : 'node-http-measured',
    startedAt: new Date().toISOString()
  };

  let abortFlag = false;
  const sseSubscribers = new Set();

  function refreshHostTelemetry() {
    const res = sampleHostResources();
    state.cpuPct = res.cpuPct;
    state.memPct = res.memPct;
    state.fileHandles = res.fileHandles;
  }

  function broadcastEvent(eventType, payload) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseSubscribers) {
      try {
        res.write(msg);
      } catch {
        sseSubscribers.delete(res);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const allowedOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-AIPerf-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Optional token authentication when AIPERF_TOKEN is set
    const requiredToken = process.env.AIPERF_TOKEN;
    if (requiredToken && req.url !== '/health') {
      const provided =
        req.headers['x-aiperf-token'] ||
        String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (provided !== requiredToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized worker token' }));
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/health') {
      refreshHostTelemetry();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...state, hostname: os.hostname() }));
      return;
    }

    if (req.method === 'GET' && req.url === '/stream') {
      refreshHostTelemetry();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);
      sseSubscribers.add(res);
      req.on('close', () => sseSubscribers.delete(res));
      return;
    }

    if (req.method === 'POST' && req.url === '/job/stop') {
      const stoppedRunId = state.currentRunId;
      abortFlag = true;
      state.status = 'idle';
      state.activeVus = 0;
      state.loadLevel = 0;
      refreshHostTelemetry();
      broadcastEvent('aborted', { workerId, runId: stoppedRunId, rowsCompleted: state.rowsCompleted });
      broadcastEvent('status', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state }));
      return;
    }

    if (req.method === 'POST' && req.url === '/job/start') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const job = JSON.parse(raw || '{}');

      if (state.status === 'running') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Worker ${workerId} is already busy with ${state.currentRunId}` }));
        return;
      }

      abortFlag = false;
      state.status = 'running';
      state.currentRunId = job.runId;
      state.executionSegment = job.segment || '0:1';
      state.rowsCompleted = 0;
      state.activeVus = 1;
      refreshHostTelemetry();
      broadcastEvent('status', state);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, workerId, runId: job.runId, engineMode: state.engineMode }));

      const onRowCb = (row) => {
        if (abortFlag) return;
        state.rowsCompleted++;
        state.lastRowTs = row.ts;
        broadcastEvent('row', row);
      };
      const onStatusCb = (st) => {
        state.activeVus = st.activeVus;
        state.loadLevel = st.loadLevel;
        refreshHostTelemetry();
        broadcastEvent('status', state);
      };

      const runnerPromise = job.mode === 'multi-population'
        ? executePopulationSegmentOnWorker({
            runId: job.runId,
            workerId,
            workerIndex: Number(job.workerIndex || 0),
            workerCount: Number(job.workerCount || 2),
            projectId: job.projectId || 'enterprise-omni-framework',
            populations: job.populations || [],
            baseUrl: job.baseUrl || 'http://127.0.0.1:8089',
            baseRoot: job.baseRoot,
            shouldAbort: () => abortFlag,
            onRow: onRowCb,
            onStatus: onStatusCb
          })
        : job.mode === 'direct-k6'
          ? executeDirectK6Segment({
              runId: job.runId,
              workerId,
              segment: job.segment || '0:1',
              segmentSequence: job.segmentSequence || '0,1',
              segmentRatio: Number(job.segmentRatio || 1.0),
              scriptRelPath: job.scriptRelPath || 'k6/flows/ecommerce-userflows.js',
              selectedScenarios: job.selectedScenarios || null,
              envVars: job.envVars || {},
              vusOverride: job.vusOverride || null,
              durationOverride: job.durationOverride || null,
              baseRoot: job.baseRoot,
              shouldAbort: () => abortFlag,
              onRow: onRowCb,
              onStatus: onStatusCb
            })
          : executeWorkerSegment({
              runId: job.runId,
              workerId,
              segment: job.segment || '0:1',
              segmentRatio: Number(job.segmentRatio || 1.0),
              workload: job.workload || 'smoke',
              configRel: job.configRel || 'config/default.json',
              datasetsOverride: job.datasetsOverride || null,
              levelsStr: job.levelsStr || '2,6',
              holdStr: job.holdStr || '8s',
              smokeIterations: job.smokeIterations || 4,
              baselineRepeat: job.baselineRepeat || 1,
              baseRoot: job.baseRoot,
              shouldAbort: () => abortFlag,
              onRow: onRowCb,
              onStatus: onStatusCb
            });

      runnerPromise
        .then(() => {
          state.status = 'idle';
          state.activeVus = 0;
          state.loadLevel = 0;
          refreshHostTelemetry();
          if (abortFlag) {
            broadcastEvent('aborted', { workerId, runId: job.runId, rowsCompleted: state.rowsCompleted });
          } else {
            broadcastEvent('completed', { workerId, runId: job.runId, rowsCompleted: state.rowsCompleted });
          }
          broadcastEvent('status', state);
        })
        .catch((err) => {
          state.status = 'idle';
          state.activeVus = 0;
          refreshHostTelemetry();
          broadcastEvent('error', { workerId, runId: job.runId, error: err.message });
          broadcastEvent('status', state);
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ server: null, port, workerId, alreadyRunning: true, getState: () => state });
      } else {
        reject(err);
      }
    });
    server.listen(port, bindHost, () => {
      resolve({ server, port, workerId, alreadyRunning: false, getState: () => state });
    });
  });
}
