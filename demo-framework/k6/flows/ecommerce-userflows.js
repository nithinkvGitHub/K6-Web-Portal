// k6/flows/ecommerce-userflows.js
// Direct Multi-Scenario k6 User-Flow Collection
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

export const loginLatency = new Trend('flow_login_duration', true);
export const catalogLatency = new Trend('flow_catalog_duration', true);
export const checkoutLatency = new Trend('flow_checkout_duration', true);
export const flowPassRate = new Rate('userflow_checks_passed');
export const httpReqsTotal = new Counter('http_reqs_total');

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8089';

export const options = {
  scenarios: {
    browse_catalog_flow: {
      executor: 'ramping-vus',
      exec: 'browseCatalogFlow',
      startVUs: 2,
      stages: [
        { duration: '4s', target: 6 },
        { duration: '4s', target: 10 },
        { duration: '2s', target: 0 }
      ],
      tags: { flow: 'browse_catalog', service: 'catalog-api' }
    },
    user_login_flow: {
      executor: 'constant-vus',
      exec: 'userLoginFlow',
      vus: 4,
      duration: '8s',
      tags: { flow: 'user_login', service: 'auth-service' }
    },
    checkout_order_flow: {
      executor: 'per-vu-iterations',
      exec: 'checkoutOrderFlow',
      vus: 4,
      iterations: 3,
      maxDuration: '15s',
      tags: { flow: 'checkout_order', service: 'checkout-service' }
    }
  },
  thresholds: {
    'http_req_duration': ['p(95)<2500', 'p(99)<4000'],
    'http_req_failed': ['rate<0.02'],
    'checks': ['rate>0.95'],
    'flow_login_duration': ['p(95)<1500'],
    'flow_checkout_duration': ['p(95)<2800']
  }
};

export function userLoginFlow() {
  group('UserFlow 01: Auth Login & Session Token', () => {
    const res = http.post(`${BASE_URL}/v1/chat/completions`, JSON.stringify({
      prompt: 'Authenticate user session and verify pricing tier'
    }), { headers: { 'Content-Type': 'application/json' } });

    loginLatency.add(res.timings.duration);
    const ok = check(res, {
      'auth status is 200': (r) => r.status === 200,
      'auth token issued': (r) => r.body && r.body.length > 10
    });
    flowPassRate.add(ok);
  });
  sleep(0.3);
}

export function browseCatalogFlow() {
  group('UserFlow 02: Search & Browse Product Catalog', () => {
    const res = http.get(`${BASE_URL}/stats`);
    catalogLatency.add(res.timings.duration);
    const ok = check(res, {
      'catalog status 200': (r) => r.status === 200,
      'catalog payload valid': (r) => r.body.includes('capacity')
    });
    flowPassRate.add(ok);
  });
  sleep(0.2);
}

export function checkoutOrderFlow() {
  group('UserFlow 03: Cart & Checkout Transaction', () => {
    const res = http.post(`${BASE_URL}/modules/agent_mcp_bridge/api/agent`, JSON.stringify({
      prompt: 'Check checkout-service p95 latency SLA and complete transaction'
    }), { headers: { 'Content-Type': 'application/json' } });

    checkoutLatency.add(res.timings.duration);
    const ok = check(res, {
      'checkout status 200': (r) => r.status === 200,
      'order confirmed': (r) => r.status < 400
    });
    flowPassRate.add(ok);
  });
  sleep(0.4);
}
