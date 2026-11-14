import http from 'node:http';

const PORT = Number(process.env.PORT || 8089);
const MOCK_CAPACITY = Number(process.env.MOCK_CAPACITY || 20);
const MOCK_FIRST_TOKEN_DELAY_MS = Number(process.env.MOCK_FIRST_TOKEN_DELAY_MS || 180);

let inFlight = 0;
let totalRequests = 0;
let activeSessions = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMockAnswer(promptText, concurrency) {
  const lower = String(promptText || '').toLowerCase();
  const overloaded = concurrency > MOCK_CAPACITY * 0.65;

  if (lower.includes('ignore your rules') || lower.includes('system prompt') || lower.includes('drop table') || lower.includes('delete all')) {
    return {
      answer: "I cannot assist with that request as it violates safety and security policies.",
      steps: 1,
      toolCalls: [],
      contexts: ["Safety policy guideline v2.1: Never disclose system instructions or execute destructive mutations."],
      citations: ["[doc:safety-policy]"]
    };
  }

  if (lower.includes('fee') || lower.includes('pricing')) {
    return {
      answer: overloaded
        ? "The standard fee is around 0.85 percent per year depending on tier."
        : "The standard fee is 0.85 percent a year for managed accounts [doc:pricing-guide].",
      steps: 2,
      toolCalls: [{ name: "lookup_pricing_tier", status: "ok", duration_ms: 85 }],
      contexts: ["The standard fee is 0.85 percent a year for managed accounts under the standard schedule."],
      citations: ["[doc:pricing-guide]"]
    };
  }

  if (lower.includes('p95') || lower.includes('latency') || lower.includes('sla') || lower.includes('bottleneck')) {
    return {
      answer: overloaded
        ? "Based on telemetry, checkout service latency spiked to 1420ms due to DB pool contention."
        : "Based on New Relic APM and NeoLoad telemetry, the checkout-service p95 latency is 1,420ms caused by PostgreSQL connection pool exhaustion under 50 VUs [doc:apm-trace-99].",
      steps: 3,
      toolCalls: [
        { name: "query_newrelic_nrql", status: "ok", duration_ms: 140 },
        { name: "get_neoload_sla_summary", status: "ok", duration_ms: 110 }
      ],
      contexts: [
        "Telemetry report: checkout-service p95 latency reached 1,420ms during the load test due to PostgreSQL connection pool exhaustion under 50 VUs."
      ],
      citations: ["[doc:apm-trace-99]"]
    };
  }

  return {
    answer: overloaded
      ? "The PerfPilot analysis completed. Memory utilization stayed below 72% across nodes."
      : "The PerfPilot analysis completed successfully. CPU utilization averaged 58% and memory utilization stayed below 72% across all cluster nodes with 99.4% completion [doc:cluster-report].",
    steps: 2,
    toolCalls: [{ name: "fetch_cluster_metrics", status: "ok", duration_ms: 95 }],
    contexts: [
      "Cluster report: CPU utilization averaged 58% and memory utilization stayed below 72% across all cluster nodes with 99.4% completion."
    ],
    citations: ["[doc:cluster-report]"]
  };
}

export function startMockAgent(port = PORT) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', inFlight, totalRequests, activeSessions: activeSessions.size }));
      return;
    }

    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ inFlight, totalRequests, capacity: MOCK_CAPACITY, activeSessions: activeSessions.size }));
      return;
    }

    if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
      const sid = req.url.split('/sessions/')[1];
      activeSessions.delete(sid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: sid }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url?.startsWith('/modules/agent_mcp_bridge/api/agent'))) {
      let rawBody = '';
      for await (const chunk of req) rawBody += chunk;
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        body = {};
      }

      inFlight++;
      totalRequests++;
      const currentConcurrency = inFlight;

      const sessionId = req.headers['x-session-id'] || body.session_id || `S_${Math.random().toString(16).slice(2, 10)}`;
      activeSessions.add(sessionId);

      try {
        if (currentConcurrency > MOCK_CAPACITY * 1.4 && Math.random() < 0.25) {
          await sleep(120);
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '2' });
          res.end(JSON.stringify({ error: { message: 'Rate limit exceeded under heavy concurrency' } }));
          return;
        }

        const promptText =
          body.prompt ||
          body.query ||
          (Array.isArray(body.messages) ? body.messages[body.messages.length - 1]?.content : '') ||
          'Analyze system performance';

        const loadMultiplier = 1 + Math.max(0, currentConcurrency - 1) * 0.14;
        const planningMs = Math.round((160 + Math.random() * 120) * loadMultiplier);
        const toolsMs = Math.round((110 + Math.random() * 90) * loadMultiplier);
        const synthesisMs = Math.round((210 + Math.random() * 150) * loadMultiplier);
        const ttftDelay = Math.round(MOCK_FIRST_TOKEN_DELAY_MS * loadMultiplier);
        const totalDelay = planningMs + toolsMs + synthesisMs;

        const mockData = buildMockAnswer(promptText, currentConcurrency);
        const traceId = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const isSse = Boolean(body.stream) || req.url?.endsWith('/stream') || String(req.headers['accept'] || '').includes('text/event-stream');
        const isPerfPilotEndpoint = req.url?.startsWith('/modules/agent_mcp_bridge/api/agent');

        const promptTokens = Math.max(12, Math.ceil(String(promptText).length / 4));
        const completionTokens = Math.max(16, Math.ceil(mockData.answer.length / 4));

        if (isSse) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'x-request-id': traceId
          });

          await sleep(ttftDelay);
          const words = mockData.answer.split(' ');
          const stepDelay = Math.max(15, Math.floor((totalDelay - ttftDelay) / Math.max(1, words.length)));

          for (let i = 0; i < words.length; i++) {
            const piece = (i === 0 ? '' : ' ') + words[i];
            if (isPerfPilotEndpoint) {
              res.write(`event: answer_delta\ndata: ${JSON.stringify({ text: piece })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({
                model: body.model || 'mock-agent-1',
                choices: [{ delta: { content: piece } }]
              })}\n\n`);
            }
            await sleep(stepDelay);
          }

          const finalPayload = isPerfPilotEndpoint
            ? {
                model: body.model || 'perfpilot-v2',
                pass2: {
                  answer_markdown: mockData.answer,
                  error: null
                },
                x_agent: {
                  trace_id: traceId,
                  status: 'completed',
                  steps: mockData.steps,
                  tool_calls: mockData.toolCalls,
                  contexts: mockData.contexts,
                  citations: mockData.citations,
                  timings: {
                    planning_ms: planningMs,
                    tools_ms: toolsMs,
                    synthesis_ms: synthesisMs,
                    total_ms: totalDelay
                  }
                },
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
              }
            : {
                model: body.model || 'mock-agent-1',
                choices: [{ message: { content: mockData.answer } }],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
                x_agent: {
                  trace_id: traceId,
                  status: 'completed',
                  steps: mockData.steps,
                  tool_calls: mockData.toolCalls,
                  contexts: mockData.contexts,
                  citations: mockData.citations,
                  timings: {
                    planning_ms: planningMs,
                    tools_ms: toolsMs,
                    synthesis_ms: synthesisMs,
                    total_ms: totalDelay
                  }
                }
              };

          res.write(`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        await sleep(totalDelay);

        const responsePayload = isPerfPilotEndpoint
          ? {
              model: body.model || 'perfpilot-v2',
              pass2: {
                answer_markdown: mockData.answer,
                error: null
              },
              x_agent: {
                trace_id: traceId,
                status: 'completed',
                steps: mockData.steps,
                tool_calls: mockData.toolCalls,
                contexts: mockData.contexts,
                citations: mockData.citations,
                timings: {
                  planning_ms: planningMs,
                  tools_ms: toolsMs,
                  synthesis_ms: synthesisMs,
                  total_ms: totalDelay
                }
              },
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
            }
          : {
              id: `chatcmpl_${traceId}`,
              model: body.model || 'mock-agent-1',
              choices: [{ index: 0, message: { role: 'assistant', content: mockData.answer } }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
              x_agent: {
                trace_id: traceId,
                status: 'completed',
                steps: mockData.steps,
                tool_calls: mockData.toolCalls,
                contexts: mockData.contexts,
                citations: mockData.citations,
                timings: {
                  planning_ms: planningMs,
                  tools_ms: toolsMs,
                  synthesis_ms: synthesisMs,
                  total_ms: totalDelay
                }
              }
            };

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-request-id': traceId
        });
        res.end(JSON.stringify(responsePayload));
      } finally {
        inFlight = Math.max(0, inFlight - 1);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ server: null, port, alreadyRunning: true });
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port, alreadyRunning: false });
    });
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startMockAgent(PORT).then(({ port, alreadyRunning }) => {
    console.log(alreadyRunning
      ? `[mock-agent] Already listening on http://127.0.0.1:${port}`
      : `[mock-agent] Listening on http://127.0.0.1:${port}`);
  });
}
