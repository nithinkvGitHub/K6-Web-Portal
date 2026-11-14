// flows/login-session.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { buildCorrelationHeaders } from '../lib/auth-helper.js';

export function oauthLoginFlow(ctx) {
  group('Population Flow: OAuth2 Token & Session Init', () => {
    const headers = buildCorrelationHeaders(ctx.runId, 'POP_OAUTH_USERS', ctx.injectorId, ctx.sessionId);
    const res = http.post(`${ctx.baseUrl}/v1/chat/completions`, JSON.stringify({
      prompt: 'What is the standard fee schedule?'
    }), { headers });
    check(res, { 'login HTTP 200': (r) => r.status === 200 });
  });
  sleep(0.3);
}
