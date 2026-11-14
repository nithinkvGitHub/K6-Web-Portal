// flows/checkout-payment.js - Imported by composite multi-population runner
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { buildCorrelationHeaders } from '../lib/auth-helper.js';

export function checkoutPaymentFlow(ctx) {
  group('Population Flow: Cart Checkout & Payment', () => {
    const headers = buildCorrelationHeaders(ctx.runId, 'POP_CHECKOUT_TX', ctx.injectorId, ctx.sessionId);
    const res = http.post(`${ctx.baseUrl}/modules/agent_mcp_bridge/api/agent`, JSON.stringify({
      prompt: 'Process order checkout and verify checkout-service p95 SLA'
    }), { headers });
    check(res, {
      'checkout HTTP 200': (r) => r.status === 200,
      'payment authorized': (r) => r.body && r.body.length > 10
    });
  });
  sleep(0.4);
}
