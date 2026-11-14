const TEST_PORT = process.env.UI_PORT || 4050;
process.env.UI_PORT = String(TEST_PORT);
await import('./index.mjs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function verify() {
  await sleep(1200);

  const ovRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/overview`);
  const ov = await ovRes.json();
  console.log('[VERIFY] Seeded runs count:', ov.runs.length);
  console.log('[VERIFY] Workers online:', ov.workers.map((w) => `${w.id}:${w.online}`).join(', '));

  const docRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/doctor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configRel: 'config/perfpilot.json' })
  });
  const doc = await docRes.json();
  console.log('[VERIFY] Doctor check ok:', doc.ok, 'latency:', doc.latencyMs, 'ms');

  const inspRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/k6/inspect?script=k6/flows/ecommerce-userflows.js`);
  const insp = await inspRes.json();
  console.log('[VERIFY] Inspected Direct k6 Scenarios:', insp.scenarios.map((s) => `${s.name}->${s.exec}()`).join(', '));

  const startRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/runs/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'direct-k6',
      runId: 'K6_ECOMMERCE_USERFLOWS_2EC2',
      scriptRelPath: 'k6/flows/ecommerce-userflows.js',
      distributionMode: 'split-50-50',
      durationOverride: '3s',
      envVars: { BASE_URL: 'http://127.0.0.1:8089', ENV: 'staging' }
    })
  });
  const startJson = await startRes.json();
  console.log('[VERIFY] Started distributed run:', startJson.ok);

  // Wait for completion
  for (let i = 0; i < 20; i++) {
    await sleep(800);
    const checkOv = await (await fetch(`http://127.0.0.1:${TEST_PORT}/api/overview`)).json();
    if (checkOv.activePipeline?.stage === 'completed') {
      const sum = checkOv.activePipeline.summary;
      console.log('[VERIFY] Distributed Run Completed! Rows:', sum.rows, 'Workers:', sum.workers_used.join('+'), 'Gate Passed:', sum.gate.passed);
      process.exit(0);
    }
  }
  console.error('[VERIFY] Timed out waiting for distributed run');
  process.exit(1);
}

verify();
