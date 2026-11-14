// flows/catalog-search.js - Imported by composite multi-population runner
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { buildCorrelationHeaders } from '../lib/auth-helper.js';

export function catalogSearchFlow(ctx) {
  group('Population Flow: Catalog Search & Filter', () => {
    const headers = buildCorrelationHeaders(ctx.runId, 'POP_RETAIL_BUYERS', ctx.injectorId, ctx.sessionId);
    const res = http.get(`${ctx.baseUrl}/stats`, { headers });
    check(res, {
      'catalog HTTP 200': (r) => r.status === 200,
      'catalog latency < 1500ms': (r) => r.timings.duration < 1500
    });
  });
  sleep(0.3);
}
