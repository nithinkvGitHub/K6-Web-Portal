// flows/ai-assistant-rag.js - Imported by composite multi-population runner
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { buildCorrelationHeaders } from '../lib/auth-helper.js';

export function aiCopilotSseFlow(ctx) {
  group('Population Flow: AI Copilot SSE Streaming', () => {
    const headers = {
      ...buildCorrelationHeaders(ctx.runId, 'POP_AI_SSE_USERS', ctx.injectorId, ctx.sessionId),
      Accept: 'text/event-stream'
    };
    const res = http.post(`${ctx.baseUrl}/modules/agent_mcp_bridge/api/agent/stream`, JSON.stringify({
      stream: true,
      prompt: 'Analyze cluster CPU and memory utilization across nodes'
    }), { headers });
    check(res, {
      'SSE stream HTTP 200': (r) => r.status === 200,
      'SSE events received': (r) => r.body && r.body.includes('answer_delta')
    });
  });
  sleep(0.5);
}
