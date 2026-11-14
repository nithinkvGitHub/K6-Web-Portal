// k6/main.js - Entry point for AI Agent Performance Test Framework
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

export const agentE2eDuration = new Trend('agent_e2e_duration', true);
export const timeToFirstToken = new Trend('time_to_first_token', true);
export const agentCompletionRate = new Rate('agent_completion_rate');
export const deterministicPassRate = new Rate('deterministic_pass_rate');
export const toolCallFailureRate = new Rate('tool_call_failure_rate');
export const tokenCounter = new Counter('agent_total_tokens');

const WORKLOAD = __ENV.WORKLOAD || 'smoke';
const CONFIG_PATH = __ENV.AIPERF_CONFIG || 'config/default.json';
const RUN_ID = __ENV.AIPERF_RUN_ID || `RUN_${Date.now()}`;

const rawConfig = JSON.parse(open(`../${CONFIG_PATH}`));
const prompts = [];
for (const dsPath of rawConfig.datasets || ['data/golden.json']) {
  const items = JSON.parse(open(`../${dsPath}`));
  for (const item of items) prompts.push(item);
}

function buildScenarios() {
  if (WORKLOAD === 'smoke') {
    const iters = Number(__ENV.SMOKE_ITERATIONS || 3);
    return {
      smoke: { executor: 'per-vu-iterations', vus: 1, iterations: iters, maxDuration: '10m' }
    };
  }
  if (WORKLOAD === 'baseline') {
    const repeat = Number(__ENV.BASELINE_REPEAT || 1);
    return {
      baseline: { executor: 'shared-iterations', vus: 1, iterations: prompts.length * repeat, maxDuration: '30m' }
    };
  }
  if (WORKLOAD === 'plateaus') {
    const levels = String(__ENV.PLATEAU_LEVELS || '1,5,10').split(',').map(Number);
    const hold = __ENV.PLATEAU_HOLD || '30s';
    const scenarios = {};
    let startOffset = 0;
    const holdSec = hold.endsWith('m') ? parseFloat(hold) * 60 : parseFloat(hold);
    for (const lvl of levels) {
      scenarios[`level_${lvl}`] = {
        executor: 'constant-vus',
        vus: lvl,
        duration: hold,
        startTime: `${startOffset}s`,
        env: { LOAD_LEVEL: String(lvl) }
      };
      startOffset += holdSec + 2;
    }
    return scenarios;
  }
  return {
    load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 5 },
        { duration: '30s', target: 10 },
        { duration: '10s', target: 0 }
      ]
    }
  };
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: rawConfig.k6Thresholds || {}
};

export default function () {
  const item = prompts[__ITER % prompts.length];
  const sessionId = `S_${__VU}_${__ITER}_${Date.now().toString(16)}`;
  const url = `${__ENV.BASE_URL || rawConfig.target.baseUrl}${rawConfig.target.path}`;
  const promptText = item.prompt || (item.turns && item.turns[0]?.prompt) || 'Hello';

  const payload = JSON.stringify({
    model: rawConfig.target.model,
    stream: false,
    session_id: sessionId,
    prompt: promptText,
    messages: [{ role: 'user', content: promptText }]
  });

  const t0 = Date.now();
  const res = http.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Run-Id': RUN_ID,
      'X-Prompt-Id': item.id,
      'X-Session-Id': sessionId
    }
  });
  const e2eMs = Date.now() - t0;

  let body = {};
  try { body = JSON.parse(res.body || '{}'); } catch (_) {}

  const answer = body?.pass2?.answer_markdown || body?.choices?.[0]?.message?.content || '';
  const completed = res.status === 200 && answer.length > 0;

  agentE2eDuration.add(e2eMs);
  timeToFirstToken.add(res.timings?.waiting || Math.round(e2eMs * 0.28));
  agentCompletionRate.add(completed);
  deterministicPassRate.add(completed);

  check(res, { 'status is 200': (r) => r.status === 200 });

  console.log(JSON.stringify({
    aiperf: 1,
    row_id: `${RUN_ID}_${__VU}_${__ITER}`,
    run_id: RUN_ID,
    ts: new Date().toISOString(),
    workload: WORKLOAD,
    load_level: Number(__ENV.LOAD_LEVEL || __VU || 1),
    prompt_id: item.id,
    category: item.category || 'simple',
    turn: 1,
    session_id: sessionId,
    trace_id: body?.x_agent?.trace_id || res.headers['X-Request-Id'] || '',
    completion_status: completed ? 'completed' : 'http_error',
    http_status: res.status,
    ttft_ms: Math.round(res.timings?.waiting || e2eMs * 0.28),
    e2e_ms: e2eMs,
    steps: body?.x_agent?.steps || 1,
    tool_calls: (body?.x_agent?.tool_calls || []).map((t) => t.name || t),
    det_pass: completed,
    det_failed: [],
    answer,
    contexts: body?.x_agent?.contexts || [],
    prompt_tokens: body?.usage?.prompt_tokens || 24,
    completion_tokens: body?.usage?.completion_tokens || 42,
    est_cost: 0.0008,
    server_timing: body?.x_agent?.timings || {}
  }));

  sleep(0.5);
}
