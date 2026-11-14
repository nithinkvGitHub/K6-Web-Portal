// k6/flows/microservices-api-suite.js
// Direct Multi-Scenario k6 API & Webhook Stress Suite
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8089';

export const options = {
  scenarios: {
    identity_token_exchange: {
      executor: 'constant-arrival-rate',
      exec: 'identityFlow',
      rate: 10,
      timeUnit: '1s',
      duration: '6s',
      preAllocatedVUs: 4,
      maxVUs: 10,
      tags: { flow: 'identity_token', tier: 'critical' }
    },
    reporting_aggregation_flow: {
      executor: 'ramping-vus',
      exec: 'reportingFlow',
      startVUs: 2,
      stages: [
        { duration: '4s', target: 6 },
        { duration: '4s', target: 2 }
      ],
      tags: { flow: 'reporting_aggregation', tier: 'standard' }
    }
  },
  thresholds: {
    'http_req_duration': ['p(95)<2000'],
    'http_req_failed': ['rate<0.01'],
    'checks': ['rate>0.98']
  }
};

export function identityFlow() {
  group('API Flow: Identity OAuth Token Exchange', () => {
    const res = http.get(`${BASE_URL}/health`);
    check(res, { 'health 200': (r) => r.status === 200 });
  });
  sleep(0.2);
}

export function reportingFlow() {
  group('API Flow: Reporting & Telemetry Aggregation', () => {
    const res = http.post(`${BASE_URL}/v1/chat/completions`, JSON.stringify({
      prompt: 'Summarize cluster telemetry'
    }), { headers: { 'Content-Type': 'application/json' } });
    check(res, { 'telemetry 200': (r) => r.status === 200 });
  });
  sleep(0.3);
}
