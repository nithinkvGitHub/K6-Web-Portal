// lib/auth-helper.js - Shared authentication & correlation header library
export function buildCorrelationHeaders(runId, populationId, injectorId, sessionId) {
  return {
    'Content-Type': 'application/json',
    'X-Test-Run-Id': runId,
    'X-Population-Id': populationId,
    'X-Injector-Node': injectorId,
    'X-Session-Id': sessionId,
    'traceparent': `00-${Date.now().toString(16).padStart(32, '0')}-${Math.random().toString(16).slice(2, 18).padStart(16, '0')}-01`
  };
}
