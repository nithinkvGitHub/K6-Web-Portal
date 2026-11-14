import http from 'node:http';
import os from 'node:os';
import { executeWorkerSegment } from '../demo-framework/tools/aiperf.mjs';
import { executeDirectK6Segment } from '../demo-framework/tools/direct-k6-runner.mjs';
import { executePopulationSegmentOnWorker } from '../demo-framework/tools/population-orchestrator.mjs';

export function startWorkerAgent({
  workerId = 'EC2-Worker-01',
  port = 4101,
  region = 'ap-south-1a',
  instanceType = 'c6i.2xlarge',
  privateIp = '10.24.1.101'
}) {
  let state = {
    workerId,
    port,
    region,
    instanceType,
    privateIp,
    status: 'idle', // idle | running | stopping
    currentRunId: null,
    executionSegment: null,
    activeVus: 0,
    loadLevel: 0,
    rowsCompleted: 0,
    lastRowTs: null,
    cpuPct: 12,
    memPct: 34,
    startedAt: new Date().toISOString()
  };

  let abortFlag = false;
  const sseSubscribers = new Set();

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      state.cpuPct = state.status === 'running'
        ? Math.min(94, 38 + state.activeVus * 6 + Math.round(Math.random() * 8))
        : 8 + Math.round(Math.random() * 6);
      state.memPct = state.status === 'running'
        ? Math.min(88, 42 + state.activeVus * 3)
        : 32;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...state, hostname: os.hostname() }));
      return;
    }

    if (req.method === 'GET' && req.url === '/stream') {
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
      abortFlag = true;
      state.status = 'stopping';
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
      broadcastEvent('status', state);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, workerId, runId: job.runId }));

      // Execute segment asynchronously and stream rows (supports Multi-Population Project, Direct k6, and AI Pipeline)
      const onRowCb = (row) => {
        state.rowsCompleted++;
        state.lastRowTs = row.ts;
        broadcastEvent('row', row);
      };
      const onStatusCb = (st) => {
        state.activeVus = st.activeVus;
        state.loadLevel = st.loadLevel;
        state.cpuPct = st.activeVus > 0 ? Math.min(95, 35 + st.activeVus * 7) : 11;
        broadcastEvent('status', state);
      };

      const runnerPromise = job.mode === 'multi-population'
        ? executePopulationSegmentOnWorker({
            runId: job.runId,
            workerId,
            workerIndex: Number(job.workerIndex || 0),
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
          broadcastEvent('completed', { workerId, runId: job.runId, rowsCompleted: state.rowsCompleted });
          broadcastEvent('status', state);
        })
        .catch((err) => {
          state.status = 'idle';
          state.activeVus = 0;
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
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port, workerId, alreadyRunning: false, getState: () => state });
    });
  });
}
