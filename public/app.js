let overviewState = null;
let liveRows = [];
let selectedRunId = null;
let selectedStudioPath = 'config/perfpilot.json';
let currentExecMode = 'multi-population'; // 'multi-population' | 'aiperf' | 'direct-k6'
let activePopulations = [];

function setExecutionMode(mode) {
  currentExecMode = mode;
  document.getElementById('btnModeMultiPop').className = mode === 'multi-population' ? 'btn btn-primary' : 'btn btn-secondary';
  document.getElementById('btnModeAiperf').className = mode === 'aiperf' ? 'btn btn-primary' : 'btn btn-secondary';
  document.getElementById('btnModeDirectK6').className = mode === 'direct-k6' ? 'btn btn-primary' : 'btn btn-secondary';

  document.getElementById('multiPopPanel').classList.toggle('hidden', mode !== 'multi-population');
  document.getElementById('aiperfPanel').classList.toggle('hidden', mode !== 'aiperf');
  document.getElementById('directK6Panel').classList.toggle('hidden', mode !== 'direct-k6');

  document.getElementById('launcherModeBadge').textContent =
    mode === 'multi-population'
      ? 'Multi-Population + 2 Injectors'
      : mode === 'direct-k6'
        ? 'Direct k6 Multi-Scenario'
        : 'Node -> k6 -> Node';

  if (mode === 'direct-k6') {
    inspectSelectedK6Script();
  }
}

function getSelectedProject() {
  const projects = overviewState?.projects || [];
  const selId = document.getElementById('selProjectWorkspace')?.value;
  return projects.find((p) => p.id === selId) || projects[0] || null;
}

function renderProjectWorkspaces(projects = []) {
  const sel = document.getElementById('selProjectWorkspace');
  if (!sel || !projects.length) return;
  const prevVal = sel.value;
  sel.innerHTML = projects
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${p.fileCount} files)</option>`)
    .join('');
  if (prevVal && projects.some((p) => p.id === prevVal)) {
    sel.value = prevVal;
  }
  onSelectProjectWorkspace(false);
}

function onSelectProjectWorkspace(resetPops = true) {
  const proj = getSelectedProject();
  if (!proj) return;

  const summaryEl = document.getElementById('projectTreeSummary');
  summaryEl.innerHTML = `
    <div><strong>Files (${proj.fileCount}):</strong> <code>${esc((proj.files || []).map((f) => f.path).join(', '))}</code></div>
    <div style="margin-top:3px;"><strong>Datasets:</strong> <code>${esc((proj.datasets || []).join(', ') || 'none')}</code></div>
  `;

  if (resetPops || activePopulations.length === 0) {
    if (Array.isArray(proj.populationsPreset) && proj.populationsPreset.length > 0) {
      activePopulations = JSON.parse(JSON.stringify(proj.populationsPreset));
    } else {
      activePopulations = (proj.entrypoints || []).slice(0, 3).map((ep, idx) => ({
        populationId: `POP_${idx + 1}_${ep.exec.toUpperCase()}`,
        name: `Pop ${idx + 1}: ${ep.name}`,
        flowFile: ep.file,
        execFn: ep.exec,
        protocol: ep.protocol || 'HTTP',
        executor: 'constant-vus',
        vus: ep.defaultVus || 6,
        duration: '7s',
        dataset: (proj.datasets || [])[0] || '',
        injectorDistribution: '50-50',
        injector1Pct: 50,
        injector2Pct: 50
      }));
    }
    renderPopulationsBuilder();
  }
}

function syncPopulationsFromDom() {
  activePopulations.forEach((pop, idx) => {
    const idEl = document.getElementById(`popId_${idx}`);
    const flowEl = document.getElementById(`popFlow_${idx}`);
    const vusEl = document.getElementById(`popVus_${idx}`);
    const durEl = document.getElementById(`popDur_${idx}`);
    const dsEl = document.getElementById(`popDs_${idx}`);
    const distEl = document.getElementById(`popDist_${idx}`);

    if (idEl) pop.populationId = idEl.value.trim() || `POP_${idx + 1}`;
    if (flowEl) {
      const [file, exec, proto] = flowEl.value.split('::');
      pop.flowFile = file;
      pop.execFn = exec || 'default';
      pop.protocol = proto || 'HTTP';
    }
    if (vusEl) pop.vus = Math.max(1, Number(vusEl.value || 6));
    if (durEl) pop.duration = durEl.value.trim() || '7s';
    if (dsEl) pop.dataset = dsEl.value;
    if (distEl) {
      pop.injectorDistribution = distEl.value;
      if (distEl.value === '50-50') { pop.injector1Pct = 50; pop.injector2Pct = 50; }
      else if (distEl.value === '70-30') { pop.injector1Pct = 70; pop.injector2Pct = 30; }
      else if (distEl.value === '30-70') { pop.injector1Pct = 30; pop.injector2Pct = 70; }
      else if (distEl.value === 'injector-1') { pop.injector1Pct = 100; pop.injector2Pct = 0; }
      else if (distEl.value === 'injector-2') { pop.injector1Pct = 0; pop.injector2Pct = 100; }
    }
  });
}

function renderPopulationsBuilder() {
  const proj = getSelectedProject();
  const container = document.getElementById('populationsBuilderList');
  if (!proj || !container) return;

  const entryOpts = (proj.entrypoints || []).map(
    (ep) => `<option value="${esc(ep.file)}::${esc(ep.exec)}::${esc(ep.protocol)}">${esc(ep.file)} &rarr; ${esc(ep.exec)}() [${esc(ep.protocol)}]</option>`
  );
  const dsOpts = [`<option value="">No CSV/JSON Dataset</option>`].concat(
    (proj.datasets || []).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`)
  );

  container.innerHTML = activePopulations
    .map((pop, idx) => {
      const currentFlowVal = `${pop.flowFile}::${pop.execFn}::${pop.protocol || 'HTTP'}`;
      return `
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:6px;flex:1;">
              <span class="badge ${pop.protocol === 'SSE' ? 'badge-info' : 'badge-warn'}">${esc(pop.protocol || 'HTTP')}</span>
              <input type="text" id="popId_${idx}" value="${esc(pop.populationId)}" style="margin:0;padding:4px 8px;font-weight:700;width:185px;" onchange="syncPopulationsFromDom()" />
            </div>
            <button type="button" class="btn btn-danger" style="padding:2px 7px;font-size:10.5px;" onclick="removePopulationRow(${idx})">&#10005;</button>
          </div>

          <div style="margin-bottom:6px;">
            <label style="font-size:10px;margin-bottom:2px;">User-Flow Script &amp; Exported Function</label>
            <select id="popFlow_${idx}" style="margin:0;padding:5px 8px;" onchange="syncPopulationsFromDom(); renderPopulationsBuilder();">
              ${entryOpts.map((opt) => opt.includes(`value="${esc(currentFlowVal)}"`) ? opt.replace('<option ', '<option selected ') : opt).join('')}
            </select>
          </div>

          <div style="display:grid;grid-template-columns:70px 75px 1fr;gap:6px;margin-bottom:6px;">
            <div>
              <label style="font-size:10px;margin-bottom:2px;">Total VUs</label>
              <input type="number" id="popVus_${idx}" value="${pop.vus}" min="1" max="500" style="margin:0;padding:5px 7px;" onchange="syncPopulationsFromDom()" />
            </div>
            <div>
              <label style="font-size:10px;margin-bottom:2px;">Duration</label>
              <input type="text" id="popDur_${idx}" value="${esc(pop.duration)}" style="margin:0;padding:5px 7px;" onchange="syncPopulationsFromDom()" />
            </div>
            <div>
              <label style="font-size:10px;margin-bottom:2px;">Dataset Binding</label>
              <select id="popDs_${idx}" style="margin:0;padding:5px 7px;" onchange="syncPopulationsFromDom()">
                ${dsOpts.map((opt) => opt.includes(`value="${esc(pop.dataset)}"`) ? opt.replace('<option ', '<option selected ') : opt).join('')}
              </select>
            </div>
          </div>

          <div>
            <label style="font-size:10px;margin-bottom:2px;">Load Injector Distribution (EC2-Worker-01 vs EC2-Worker-02)</label>
            <select id="popDist_${idx}" style="margin:0;padding:5px 8px;" onchange="syncPopulationsFromDom()">
              <option value="50-50" ${pop.injectorDistribution === '50-50' ? 'selected' : ''}>Balanced 50% EC2-Injector-01 / 50% EC2-Injector-02</option>
              <option value="injector-1" ${pop.injectorDistribution === 'injector-1' ? 'selected' : ''}>100% Dedicated on EC2-Injector-01 (10.24.1.101)</option>
              <option value="injector-2" ${pop.injectorDistribution === 'injector-2' ? 'selected' : ''}>100% Dedicated on EC2-Injector-02 (10.24.2.102)</option>
              <option value="70-30" ${pop.injectorDistribution === '70-30' ? 'selected' : ''}>Weighted 70% EC2-Injector-01 / 30% EC2-Injector-02</option>
              <option value="30-70" ${pop.injectorDistribution === '30-70' ? 'selected' : ''}>Weighted 30% EC2-Injector-01 / 70% EC2-Injector-02</option>
            </select>
          </div>
        </div>
      `;
    })
    .join('');
}

function addPopulationRow() {
  syncPopulationsFromDom();
  const proj = getSelectedProject();
  const ep = proj?.entrypoints?.[0] || { file: 'flows/catalog-search.js', exec: 'catalogSearchFlow', protocol: 'HTTP' };
  activePopulations.push({
    populationId: `POP_${activePopulations.length + 1}_CUSTOM`,
    name: `Population ${activePopulations.length + 1}`,
    flowFile: ep.file,
    execFn: ep.exec,
    protocol: ep.protocol || 'HTTP',
    executor: 'constant-vus',
    vus: 6,
    duration: '8s',
    dataset: proj?.datasets?.[0] || '',
    injectorDistribution: '50-50',
    injector1Pct: 50,
    injector2Pct: 50
  });
  renderPopulationsBuilder();
}

function removePopulationRow(idx) {
  syncPopulationsFromDom();
  if (activePopulations.length <= 1) return;
  activePopulations.splice(idx, 1);
  renderPopulationsBuilder();
}

async function previewCompositeRunner() {
  syncPopulationsFromDom();
  const box = document.getElementById('compositePreviewBox');
  if (!box.classList.contains('hidden')) {
    box.classList.add('hidden');
    return;
  }
  const proj = getSelectedProject();
  const res = await fetch('/api/projects/preview-runner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: proj.id, populations: activePopulations })
  });
  const data = await res.json();
  box.classList.remove('hidden');
  box.innerHTML = `
    <label>Generated Composite Multi-Population k6 Entrypoint (Synced to EC2 Injectors)</label>
    <pre style="background:#05070d;border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;color:#a5b4fc;margin:0;">${esc(data.script)}</pre>
  `;
}

async function handleFolderUpload(event) {
  const fileList = Array.from(event.target.files || []);
  if (!fileList.length) return;

  const firstRel = fileList[0].webkitRelativePath || fileList[0].name;
  const projectName = firstRel.includes('/') ? firstRel.split('/')[0] : `uploaded-framework-${Date.now()}`;

  const allowedExts = ['.js', '.mjs', '.ts', '.json', '.csv', '.md', '.txt'];
  const filesPayload = [];

  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    if (rel.includes('node_modules/') || rel.includes('.git/')) continue;
    if (!allowedExts.some((ext) => rel.toLowerCase().endsWith(ext))) continue;
    const text = await f.text();
    filesPayload.push({ relativePath: rel, content: text });
  }

  const res = await fetch('/api/projects/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectName, files: filesPayload })
  });
  const data = await res.json();
  if (data.ok) {
    await loadOverview();
    document.getElementById('selProjectWorkspace').value = data.project.id;
    onSelectProjectWorkspace(true);
    alert(`Uploaded project "${data.project.name}" (${filesPayload.length} files) and discovered ${data.project.entrypoints.length} user-flow entrypoints!`);
  }
}

async function inspectSelectedK6Script() {
  const scriptRel = document.getElementById('selDirectK6Script').value;
  const box = document.getElementById('k6ScenariosBox');
  box.innerHTML = `<div style="color:var(--text-2);">Inspecting <code>${esc(scriptRel)}</code> scenarios...</div>`;

  const res = await fetch(`/api/k6/inspect?script=${encodeURIComponent(scriptRel)}`);
  const info = await res.json();
  if (!info.ok) {
    box.innerHTML = `<div style="color:var(--red);">${esc(info.error)}</div>`;
    return;
  }

  const scHtml = (info.scenarios || [])
    .map(
      (s) => `
      <label style="display:flex;align-items:center;gap:8px;text-transform:none;color:var(--text-0);margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" class="chk-k6-scenario" value="${esc(s.name)}" checked style="width:auto;margin:0;" />
        <span><strong>${esc(s.name)}</strong> &rarr; <code>${esc(s.exec)}()</code> <span style="color:var(--text-2);">[${esc(s.executor)} | ${s.maxVUs} VUs | ${esc(s.duration)}]</span></span>
      </label>`
    )
    .join('');

  const thKeys = Object.keys(info.thresholds || {});
  box.innerHTML = `
    <div style="margin-bottom:6px;">${scHtml}</div>
    <div style="font-size:11px;color:var(--text-2);border-top:1px solid var(--border);padding-top:6px;">
      <div><strong>UserFlow Groups:</strong> ${esc((info.groups || []).join(' | ') || 'Default')}</div>
      <div style="margin-top:3px;"><strong>Thresholds:</strong> <code>${esc(thKeys.join(', ') || 'None')}</code></div>
    </div>
  `;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function switchTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  ['warroom', 'results', 'compare', 'studio', 'cluster'].forEach((t) => {
    const sec = document.getElementById(`tab-${t}`);
    if (sec) sec.classList.toggle('hidden', t !== tabName);
  });
  if (tabName === 'results' && !selectedRunId && overviewState?.runs?.length) {
    selectRunDetail(overviewState.runs[0].run_id);
  }
  if (tabName === 'studio') {
    loadStudioFile(selectedStudioPath);
  }
}

function onWorkloadChange() {
  const w = document.getElementById('selWorkload').value;
  const row = document.getElementById('plateauParamsRow');
  row.style.opacity = w === 'plateaus' ? '1' : '0.45';
}

async function loadOverview() {
  const res = await fetch('/api/overview');
  overviewState = await res.json();

  document.getElementById('runCountBadge').textContent = overviewState.runs.length;
  document.getElementById('inpFrameworkRoot').value = overviewState.frameworkRoot || '';

  if (overviewState.workers?.[0]) {
    document.getElementById('inpWorker1Url').value = overviewState.workers[0].url;
  }
  if (overviewState.workers?.[1]) {
    document.getElementById('inpWorker2Url').value = overviewState.workers[1].url;
  }

  renderHeaderCluster(overviewState.workers, overviewState.mockAgent);
  renderWarroomWorkerCards(overviewState.workers);
  renderProjectWorkspaces(overviewState.projects || []);
  renderRunsList(overviewState.runs);
  populateCompareSelectors(overviewState.runs);
  renderStudioFileList(overviewState.files);

  if (overviewState.activePipeline && overviewState.activePipeline.rows?.length && liveRows.length === 0) {
    liveRows = overviewState.activePipeline.rows;
    updatePipelineStepper(overviewState.activePipeline);
    renderLiveMetricsAndChart();
    renderLiveRowsTable();
  } else {
    renderLiveChart([]);
  }
}

function renderHeaderCluster(workers = [], mockAgent = {}) {
  const w1 = workers[0]?.health || {};
  const w2 = workers[1]?.health || {};
  const dot1 = document.getElementById('dotWorker1');
  const dot2 = document.getElementById('dotWorker2');

  dot1.className = 'dot' + (w1.status === 'running' ? ' busy' : '');
  dot2.className = 'dot' + (w2.status === 'running' ? ' busy' : '');

  document.getElementById('pillWorker1').textContent =
    `EC2-Worker-01: ${w1.status === 'running' ? `Running (${w1.activeVus} VUs | CPU ${w1.cpuPct}%)` : `Online (CPU ${w1.cpuPct || 10}%)`}`;
  document.getElementById('pillWorker2').textContent =
    `EC2-Worker-02: ${w2.status === 'running' ? `Running (${w2.activeVus} VUs | CPU ${w2.cpuPct}%)` : `Online (CPU ${w2.cpuPct || 10}%)`}`;
  document.getElementById('pillMockAgent').textContent =
    `Target AI Agent (:8089): ${mockAgent.status === 'ok' ? `Ready (${mockAgent.totalRequests || 0} reqs)` : 'Online'}`;
}

function renderWarroomWorkerCards(workers = []) {
  const container = document.getElementById('warroomWorkerCards');
  container.innerHTML = workers
    .map((w, i) => {
      const h = w.health || {};
      const seg = i === 0 ? '0:0.5 (First 50%)' : '0.5:1 (Second 50%)';
      const isBusy = h.status === 'running';
      return `
        <div style="background:var(--bg-2);border:1px solid ${isBusy ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong>${esc(w.id)}</strong> <span style="color:var(--text-2);font-size:11px;">(${esc(w.privateIp)} &bull; ${esc(w.region)})</span>
            </div>
            <span class="badge ${isBusy ? 'badge-warn' : 'badge-pass'}">${isBusy ? `ACTIVE (${h.activeVus} VUs)` : 'READY'}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:9px;font-size:11.5px;color:var(--text-1);">
            <div>Segment: <code>${seg}</code></div>
            <div>CPU / Mem: <strong>${h.cpuPct || 11}% / ${h.memPct || 32}%</strong></div>
            <div>Turns Sent: <strong>${h.rowsCompleted || 0}</strong></div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function runDoctorCheck() {
  const configRel = document.getElementById('selConfig').value;
  const box = document.getElementById('doctorResultBox');
  box.classList.remove('hidden');
  box.innerHTML = `<div style="color:var(--text-2);">Running <code>node tools/aiperf.mjs doctor --config ${esc(configRel)}</code>...</div>`;

  const res = await fetch('/api/doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configRel })
  });
  const doc = await res.json();

  const rowsHtml = (doc.checks || [])
    .map(
      (c) => `
      <tr>
        <td>${esc(c.field)}</td>
        <td><span class="badge ${c.status === 'OK' ? 'badge-pass' : c.status === 'WARN' ? 'badge-warn' : 'badge-fail'}">${c.status}</span></td>
        <td><code>${esc(c.value)}</code></td>
      </tr>`
    )
    .join('');

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <strong>Preflight Doctor Result (${doc.latencyMs} ms)</strong>
      <span class="badge ${doc.ok ? 'badge-pass' : 'badge-fail'}">${doc.ok ? 'PREFLIGHT OK' : 'FATAL ERROR'}</span>
    </div>
    <table>
      <thead><tr><th>Response Field / Check</th><th>Status</th><th>Detected Value</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function quickStartDemoRun() {
  switchTab('warroom');
  setExecutionMode('multi-population');
  startPipelineRun();
}

async function startPipelineRun() {
  liveRows = [];
  document.getElementById('pipelineConsole').innerHTML = '';
  renderLiveMetricsAndChart();
  renderLiveRowsTable();

  let payload;
  if (currentExecMode === 'multi-population') {
    syncPopulationsFromDom();
    const proj = getSelectedProject();
    payload = {
      mode: 'multi-population',
      runId: document.getElementById('inpRunId').value.trim() || `MULTIPOP_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
      projectId: proj?.id || 'enterprise-omni-framework',
      populations: activePopulations,
      distributionMode: 'split-50-50',
      configRel: 'config/perfpilot.json',
      gatesRel: 'config/gates.perfpilot.json',
      skipPreflight: true
    };
  } else if (currentExecMode === 'direct-k6') {
    const scriptRelPath = document.getElementById('selDirectK6Script').value;
    const checkedScenarios = Array.from(document.querySelectorAll('.chk-k6-scenario:checked')).map((el) => el.value);
    const envRaw = document.getElementById('inpDirectK6Env').value || '';
    const envVars = {};
    envRaw.split(',').forEach((pair) => {
      const [k, ...v] = pair.split('=');
      if (k && k.trim()) envVars[k.trim()] = v.join('=').trim();
    });

    payload = {
      mode: 'direct-k6',
      runId: document.getElementById('inpRunId').value.trim() || `K6_FLOWS_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
      scriptRelPath,
      selectedScenarios: checkedScenarios,
      distributionMode: document.getElementById('selDirectK6DistMode').value,
      durationOverride: document.getElementById('inpDirectK6Duration').value.trim() || '6s',
      envVars,
      configRel: 'config/default.json',
      gatesRel: 'config/gates.json',
      skipPreflight: true
    };
  } else {
    payload = {
      mode: 'aiperf',
      runId: document.getElementById('inpRunId').value.trim() || `PP_DIST_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
      workload: document.getElementById('selWorkload').value,
      distributionMode: document.getElementById('selDistMode').value,
      configRel: document.getElementById('selConfig').value,
      gatesRel: document.getElementById('selGates').value,
      levelsStr: document.getElementById('inpLevels').value.trim() || '2,6',
      holdStr: document.getElementById('inpHold').value.trim() || '5s',
      datasetsOverride: document.getElementById('selDataset').value || null,
      baselineRunId: document.getElementById('selBaselineRun').value || '',
      skipPreflight: document.getElementById('chkSkipPreflight').checked
    };
  }

  const res = await fetch('/api/runs/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) {
    alert(data.error || 'Could not start run');
  }
}

async function stopActiveRun() {
  await fetch('/api/runs/stop', { method: 'POST' });
}

function updatePipelineStepper(p) {
  const s1 = document.getElementById('stepStage1');
  const s2 = document.getElementById('stepStage2');
  const s3 = document.getElementById('stepStage3');
  const badge = document.getElementById('liveRunBadge');

  [s1, s2, s3].forEach((el) => (el.className = 'step-box'));

  if (!p) return;
  badge.textContent = `${p.runId} (${p.stage})`;

  if (p.stage === 'stage1_preflight') {
    s1.classList.add('active');
  } else if (p.stage === 'stage2_k6_distributed') {
    s1.classList.add('done');
    s2.classList.add('active');
  } else if (p.stage === 'stage3_postprocess') {
    s1.classList.add('done');
    s2.classList.add('done');
    s3.classList.add('active');
  } else if (p.stage === 'completed') {
    s1.classList.add('done');
    s2.classList.add('done');
    s3.classList.add('done');
    badge.className = p.summary?.gate?.passed ? 'badge badge-pass' : 'badge badge-fail';
    badge.textContent = `${p.runId} — ${p.summary?.gate?.passed ? 'GATE PASSED' : 'GATE FAILED'}`;
  }
}

function appendConsoleLog(entry) {
  const box = document.getElementById('pipelineConsole');
  const div = document.createElement('div');
  div.className = `log-line ${entry.level || 'info'}`;
  const timeStr = new Date(entry.ts).toLocaleTimeString();
  div.textContent = `[${timeStr}] [${entry.stage}] ${entry.message}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderLiveMetricsAndChart() {
  const n = liveRows.length;
  document.getElementById('liveTotalRows').textContent = n;

  const w1Count = liveRows.filter((r) => String(r.worker_id).includes('01')).length;
  const w2Count = liveRows.filter((r) => String(r.worker_id).includes('02')).length;
  document.getElementById('liveWorkerSplitSub').textContent = `EC2-01: ${w1Count} | EC2-02: ${w2Count}`;

  if (n === 0) {
    document.getElementById('liveE2eP95').textContent = '-- ms';
    document.getElementById('liveTtftSub').textContent = 'TTFT avg: -- ms';
    document.getElementById('livePassRate').textContent = '--%';
    document.getElementById('liveQualityScore').textContent = '--';
    renderLiveChart([]);
    return;
  }

  const e2es = liveRows.map((r) => Number(r.e2e_ms || 0)).sort((a, b) => a - b);
  const p95Idx = Math.min(e2es.length - 1, Math.max(0, Math.ceil(0.95 * e2es.length) - 1));
  const p95 = e2es[p95Idx];
  const avgE2e = Math.round(e2es.reduce((a, b) => a + b, 0) / n);

  const ttfts = liveRows.map((r) => Number(r.ttft_ms || 0)).filter((v) => v > 0);
  const avgTtft = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;

  const detPass = liveRows.filter((r) => r.det_pass).length;
  const compPass = liveRows.filter((r) => r.completion_status === 'completed').length;

  const avgCorr = (liveRows.reduce((s, r) => s + Number(r.correctness ?? 0.92), 0) / n).toFixed(2);
  const avgGrnd = (liveRows.reduce((s, r) => s + Number(r.groundedness ?? 0.91), 0) / n).toFixed(2);

  document.getElementById('liveE2eP95').textContent = `${p95} ms`;
  document.getElementById('liveTtftSub').textContent = `E2E avg: ${avgE2e} ms | TTFT avg: ${avgTtft ? avgTtft + ' ms' : 'n/a'}`;
  document.getElementById('livePassRate').textContent = `${((compPass / n) * 100).toFixed(0)}% / ${((detPass / n) * 100).toFixed(0)}%`;
  document.getElementById('liveQualityScore').textContent = `${avgCorr} / ${avgGrnd}`;

  renderLiveChart(liveRows);
}

function renderLiveChart(rows) {
  const container = document.getElementById('liveChartContainer');
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-2);border:1px dashed var(--border);border-radius:8px;">Waiting for live telemetry from EC2-Worker-01 &amp; EC2-Worker-02...</div>`;
    return;
  }

  const pts = rows.slice(-40);
  const w = 860;
  const h = 195;
  const padL = 48;
  const padR = 20;
  const padT = 18;
  const padB = 28;
  const maxVal = Math.max(1000, ...pts.map((r) => Number(r.e2e_ms || 0))) * 1.1;

  const xFor = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : (i / (pts.length - 1)) * (w - padL - padR));
  const yFor = (val) => padT + (1 - Math.min(1, val / maxVal)) * (h - padT - padB);

  const e2ePoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yFor(r.e2e_ms || 0).toFixed(1)}`).join(' ');
  const ttftPoly = pts
    .map((r, i) => `${xFor(i).toFixed(1)},${yFor(r.ttft_ms || r.e2e_ms * 0.25).toFixed(1)}`)
    .join(' ');

  const circles = pts
    .map((r, i) => {
      const isW1 = String(r.worker_id).includes('01');
      const color = isW1 ? '#f97316' : '#38bdf8';
      return `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(r.e2e_ms || 0).toFixed(1)}" r="4" fill="${color}" />`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;overflow:visible;">
      <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#1e293b" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="#1e293b" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" />
      <text x="6" y="${padT + 4}" fill="#94a3b8" font-size="10">${Math.round(maxVal)}ms</text>
      <text x="6" y="${(padT + h - padB) / 2 + 4}" fill="#94a3b8" font-size="10">${Math.round(maxVal / 2)}ms</text>
      <text x="6" y="${h - padB}" fill="#94a3b8" font-size="10">0ms</text>

      <polyline fill="none" stroke="#f97316" stroke-width="2.5" points="${e2ePoly}" />
      <polyline fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="4,3" points="${ttftPoly}" />
      ${circles}

      <g transform="translate(${padL + 10}, 6)">
        <rect x="0" y="0" width="10" height="10" fill="#f97316" rx="2" />
        <text x="14" y="9" fill="#cbd5e1" font-size="10.5">E2E Latency (Orange=EC2-01, Cyan=EC2-02)</text>
        <rect x="250" y="0" width="10" height="10" fill="#10b981" rx="2" />
        <text x="264" y="9" fill="#cbd5e1" font-size="10.5">TTFT (Time-to-First-Token)</text>
      </g>
    </svg>
  `;
}

function renderLiveRowsTable() {
  const tbody = document.getElementById('liveRowsTbody');
  if (!liveRows.length) return;

  tbody.innerHTML = [...liveRows]
    .reverse()
    .slice(0, 35)
    .map((r, idx) => {
      const isW1 = String(r.worker_id).includes('01');
      const st = r.server_timing || {};
      const timingText = st.planning_ms ? `${st.planning_ms} / ${st.tools_ms} / ${st.synthesis_ms} ms` : 'n/a';
      return `
        <tr style="cursor:pointer;" onclick='inspectTurnRow(${JSON.stringify(r).replace(/'/g, "&#39;")})'>
          <td><span class="badge ${isW1 ? 'badge-warn' : 'badge-info'}">${esc(r.worker_id)}</span></td>
          <td><strong>${r.load_level} VUs</strong></td>
          <td><code>${esc(r.prompt_id)}</code></td>
          <td>${esc(r.category)}</td>
          <td><span class="badge ${r.http_status === 200 ? 'badge-pass' : 'badge-fail'}">${esc(r.completion_status)} (${r.http_status})</span></td>
          <td>${r.ttft_ms != null ? r.ttft_ms + ' ms' : 'n/a'}</td>
          <td><strong>${r.e2e_ms} ms</strong></td>
          <td style="color:var(--text-2);font-size:11px;">${timingText}</td>
          <td><span class="badge ${r.det_pass ? 'badge-pass' : 'badge-fail'}">${r.det_pass ? 'PASS' : 'FAIL'}</span></td>
          <td>${Number(r.correctness ?? 0.9).toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');
}

function inspectTurnRow(row) {
  const modal = document.getElementById('turnModal');
  modal.classList.remove('hidden');
  document.getElementById('modalTurnTitle').textContent = `Turn Inspector — ${row.prompt_id} (${row.worker_id} | Trace: ${row.trace_id})`;
  const st = row.server_timing || {};
  document.getElementById('modalTurnBody').innerHTML = `
    <div class="grid-3" style="margin-bottom:12px;">
      <div class="stat-card">
        <div class="stat-label">Worker &amp; Segment</div>
        <div style="font-weight:700;margin-top:4px;">${esc(row.worker_id)} (<code>${esc(row.execution_segment || '0:1')}</code>)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">E2E / TTFT Latency</div>
        <div style="font-weight:700;margin-top:4px;">${row.e2e_ms} ms / ${row.ttft_ms ?? 'n/a'} ms</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Server Stage Timings</div>
        <div style="font-weight:700;margin-top:4px;">Plan: ${st.planning_ms ?? '-'}ms | Tools: ${st.tools_ms ?? '-'}ms | Synth: ${st.synthesis_ms ?? '-'}ms</div>
      </div>
    </div>
    <label>AI Agent Answer (<code>response.answerPath</code>)</label>
    <div style="background:var(--bg-0);border:1px solid var(--border);padding:12px;border-radius:6px;margin-bottom:12px;color:var(--text-0);">${esc(row.answer || '(Empty response)')}</div>
    <label>Retrieved RAG Contexts (<code>response.contextsPath</code>)</label>
    <div style="background:var(--bg-0);border:1px solid var(--border);padding:12px;border-radius:6px;margin-bottom:12px;color:var(--text-1);">${esc((row.contexts || []).join('\n') || 'None')}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-2);">
      <div>Tool Calls: <code>${esc((row.tool_calls || []).join(', ') || 'none')}</code></div>
      <div>Agent Steps: <strong>${row.steps}</strong></div>
      <div>Tokens (In/Out): <strong>${row.prompt_tokens} / ${row.completion_tokens}</strong> ($${row.est_cost})</div>
      <div>Variables: <code>${esc(JSON.stringify(row.vars || {}))}</code></div>
    </div>
  `;
}

function closeTurnModal() {
  document.getElementById('turnModal').classList.add('hidden');
}

function renderRunsList(runs = []) {
  const container = document.getElementById('runsListContainer');
  if (!runs.length) {
    container.innerHTML = `<div style="color:var(--text-2);">No runs found yet.</div>`;
    return;
  }

  container.innerHTML = runs
    .map((r) => {
      const isSelected = r.run_id === selectedRunId;
      return `
        <div onclick="selectRunDetail('${esc(r.run_id)}')" style="cursor:pointer;background:${isSelected ? 'var(--bg-3)' : 'var(--bg-2)'};border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${esc(r.run_id)}</strong>
            <span class="badge ${r.gate?.passed ? 'badge-pass' : 'badge-fail'}">${r.gate?.passed ? 'GATE PASSED' : 'GATE FAILED'}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-2);margin-top:4px;">
            Workload: <code>${esc(r.workload)}</code> &bull; Rows: <strong>${r.rows}</strong> &bull; E2E p95: <strong>${r.overall?.e2e_p95_ms} ms</strong>
          </div>
          <div style="font-size:11px;color:var(--text-2);margin-top:4px;">
            Workers: ${(r.workers_used || []).join(' + ')} &bull; Max QDUL: <strong>${r.overall?.qdul_pct_max ?? 0}%</strong>
          </div>
        </div>
      `;
    })
    .join('');
}

async function selectRunDetail(runId) {
  selectedRunId = runId;
  renderRunsList(overviewState?.runs || []);

  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  const data = await res.json();
  const s = data.summary;
  if (!s) return;

  const pane = document.getElementById('runDetailPane');

  const warnHtml = (s.warnings || []).length
    ? `<div class="warn-banner"><strong>Framework Warnings:</strong><ul style="margin:5px 0 0 18px;padding:0;">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';

  const levelRows = (s.levels || [])
    .map((l) => {
      const wDist = Object.entries(l.worker_distribution || {})
        .map(([k, v]) => `${k.replace('EC2-Worker-', 'W')}:${v}`)
        .join(' / ');
      return `
        <tr>
          <td><strong>Level ${l.level} VUs</strong>${l.low_sample ? ' <span title="Below minSamples" style="color:var(--amber);">*</span>' : ''}</td>
          <td>${l.in_flight_avg} / ${l.in_flight_peak}</td>
          <td>${l.n} <span style="color:var(--text-2);font-size:10.5px;">(${wDist})</span></td>
          <td>${l.e2e_p50_ms} ms</td>
          <td><strong>${l.e2e_p95_ms} ms</strong></td>
          <td>${l.ttft_p95_ms != null ? l.ttft_p95_ms + ' ms' : 'n/a'}</td>
          <td>${(l.completion_rate * 100).toFixed(1)}%</td>
          <td>${(l.deterministic_pass_rate * 100).toFixed(1)}%</td>
          <td>${l.correctness_avg.toFixed(2)}</td>
          <td>${l.groundedness_avg.toFixed(2)}</td>
          <td>${l.steps_avg}</td>
          <td><span class="badge ${l.qdul_pct_max > 15 ? 'badge-fail' : 'badge-pass'}">${l.qdul_pct_max}%</span></td>
        </tr>
      `;
    })
    .join('');

  const gateRows = (s.gate?.results || [])
    .map(
      (g) => `
      <tr>
        <td>${esc(g.label || g.metric)}</td>
        <td><code>${esc(g.metric)} ${esc(g.op)} ${esc(g.value)}</code></td>
        <td><strong>${g.actual ?? 'n/a'}</strong></td>
        <td><span class="badge ${g.status === 'PASS' ? 'badge-pass' : g.status === 'FAIL' ? 'badge-fail' : 'badge-warn'}">${g.status}</span></td>
      </tr>`
    )
    .join('');

  const turnRows = (data.rows || [])
    .slice(0, 30)
    .map(
      (r) => `
      <tr style="cursor:pointer;" onclick='inspectTurnRow(${JSON.stringify(r).replace(/'/g, "&#39;")})'>
        <td><span class="badge badge-info">${esc(r.worker_id || 'worker-1')}</span></td>
        <td>${r.load_level} VUs</td>
        <td><code>${esc(r.prompt_id)}</code></td>
        <td>${esc(r.category)}</td>
        <td>${r.e2e_ms} ms</td>
        <td>${r.ttft_ms ?? 'n/a'} ms</td>
        <td><span class="badge ${r.det_pass ? 'badge-pass' : 'badge-fail'}">${r.det_pass ? 'PASS' : 'FAIL'}</span></td>
        <td style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.answer)}</td>
      </tr>`
    )
    .join('');

  pane.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 style="margin:0;font-size:18px;">Run Report: ${esc(s.run_id)}</h2>
          <div style="color:var(--text-2);font-size:12px;margin-top:3px;">
            Workload: <code>${esc(s.workload)}</code> &bull; Target: <strong>${esc(s.target_name)}</strong> &bull; Workers: <strong>${(s.workers_used || []).join(', ')}</strong>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <a href="/api/runs/${encodeURIComponent(s.run_id)}/html" target="_blank" class="btn btn-secondary" style="text-decoration:none;">&#128196; Open Native report.html</a>
          <button class="btn btn-secondary" onclick="reprocessRun('${esc(s.run_id)}')">&#8635; Re-Run Eval &amp; Gates</button>
          <span class="badge ${s.gate?.passed ? 'badge-pass' : 'badge-fail'}" style="font-size:12px;padding:6px 12px;">${s.gate?.passed ? 'GATE PASSED (Exit 0)' : 'GATE FAILED (Exit 1)'}</span>
        </div>
      </div>

      ${warnHtml}

      <div class="grid-4" style="margin-bottom:16px;">
        <div class="stat-card">
          <div class="stat-label">Capacity SLO Ceiling</div>
          <div class="stat-value">${s.capacity?.max_passing_level ? s.capacity.max_passing_level + ' VUs' : 'Below Level 1'}</div>
          <div class="stat-sub">${esc(s.capacity?.broke_reason || 'All tested levels met SLO')}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Overall E2E p95 / p50</div>
          <div class="stat-value">${s.overall?.e2e_p95_ms} ms</div>
          <div class="stat-sub">Median p50: ${s.overall?.e2e_p50_ms} ms</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Completion / Det. Pass</div>
          <div class="stat-value">${(s.overall?.completion_rate * 100).toFixed(1)}%</div>
          <div class="stat-sub">Det. Pass: ${(s.overall?.deterministic_pass_rate * 100).toFixed(1)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Correctness / Max QDUL</div>
          <div class="stat-value">${s.overall?.correctness_avg?.toFixed(2)}</div>
          <div class="stat-sub">Max Quality Drop (QDUL): ${s.overall?.qdul_pct_max}%</div>
        </div>
      </div>

      <h3 class="card-title" style="margin-bottom:10px;">Load Level Table (Aggregated across EC2 Workers)</h3>
      <div class="table-wrap" style="margin-bottom:18px;">
        <table>
          <thead>
            <tr>
              <th>Level</th><th>In-Flight avg/peak</th><th>Rows (Worker Split)</th><th>E2E p50</th><th>E2E p95</th><th>TTFT p95</th><th>Complete</th><th>Det. Pass</th><th>Correct</th><th>Grounded</th><th>Steps</th><th>QDUL%</th>
            </tr>
          </thead>
          <tbody>${levelRows}</tbody>
        </table>
      </div>

      <div class="grid-2" style="grid-template-columns:1fr 1fr;">
        <div>
          <h3 class="card-title" style="margin-bottom:10px;">Release Gates (${esc(s.gate?.name)})</h3>
          <table>
            <thead><tr><th>Gate</th><th>Rule</th><th>Actual</th><th>Status</th></tr></thead>
            <tbody>${gateRows}</tbody>
          </table>
        </div>
        <div>
          <h3 class="card-title" style="margin-bottom:10px;">Where the Time Goes (Server Stage Breakdown)</h3>
          ${renderStageBreakdownBox(s.overall?.stage_timings_ms)}
        </div>
      </div>

      <h3 class="card-title" style="margin:18px 0 10px;">Executed AI Turns (<code>rows.jsonl</code> — Click any row to inspect answer)</h3>
      <div class="table-wrap" style="max-height:260px;overflow-y:auto;">
        <table>
          <thead><tr><th>Worker</th><th>Level</th><th>Prompt</th><th>Category</th><th>E2E</th><th>TTFT</th><th>Check</th><th>Answer Preview</th></tr></thead>
          <tbody>${turnRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderStageBreakdownBox(st) {
  if (!st) {
    return `<div style="color:var(--text-2);padding:16px;background:var(--bg-2);border-radius:8px;">No server stage timings reported for this run.</div>`;
  }
  const total = Math.max(1, (st.planning_avg || 0) + (st.tools_avg || 0) + (st.synthesis_avg || 0));
  const pPct = Math.round(((st.planning_avg || 0) / total) * 100);
  const tPct = Math.round(((st.tools_avg || 0) / total) * 100);
  const sPct = 100 - pPct - tPct;

  return `
    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:14px;">
      <div style="display:flex;height:22px;border-radius:6px;overflow:hidden;margin-bottom:12px;">
        <div style="width:${pPct}%;background:#6366f1;" title="Planning"></div>
        <div style="width:${tPct}%;background:#f59e0b;" title="Tools"></div>
        <div style="width:${sPct}%;background:#10b981;" title="Synthesis"></div>
      </div>
      <div class="grid-3">
        <div><span style="color:#818cf8;">&#9632;</span> Planning: <strong>${st.planning_avg} ms</strong> (${pPct}%)</div>
        <div><span style="color:#fbbf24;">&#9632;</span> Tool Calls: <strong>${st.tools_avg} ms</strong> (${tPct}%)</div>
        <div><span style="color:#34d399;">&#9632;</span> Synthesis: <strong>${st.synthesis_avg} ms</strong> (${sPct}%)</div>
      </div>
    </div>
  `;
}

async function reprocessRun(runId) {
  const gatesRel = document.getElementById('selGates').value;
  await fetch('/api/runs/reprocess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, gatesRel, baselineRunId: 'PP_BASE_HTTP' })
  });
  await loadOverview();
  await selectRunDetail(runId);
}

function populateCompareSelectors(runs = []) {
  const refSel = document.getElementById('selCompareRef');
  const candSel = document.getElementById('selCompareCand');
  if (!runs.length) return;

  const opts = runs.map((r) => `<option value="${esc(r.run_id)}">${esc(r.run_id)} (${esc(r.workload)} - E2E p95: ${r.overall?.e2e_p95_ms}ms)</option>`).join('');
  refSel.innerHTML = opts;
  candSel.innerHTML = opts;
  if (runs.length > 1) {
    refSel.value = runs[runs.length - 1].run_id;
    candSel.value = runs[0].run_id;
  }
}

async function runComparison() {
  const referenceRunId = document.getElementById('selCompareRef').value;
  const candidateRunId = document.getElementById('selCompareCand').value;
  const res = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenceRunId, candidateRunId })
  });
  const data = await res.json();

  const rows = (data.checks || [])
    .map(
      (c) => `
      <tr>
        <td><strong>${esc(c.metric)}</strong></td>
        <td>${esc(c.reference)}</td>
        <td>${esc(c.candidate)}</td>
        <td><code>${esc(c.delta)}</code></td>
        <td><span class="badge ${c.verdict === 'REGRESSION' ? 'badge-fail' : c.verdict === 'IMPROVED' ? 'badge-pass' : 'badge-info'}">${esc(c.verdict)}</span></td>
      </tr>`
    )
    .join('');

  document.getElementById('compareResultContainer').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>Comparison: <code>${esc(data.reference_run)}</code> vs <code>${esc(data.candidate_run)}</code></strong>
      <span class="badge ${data.passed ? 'badge-pass' : 'badge-fail'}">${data.passed ? 'NO SIGNIFICANT REGRESSION (Exit 0)' : 'REGRESSION DETECTED (Exit 1)'}</span>
    </div>
    <table>
      <thead><tr><th>Metric</th><th>Reference Run</th><th>Candidate Run</th><th>Delta</th><th>Statistical Verdict (95% CI)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderStudioFileList(files = {}) {
  const all = [
    ...(files.configs || []),
    ...(files.datasets || []),
    ...(files.suites || []),
    ...(files.k6Files || [])
  ];
  const container = document.getElementById('studioFileList');
  container.innerHTML = all
    .map(
      (f) => `
      <div onclick="loadStudioFile('${esc(f)}')" style="cursor:pointer;padding:8px 10px;border-radius:6px;margin-bottom:5px;background:${f === selectedStudioPath ? 'var(--bg-3)' : 'var(--bg-2)'};border:1px solid ${f === selectedStudioPath ? 'var(--accent)' : 'var(--border)'};">
        <code>${esc(f)}</code>
      </div>`
    )
    .join('');
}

async function loadStudioFile(relPath) {
  selectedStudioPath = relPath;
  renderStudioFileList(overviewState?.files || {});
  document.getElementById('studioActiveFileTitle').textContent = relPath;
  const res = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`);
  const data = await res.json();
  document.getElementById('studioEditor').value = data.content || '';
}

async function saveStudioFile() {
  const content = document.getElementById('studioEditor').value;
  await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: selectedStudioPath, content })
  });
  alert(`Saved ${selectedStudioPath}`);
}

async function saveClusterConfig() {
  const frameworkRoot = document.getElementById('inpFrameworkRoot').value.trim();
  const w1Url = document.getElementById('inpWorker1Url').value.trim();
  const w2Url = document.getElementById('inpWorker2Url').value.trim();

  const workers = [
    { ...overviewState.workers[0], url: w1Url },
    { ...overviewState.workers[1], url: w2Url }
  ];
  await fetch('/api/cluster/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frameworkRoot, workers })
  });
  await loadOverview();
  alert('Updated 2-EC2 Cluster & Framework settings!');
}

function connectLiveSse() {
  const es = new EventSource('/api/stream');
  es.addEventListener('pipeline_state', (e) => {
    const p = JSON.parse(e.data);
    updatePipelineStepper(p);
  });
  es.addEventListener('live_row', (e) => {
    const row = JSON.parse(e.data);
    liveRows.push(row);
    renderLiveMetricsAndChart();
    renderLiveRowsTable();
  });
  es.addEventListener('log', (e) => {
    appendConsoleLog(JSON.parse(e.data));
  });
  es.addEventListener('run_completed', () => {
    loadOverview();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadOverview();
  connectLiveSse();
  setInterval(loadOverview, 4000);
});
