let overviewState = null;
let liveRows = [];
let selectedRunId = null;
let selectedStudioPath = 'config/perfpilot.json';
let currentExecMode = 'multi-population'; // 'multi-population' | 'aiperf' | 'direct-k6'
let activePopulations = [];
let liveCounterMode = 'k6'; // 'k6' | 'ai'
let runHistoryFilter = 'all'; // 'all' | 'k6' | 'ai'
let currentTheme = localStorage.getItem('aiperf_theme') || 'light';
let selectedInjectorIds = new Set(['EC2-Worker-01']); // Default: only Web Portal Host selected
let initialOverviewLoaded = false;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  localStorage.setItem('aiperf_theme', currentTheme);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.innerHTML = currentTheme === 'light' ? '&#127769; Dark Theme' : '&#9728;&#65039; Light Theme';
  }
}

function toggleTheme() {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  renderLiveChart(liveRows);
  if (typeof renderGrafanaCloudRunView === 'function' && currentRunData?.summary) {
    renderGrafanaCloudRunView();
  }
}

function setLiveCounterMode(mode) {
  liveCounterMode = mode;
  const btnK6 = document.getElementById('btnLiveCounterK6');
  const btnAi = document.getElementById('btnLiveCounterAi');
  if (btnK6) btnK6.className = mode === 'k6' ? 'btn btn-primary' : 'btn btn-secondary';
  if (btnAi) btnAi.className = mode === 'ai' ? 'btn btn-primary' : 'btn btn-secondary';
  renderLiveMetricsAndChart();
}

function setRunHistoryFilter(filter) {
  runHistoryFilter = filter;
  ['All', 'K6', 'Ai'].forEach((k) => {
    const el = document.getElementById(`btnFilterRuns${k}`);
    if (el) el.className = filter === k.toLowerCase() ? 'btn btn-primary' : 'btn btn-secondary';
  });
  renderRunsList(overviewState?.runs || []);
}

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
      ? `Multi-Population (${selectedInjectorIds.size} Injector${selectedInjectorIds.size > 1 ? 's' : ''})`
      : mode === 'direct-k6'
        ? 'Direct k6 Multi-Scenario'
        : 'Node -> k6 -> Node';

  setLiveCounterMode(mode === 'aiperf' ? 'ai' : 'k6');

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
    onSelectProjectWorkspace(false);
  } else {
    onSelectProjectWorkspace(!initialOverviewLoaded);
  }
}

function getSelectedWorkerIds() {
  const workers = overviewState?.workers || [];
  const validIds = Array.from(selectedInjectorIds).filter((id) =>
    workers.some((w) => w.id === id && w.online !== false)
  );
  if (validIds.length === 0 && workers.length > 0) {
    const firstOnline = workers.find((w) => w.online !== false) || workers[0];
    selectedInjectorIds.add(firstOnline.id);
    return [firstOnline.id];
  }
  return validIds.length ? validIds : ['EC2-Worker-01'];
}

function getInjectorDistributionMode() {
  const ids = getSelectedWorkerIds();
  if (ids.length === 1) {
    if (ids[0] === 'EC2-Worker-02') return 'worker-2-only';
    return 'worker-1-only';
  }
  if (ids.length > 2) return 'split-all';
  return 'split-50-50';
}

function renderInjectorCheckboxes(workers = []) {
  const container = document.getElementById('injectorCheckboxesContainer');
  if (!container) return;

  // Ensure at least one online worker is selected
  const validSelected = workers.filter((w) => selectedInjectorIds.has(w.id) && w.online !== false);
  if (validSelected.length === 0 && workers.length > 0) {
    const defaultHost = workers.find((w) => w.isLocalHost && w.online !== false) || workers.find((w) => w.online !== false) || workers[0];
    selectedInjectorIds.clear();
    selectedInjectorIds.add(defaultHost.id);
  }

  container.innerHTML = workers
    .map((w, idx) => {
      const isChecked = selectedInjectorIds.has(w.id) && w.online !== false;
      const isOnline = w.online !== false;
      const addr = String(w.url || '').replace(/^https?:\/\//, '');
      const roleBadge = w.isLocalHost || idx === 0
        ? `<span class="badge badge-info">Web Portal Host (Default)</span>`
        : isOnline
          ? `<span class="badge badge-warn">Injector #${idx + 1} (${esc(w.region || 'remote')})</span>`
          : `<span class="badge badge-fail">Offline</span>`;

      return `
        <label style="display:flex;align-items:center;justify-content:space-between;text-transform:none;color:var(--text-0);padding:6px 8px;border-radius:6px;background:var(--bg-1);border:1px solid ${isChecked ? 'var(--accent)' : 'var(--border)'};margin-bottom:6px;cursor:${isOnline ? 'pointer' : 'not-allowed'};opacity:${isOnline ? '1' : '0.55'};">
          <span style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:12px;">
            <input type="checkbox" class="chk-injector-node" data-worker-id="${esc(w.id)}" ${isChecked ? 'checked' : ''} ${!isOnline ? 'disabled' : ''} style="width:auto;margin:0;" onchange="onToggleInjectorCheckbox('${esc(w.id)}', this.checked)" />
            <span>${esc(w.id)} <code>${esc(addr)}</code></span>
          </span>
          ${roleBadge}
        </label>
      `;
    })
    .join('');

  updateInjectorSelectionUi();
}

function onToggleInjectorCheckbox(workerId, checked) {
  if (checked) {
    selectedInjectorIds.add(workerId);
  } else {
    selectedInjectorIds.delete(workerId);
    if (selectedInjectorIds.size === 0) {
      // Keep at least one injector selected
      selectedInjectorIds.add(workerId);
    }
  }
  syncPopulationsFromDom();
  const mode = getInjectorDistributionMode();
  applyInjectorSelectionToPopulations(mode);
  renderInjectorCheckboxes(overviewState?.workers || []);
  renderPopulationsBuilder();
}

function applyInjectorSelectionToPopulations(mode) {
  const chosenIds = getSelectedWorkerIds();
  const count = Math.max(1, chosenIds.length);
  const evenShare = Number((100 / count).toFixed(2));

  activePopulations.forEach((pop) => {
    pop.injectorWeights = {};
    chosenIds.forEach((id) => {
      pop.injectorWeights[id] = evenShare;
    });
    if (mode === 'worker-1-only') {
      pop.injectorDistribution = 'injector-1';
      pop.injector1Pct = 100;
      pop.injector2Pct = 0;
    } else if (mode === 'worker-2-only') {
      pop.injectorDistribution = 'injector-2';
      pop.injector1Pct = 0;
      pop.injector2Pct = 100;
    } else {
      if (pop.injectorDistribution === 'injector-1' || pop.injectorDistribution === 'injector-2') {
        pop.injectorDistribution = '50-50';
        pop.injector1Pct = evenShare;
        pop.injector2Pct = evenShare;
      }
    }
  });
}

function updateInjectorSelectionUi() {
  const badgeEl = document.getElementById('injectorSelectionBadge');
  const summaryEl = document.getElementById('injectorSelectionSummary');
  const chosenIds = getSelectedWorkerIds();
  const mode = getInjectorDistributionMode();

  const selDirect = document.getElementById('selDirectK6DistMode');
  const selAi = document.getElementById('selDistMode');
  if (selDirect && (mode === 'worker-1-only' || mode === 'worker-2-only' || mode === 'split-50-50')) {
    selDirect.value = mode;
  }
  if (selAi && selAi.value !== 'multi-protocol-http-sse' && (mode === 'worker-1-only' || mode === 'worker-2-only' || mode === 'split-50-50')) {
    selAi.value = mode;
  }

  if (chosenIds.length > 1) {
    if (badgeEl) {
      badgeEl.className = 'badge badge-info';
      badgeEl.textContent = `${chosenIds.length} Injectors (Distributed)`;
    }
    if (summaryEl) {
      summaryEl.innerHTML = `Distributing load across <strong>${chosenIds.length} selected injectors</strong> (<code>${chosenIds.map(esc).join('</code> + <code>')}</code>).`;
    }
  } else if (chosenIds[0] && chosenIds[0] !== 'EC2-Worker-01') {
    if (badgeEl) {
      badgeEl.className = 'badge badge-warn';
      badgeEl.textContent = `1 Injector (${chosenIds[0]})`;
    }
    if (summaryEl) {
      summaryEl.innerHTML = `Running 100% load on injector <code>${esc(chosenIds[0])}</code>.`;
    }
  } else {
    if (badgeEl) {
      badgeEl.className = 'badge badge-pass';
      badgeEl.textContent = '1 Injector (Local Host)';
    }
    if (summaryEl) {
      summaryEl.innerHTML = 'Default: Running 100% load on Web Portal Host (<code>EC2-Worker-01</code>). Check additional injectors above to distribute load.';
    }
  }
}

function syncInjectorCheckboxesFromDropdown(val) {
  const workers = overviewState?.workers || [];
  selectedInjectorIds.clear();
  if (val === 'worker-1-only') {
    selectedInjectorIds.add(workers[0]?.id || 'EC2-Worker-01');
  } else if (val === 'worker-2-only') {
    selectedInjectorIds.add(workers[1]?.id || 'EC2-Worker-02');
  } else {
    workers.filter((w) => w.online !== false).forEach((w) => selectedInjectorIds.add(w.id));
  }
  applyInjectorSelectionToPopulations(getInjectorDistributionMode());
  renderInjectorCheckboxes(workers);
  renderPopulationsBuilder();
}

function setRunActiveState(isActive) {
  const btnStop = document.getElementById('btnStopRun');
  const btnStart = document.getElementById('btnStartRun');
  const btnQuick = document.getElementById('btnQuickRunTop');
  if (btnStop) btnStop.disabled = !isActive;
  if (btnStart) {
    btnStart.disabled = isActive;
    btnStart.innerHTML = isActive ? '&#9203; Running...' : '&#9654; Run';
  }
  if (btnQuick) {
    btnQuick.disabled = isActive;
  }
}

function onSelectProjectWorkspace(resetPops = true) {
  const proj = getSelectedProject();
  if (!proj) return;

  const summaryEl = document.getElementById('projectTreeSummary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div><strong>Files (${proj.fileCount}):</strong> <code>${esc((proj.files || []).map((f) => f.path).join(', '))}</code></div>
      <div style="margin-top:3px;"><strong>Datasets:</strong> <code>${esc((proj.datasets || []).join(', ') || 'none')}</code> ${proj.counterProfile && proj.counterProfile !== 'auto' ? `&bull; <strong>Profile:</strong> <code>${esc(proj.counterProfile)}</code>` : ''}</div>
    `;
  }

  // Respect project.json counterProfile if configured
  if (proj.counterProfile === 'ai' || proj.counterProfile === 'k6') {
    setLiveCounterMode(proj.counterProfile);
  }

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
        injectorDistribution: 'injector-1',
        injector1Pct: 100,
        injector2Pct: 0
      }));
    }
    applyInjectorSelectionToPopulations(getInjectorDistributionMode());
    renderPopulationsBuilder();
  }
}

function syncPopulationsFromDom() {
  const chosenIds = getSelectedWorkerIds();
  const evenShare = Number((100 / Math.max(1, chosenIds.length)).toFixed(2));

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
      pop.injectorWeights = {};
      if (distEl.value === '50-50') {
        pop.injector1Pct = evenShare;
        pop.injector2Pct = evenShare;
        chosenIds.forEach((id) => { pop.injectorWeights[id] = evenShare; });
      } else if (distEl.value === '70-30') {
        pop.injector1Pct = 70;
        pop.injector2Pct = 30;
        if (chosenIds[0]) pop.injectorWeights[chosenIds[0]] = 70;
        if (chosenIds[1]) pop.injectorWeights[chosenIds[1]] = 30;
      } else if (distEl.value === '30-70') {
        pop.injector1Pct = 30;
        pop.injector2Pct = 70;
        if (chosenIds[0]) pop.injectorWeights[chosenIds[0]] = 30;
        if (chosenIds[1]) pop.injectorWeights[chosenIds[1]] = 70;
      } else if (distEl.value === 'injector-1') {
        pop.injector1Pct = 100;
        pop.injector2Pct = 0;
        pop.injectorWeights[chosenIds[0] || 'EC2-Worker-01'] = 100;
      } else if (distEl.value === 'injector-2') {
        pop.injector1Pct = 0;
        pop.injector2Pct = 100;
        pop.injectorWeights[chosenIds[1] || 'EC2-Worker-02'] = 100;
      }
    }
  });
}

function renderPopulationsBuilder() {
  const proj = getSelectedProject();
  const container = document.getElementById('populationsBuilderList');
  if (!proj || !container) return;

  const chosenIds = getSelectedWorkerIds();
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
            <label style="font-size:10px;margin-bottom:2px;">Load Injector Distribution (${chosenIds.map(esc).join(' / ')})</label>
            <select id="popDist_${idx}" style="margin:0;padding:5px 8px;" onchange="syncPopulationsFromDom()">
              <option value="50-50" ${pop.injectorDistribution === '50-50' ? 'selected' : ''}>Balanced Even Split Across Selected Injectors (${chosenIds.length})</option>
              <option value="injector-1" ${pop.injectorDistribution === 'injector-1' ? 'selected' : ''}>100% Dedicated on Injector #1 (Web Portal Host)</option>
              <option value="injector-2" ${pop.injectorDistribution === 'injector-2' ? 'selected' : ''}>100% Dedicated on Injector #2</option>
              <option value="70-30" ${pop.injectorDistribution === '70-30' ? 'selected' : ''}>Weighted 70% Injector #1 / 30% Injector #2</option>
              <option value="30-70" ${pop.injectorDistribution === '30-70' ? 'selected' : ''}>Weighted 30% Injector #1 / 70% Injector #2</option>
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
  const mode = getInjectorDistributionMode();
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
    injectorDistribution: mode === 'worker-1-only' ? 'injector-1' : mode === 'worker-2-only' ? 'injector-2' : '50-50',
    injector1Pct: mode === 'worker-1-only' ? 100 : mode === 'worker-2-only' ? 0 : 50,
    injector2Pct: mode === 'worker-1-only' ? 0 : mode === 'worker-2-only' ? 100 : 50
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
    <label>Generated Composite Multi-Population k6 Entrypoint (Synced to Selected Injectors)</label>
    <pre class="code-pre" style="padding:10px;font-size:11px;">${esc(data.script)}</pre>
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
  } else {
    alert(`Upload failed: ${data.error || 'Unknown error'}`);
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
  const customNames = (info.customMetrics || []).map((m) => `${m.name} (${m.type})`);
  box.innerHTML = `
    <div style="margin-bottom:6px;">${scHtml}</div>
    <div style="font-size:11px;color:var(--text-2);border-top:1px solid var(--border);padding-top:6px;">
      <div><strong>UserFlow Groups:</strong> ${esc((info.groups || []).join(' | ') || 'Default')}</div>
      <div style="margin-top:3px;"><strong>Script Thresholds (Primary Gates):</strong> <code>${esc(thKeys.join(', ') || 'None')}</code></div>
      ${customNames.length ? `<div style="margin-top:3px;"><strong>Custom Metrics:</strong> <code>${esc(customNames.join(', '))}</code></div>` : ''}
    </div>
  `;
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
  const fwInput = document.getElementById('inpFrameworkRoot');
  if (fwInput && document.activeElement !== fwInput) {
    fwInput.value = overviewState.frameworkRoot || '';
  }

  const engBadge = document.getElementById('engineStatusBadge');
  if (engBadge) {
    if (overviewState.k6Binary?.available) {
      engBadge.className = 'badge badge-pass';
      engBadge.textContent = `Native k6 CLI (${overviewState.k6Binary.version})`;
    } else {
      engBadge.className = 'badge badge-info';
      engBadge.textContent = 'Measured Node HTTP Engine';
    }
  }

  if (overviewState.workers?.[0]) {
    const w1In = document.getElementById('inpWorker1Url');
    if (w1In && document.activeElement !== w1In) w1In.value = overviewState.workers[0].url;
  }
  if (overviewState.workers?.[1]) {
    const w2In = document.getElementById('inpWorker2Url');
    if (w2In && document.activeElement !== w2In) w2In.value = overviewState.workers[1].url;
  }

  renderHeaderCluster(overviewState.workers, overviewState.mockAgent);
  renderInjectorCheckboxes(overviewState.workers);
  renderWarroomWorkerCards(overviewState.workers);
  renderProjectWorkspaces(overviewState.projects || []);
  renderRunsList(overviewState.runs);
  populateCompareSelectors(overviewState.runs);
  renderStudioFileList(overviewState.files);
  initialOverviewLoaded = true;

  if (overviewState.activePipeline) {
    const p = overviewState.activePipeline;
    const isRunActive = p.stage === 'stage1_preflight' || p.stage === 'stage2_k6_distributed' || p.stage === 'stage3_postprocess';
    setRunActiveState(isRunActive);
    if (p.rows?.length && liveRows.length === 0) {
      liveRows = p.rows;
      updatePipelineStepper(p);
      renderLiveMetricsAndChart();
      renderLiveRowsTable();
    } else {
      updatePipelineStepper(p);
      renderLiveChart(liveRows);
    }
  } else {
    setRunActiveState(false);
    renderLiveChart(liveRows);
  }
}

// Lightweight background poll that only updates header pills & worker telemetry cards without touching user form inputs
async function refreshClusterHealthOnly() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    overviewState = data;
    document.getElementById('runCountBadge').textContent = data.runs.length;
    renderHeaderCluster(data.workers, data.mockAgent);
    renderWarroomWorkerCards(data.workers);
  } catch (_) {}
}

function renderHeaderCluster(workers = [], mockAgent = {}) {
  const pillsContainer = document.getElementById('dynamicWorkerPills');
  if (pillsContainer) {
    pillsContainer.innerHTML = workers
      .map((w) => {
        const h = w.health || {};
        const isOnline = w.online !== false;
        const isBusy = h.status === 'running';
        const dotClass = !isOnline ? 'dot offline' : isBusy ? 'dot busy' : 'dot';
        const text = !isOnline
          ? `${w.id}: Offline`
          : isBusy
            ? `${w.id}: Running (${h.activeVus} VUs | CPU ${h.cpuPct ?? 'n/a'}%)`
            : `${w.id}: Online (CPU ${h.cpuPct ?? 'n/a'}%)`;
        return `<div class="pill"><span class="${dotClass}"></span><span>${esc(text)}</span></div>`;
      })
      .join('');
  }

  const mockEl = document.getElementById('pillMockAgent');
  if (mockEl) {
    mockEl.textContent = `Target AI Agent (:8089): ${mockAgent.status === 'ok' ? `Ready (${mockAgent.totalRequests || 0} reqs)` : 'Online'}`;
  }
}

function renderWarroomWorkerCards(workers = []) {
  const container = document.getElementById('warroomWorkerCards');
  if (!container) return;
  const chosenIds = getSelectedWorkerIds();

  container.innerHTML = workers
    .map((w) => {
      const h = w.health || {};
      const isOnline = w.online !== false;
      const isBusy = h.status === 'running';
      const isSelected = chosenIds.includes(w.id);
      const chosenIdx = chosenIds.indexOf(w.id);
      const sharePct = isSelected ? Math.round(100 / Math.max(1, chosenIds.length)) : 0;
      const segLabel = isSelected
        ? `${sharePct}% Share (${chosenIdx + 1}/${chosenIds.length})`
        : 'Standby (Unchecked)';

      return `
        <div style="background:var(--bg-2);border:1px solid ${isBusy ? 'var(--accent)' : isSelected ? 'var(--indigo)' : 'var(--border)'};border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong>${esc(w.id)}</strong> <span style="color:var(--text-2);font-size:11px;">(${esc(w.privateIp)} &bull; ${esc(w.region)})</span>
            </div>
            <span class="badge ${!isOnline ? 'badge-fail' : isBusy ? 'badge-warn' : isSelected ? 'badge-pass' : 'badge-info'}">
              ${!isOnline ? 'OFFLINE' : isBusy ? `ACTIVE (${h.activeVus} VUs)` : isSelected ? 'SELECTED' : 'STANDBY'}
            </span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:9px;font-size:11.5px;color:var(--text-1);">
            <div>Allocation: <code>${esc(segLabel)}</code></div>
            <div>OS CPU / Mem: <strong>${h.cpuPct != null ? h.cpuPct + '%' : 'n/a'} / ${h.memPct != null ? h.memPct + '%' : 'n/a'}</strong></div>
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

  const injectorDistMode = getInjectorDistributionMode();
  const chosenWorkerIds = getSelectedWorkerIds();

  let payload;
  if (currentExecMode === 'multi-population') {
    syncPopulationsFromDom();
    applyInjectorSelectionToPopulations(injectorDistMode);
    const proj = getSelectedProject();
    payload = {
      mode: 'multi-population',
      runId: document.getElementById('inpRunId').value.trim() || `MULTIPOP_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
      projectId: proj?.id || 'enterprise-omni-framework',
      populations: activePopulations,
      distributionMode: injectorDistMode,
      selectedWorkerIds: chosenWorkerIds,
      counterProfile: proj?.counterProfile && proj.counterProfile !== 'auto' ? proj.counterProfile : null,
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
      distributionMode: injectorDistMode,
      selectedWorkerIds: chosenWorkerIds,
      durationOverride: document.getElementById('inpDirectK6Duration').value.trim() || '6s',
      envVars,
      configRel: 'config/default.json',
      gatesRel: 'config/gates.json',
      skipPreflight: true
    };
  } else {
    const aiDistSel = document.getElementById('selDistMode').value;
    payload = {
      mode: 'aiperf',
      runId: document.getElementById('inpRunId').value.trim() || `PP_DIST_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
      workload: document.getElementById('selWorkload').value,
      distributionMode: aiDistSel === 'multi-protocol-http-sse' && chosenWorkerIds.length >= 2 ? 'multi-protocol-http-sse' : injectorDistMode,
      selectedWorkerIds: chosenWorkerIds,
      configRel: document.getElementById('selConfig').value,
      gatesRel: document.getElementById('selGates').value,
      levelsStr: document.getElementById('inpLevels').value.trim() || '2,6',
      holdStr: document.getElementById('inpHold').value.trim() || '5s',
      datasetsOverride: document.getElementById('selDataset').value || null,
      baselineRunId: document.getElementById('selBaselineRun').value || '',
      skipPreflight: document.getElementById('chkSkipPreflight').checked
    };
  }

  setRunActiveState(true);

  const res = await fetch('/api/runs/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) {
    setRunActiveState(false);
    alert(data.error || 'Could not start run');
  }
}

async function stopActiveRun() {
  await fetch('/api/runs/stop', { method: 'POST' });
  setRunActiveState(false);
}

function updatePipelineStepper(p) {
  const s1 = document.getElementById('stepStage1');
  const s2 = document.getElementById('stepStage2');
  const s3 = document.getElementById('stepStage3');
  const badge = document.getElementById('liveRunBadge');

  [s1, s2, s3].forEach((el) => (el.className = 'step-box'));

  if (!p) {
    setRunActiveState(false);
    return;
  }
  badge.textContent = `${p.runId} (${p.stage})`;

  const isRunning = p.stage === 'stage1_preflight' || p.stage === 'stage2_k6_distributed' || p.stage === 'stage3_postprocess';
  setRunActiveState(isRunning);

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
  } else if (p.stage === 'stopped') {
    badge.className = 'badge badge-warn';
    badge.textContent = `${p.runId} — ABORTED`;
  } else if (p.stage === 'failed') {
    badge.className = 'badge badge-fail';
    badge.textContent = `${p.runId} — FAILED`;
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
  const workerCounts = {};
  for (const r of liveRows) {
    const w = r.worker_id || 'EC2-Worker-01';
    workerCounts[w] = (workerCounts[w] || 0) + 1;
  }
  const splitStr = Object.entries(workerCounts)
    .map(([k, v]) => `${k.replace('EC2-Worker-', 'W')}: ${v}`)
    .join(' | ');

  const lbl1 = document.getElementById('lblCounter1');
  const lbl2 = document.getElementById('lblCounter2');
  const lbl3 = document.getElementById('lblCounter3');
  const lbl4 = document.getElementById('lblCounter4');
  const hdrTitle = document.getElementById('liveCountersHeaderTitle');

  if (liveCounterMode === 'k6') {
    if (hdrTitle) hdrTitle.textContent = '⚡ Standard k6 Result Counters (http_req_duration, iterations, checks, data_received, Measured OS CPU/Mem)';
    if (lbl1) lbl1.textContent = 'HTTP_REQS & ITERATIONS';
    if (lbl2) lbl2.textContent = 'HTTP_REQ_DURATION (P95 / MED / SAMPLE STDDEV)';
    if (lbl3) lbl3.textContent = 'CHECKS & HTTP_REQ_FAILED';
    if (lbl4) lbl4.textContent = 'MEASURED DATA I/O & OS GAUGES';
  } else {
    if (hdrTitle) hdrTitle.textContent = '🤖 AI Agent Result Counters (agent_e2e_duration, Measured Streaming TTFT, Correctness, Groundedness)';
    if (lbl1) lbl1.textContent = 'COMPLETED AI TURNS (`rows.jsonl`)';
    if (lbl2) lbl2.textContent = 'AGENT E2E LATENCY (P95) & TTFT';
    if (lbl3) lbl3.textContent = 'COMPLETION & DETERMINISTIC PASS %';
    if (lbl4) lbl4.textContent = 'LEXICAL CORRECTNESS & GROUNDEDNESS';
  }

  document.getElementById('liveTotalRows').textContent = liveCounterMode === 'k6' ? `${n} reqs` : n;
  document.getElementById('liveWorkerSplitSub').textContent = n ? `Iters: ${n} | ${splitStr}` : 'Waiting for turns...';

  if (n === 0) {
    document.getElementById('liveE2eP95').textContent = '-- ms';
    document.getElementById('liveTtftSub').textContent = liveCounterMode === 'k6' ? 'Med: -- ms | StdDev: -- ms' : 'TTFT avg: -- ms';
    document.getElementById('livePassRate').textContent = '--%';
    document.getElementById('liveQualityScore').textContent = '--';
    renderLiveChart([]);
    return;
  }

  const e2es = liveRows.map((r) => Number(r.e2e_ms || 0)).sort((a, b) => a - b);
  const p95Idx = Math.min(e2es.length - 1, Math.max(0, Math.ceil(0.95 * e2es.length) - 1));
  const medIdx = Math.min(e2es.length - 1, Math.max(0, Math.ceil(0.5 * e2es.length) - 1));
  const p95 = e2es[p95Idx];
  const median = e2es[medIdx];
  const avgE2e = Math.round(e2es.reduce((a, b) => a + b, 0) / n);
  // Sample standard deviation (n - 1)
  const variance = n > 1 ? e2es.reduce((s, v) => s + Math.pow(v - avgE2e, 2), 0) / (n - 1) : 0;
  const stdev = Math.round(Math.sqrt(variance));

  const ttfts = liveRows.map((r) => Number(r.ttft_ms || 0)).filter((v) => v > 0);
  const avgTtft = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;

  const detPass = liveRows.filter((r) => r.det_pass).length;
  const compPass = liveRows.filter((r) => r.completion_status === 'completed').length;
  const httpFails = liveRows.filter((r) => Number(r.http_status ?? 200) >= 400 || Number(r.http_status) === 0).length;

  if (liveCounterMode === 'k6') {
    const rcvBytes = liveRows.filter((r) => r.res_bytes != null).reduce((s, r) => s + Number(r.res_bytes || 0), 0);
    const sntBytes = liveRows.filter((r) => r.req_bytes != null).reduce((s, r) => s + Number(r.req_bytes || 0), 0);
    const dataRcvText = rcvBytes > 0 ? `${(rcvBytes / 1024).toFixed(1)} KB` : 'n/a';
    const dataSentText = sntBytes > 0 ? `${(sntBytes / 1024).toFixed(1)} KB` : 'n/a';

    const lastRes = liveRows[liveRows.length - 1]?.host_resources;
    const cpuTxt = lastRes?.cpuPct != null ? `${lastRes.cpuPct}%` : 'n/a';
    const memTxt = lastRes?.memPct != null ? `${lastRes.memPct}%` : 'n/a';
    const fhTxt = lastRes?.fileHandles != null ? lastRes.fileHandles : 'n/a';

    document.getElementById('liveE2eP95').textContent = `${p95} ms`;
    document.getElementById('liveTtftSub').textContent = `Median: ${median} ms | Mean: ${avgE2e} ms | StdDev (n-1): ${stdev} ms`;
    document.getElementById('livePassRate').textContent = `${((detPass / n) * 100).toFixed(1)}% (${detPass}/${n})`;
    document.getElementById('liveErrorSub').textContent = `http_req_failed: ${((httpFails / n) * 100).toFixed(2)}% (${httpFails} fails)`;
    document.getElementById('liveQualityScore').textContent = `${dataRcvText} / ${dataSentText}`;
    document.getElementById('liveStageTimingSub').textContent = `OS CPU: ${cpuTxt} | Mem: ${memTxt} | Handles: ${fhTxt}`;
  } else {
    const avgCorr = (liveRows.reduce((s, r) => s + Number(r.correctness ?? 0), 0) / n).toFixed(2);
    const avgGrnd = (liveRows.reduce((s, r) => s + Number(r.groundedness ?? 0), 0) / n).toFixed(2);
    document.getElementById('liveE2eP95').textContent = `${p95} ms`;
    document.getElementById('liveTtftSub').textContent = `E2E avg: ${avgE2e} ms | TTFT avg: ${avgTtft != null ? avgTtft + ' ms' : 'n/a'}`;
    document.getElementById('livePassRate').textContent = `${((compPass / n) * 100).toFixed(0)}% / ${((detPass / n) * 100).toFixed(0)}%`;
    document.getElementById('liveErrorSub').textContent = `Completion vs Deterministic Pass`;
    document.getElementById('liveQualityScore').textContent = `${avgCorr} / ${avgGrnd}`;
    document.getElementById('liveStageTimingSub').textContent = `Correctness vs Groundedness`;
  }

  renderLiveChart(liveRows);
}

function renderLiveChart(rows) {
  const container = document.getElementById('liveChartContainer');
  if (!container) return;
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-2);border:1px dashed var(--border);border-radius:8px;">Waiting for live telemetry from selected Load Injectors...</div>`;
    return;
  }

  // Plot across full run duration using real timestamps on X-axis (no 60-row cutoff)
  const pts = rows;
  const w = 1120;
  const h = 205;
  const padL = 50;
  const padR = 20;
  const padT = 22;
  const padB = 26;
  const maxVal = Math.max(500, ...pts.map((r) => Number(r.e2e_ms || 0))) * 1.12;

  const tsArr = pts.map((r, i) => {
    const t = new Date(r.ts).getTime();
    return Number.isFinite(t) ? t : i * 500;
  });
  const minTs = Math.min(...tsArr);
  const maxTs = Math.max(...tsArr);
  const spanMs = Math.max(1000, maxTs - minTs);

  const xFor = (i) =>
    pts.length === 1
      ? padL + (w - padL - padR) / 2
      : padL + ((tsArr[i] - minTs) / spanMs) * (w - padL - padR);
  const yFor = (val) => padT + (1 - Math.min(1, val / maxVal)) * (h - padT - padB);

  const e2ePoly = pts.map((r, i) => `${xFor(i).toFixed(1)},${yFor(r.e2e_ms || 0).toFixed(1)}`).join(' ');
  const ttftPts = pts.filter((r) => r.ttft_ms != null);
  const ttftPoly = ttftPts.length
    ? pts.map((r, i) => `${xFor(i).toFixed(1)},${yFor(r.ttft_ms || 0).toFixed(1)}`).join(' ')
    : '';

  const palette = ['#f97316', '#0891b2', '#8b5cf6', '#ec4899'];
  const workerList = Array.from(new Set(pts.map((r) => r.worker_id || 'EC2-Worker-01')));

  const circles = pts
    .map((r, i) => {
      const wIdx = Math.max(0, workerList.indexOf(r.worker_id || 'EC2-Worker-01'));
      const color = palette[wIdx % palette.length];
      return `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(r.e2e_ms || 0).toFixed(1)}" r="3.5" fill="${color}" />`;
    })
    .join('');

  const totalSec = Math.round(spanMs / 1000);

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%;overflow:visible;">
      <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${(padT + h - padB) / 2}" x2="${w - padR}" y2="${(padT + h - padB) / 2}" stroke="var(--chart-grid)" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--chart-axis)" />
      <text x="6" y="${padT + 4}" fill="var(--chart-text)" font-size="10">${Math.round(maxVal)}ms</text>
      <text x="6" y="${(padT + h - padB) / 2 + 4}" fill="var(--chart-text)" font-size="10">${Math.round(maxVal / 2)}ms</text>
      <text x="6" y="${h - padB}" fill="var(--chart-text)" font-size="10">0ms</text>

      <text x="${padL}" y="${h - 6}" fill="var(--chart-text)" font-size="10">+0s</text>
      <text x="${(padL + w - padR) / 2}" y="${h - 6}" fill="var(--chart-text)" font-size="10">+${Math.round(totalSec / 2)}s</text>
      <text x="${w - padR - 28}" y="${h - 6}" fill="var(--chart-text)" font-size="10">+${totalSec}s (${pts.length} pts)</text>

      <polyline fill="none" stroke="#f97316" stroke-width="2.3" points="${e2ePoly}" />
      ${ttftPoly ? `<polyline fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="4,3" points="${ttftPoly}" />` : ''}
      ${circles}

      <g transform="translate(${padL + 10}, 5)">
        <rect x="0" y="0" width="10" height="10" fill="#f97316" rx="2" />
        <text x="14" y="9" fill="var(--text-1)" font-size="11" font-weight="600">E2E / HTTP Duration (ms)</text>
        <rect x="195" y="0" width="10" height="10" fill="#10b981" rx="2" />
        <text x="209" y="9" fill="var(--text-1)" font-size="11" font-weight="600">Measured TTFT / Waiting (ms)</text>
      </g>
    </svg>
  `;
}

function renderLiveRowsTable() {
  const tbody = document.getElementById('liveRowsTbody');
  if (!tbody || !liveRows.length) return;

  const startIdx = Math.max(0, liveRows.length - 40);
  const recentSlice = liveRows.slice(startIdx).reverse();

  tbody.innerHTML = recentSlice
    .map((r, revOffset) => {
      const actualIdx = liveRows.length - 1 - revOffset;
      const isW1 = String(r.worker_id).includes('01');
      const st = r.server_timing || {};
      const timingText = st.planning_ms != null ? `${st.planning_ms} / ${st.tools_ms} / ${st.synthesis_ms} ms` : 'n/a';
      return `
        <tr style="cursor:pointer;" onclick="inspectLiveTurnByIndex(${actualIdx})">
          <td><span class="badge ${isW1 ? 'badge-warn' : 'badge-info'}">${esc(r.worker_id)}</span></td>
          <td><strong>${r.load_level} VUs</strong></td>
          <td><code>${esc(r.prompt_id)}</code></td>
          <td>${esc(r.category)}</td>
          <td><span class="badge ${r.http_status === 200 ? 'badge-pass' : 'badge-fail'}">${esc(r.completion_status)} (${r.http_status})</span></td>
          <td>${r.ttft_ms != null ? r.ttft_ms + ' ms' : 'n/a'}</td>
          <td><strong>${r.e2e_ms} ms</strong></td>
          <td style="color:var(--text-2);font-size:11px;">${timingText}</td>
          <td><span class="badge ${r.det_pass ? 'badge-pass' : 'badge-fail'}">${r.det_pass ? 'PASS' : 'FAIL'}</span></td>
          <td>${Number(r.correctness ?? 0).toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');
}

function inspectLiveTurnByIndex(idx) {
  const row = liveRows[idx];
  if (row) inspectTurnRow(row);
}

function inspectTurnRow(row) {
  const modal = document.getElementById('turnModal');
  modal.classList.remove('hidden');
  document.getElementById('modalTurnTitle').textContent = `Turn Inspector — ${row.prompt_id} (${row.worker_id} | Trace: ${row.trace_id})`;
  const st = row.server_timing || {};
  document.getElementById('modalTurnBody').innerHTML = `
    <div class="grid-3" style="margin-bottom:12px;">
      <div class="stat-card">
        <div class="stat-label">Injector &amp; Segment</div>
        <div style="font-weight:700;margin-top:4px;">${esc(row.worker_id)} (<code>${esc(row.execution_segment || '0:1')}</code>)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">E2E / TTFT Latency</div>
        <div style="font-weight:700;margin-top:4px;">${row.e2e_ms} ms / ${row.ttft_ms != null ? row.ttft_ms + ' ms' : 'n/a'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Server Stage Timings</div>
        <div style="font-weight:700;margin-top:4px;">Plan: ${st.planning_ms ?? 'n/a'}ms | Tools: ${st.tools_ms ?? 'n/a'}ms | Synth: ${st.synthesis_ms ?? 'n/a'}ms</div>
      </div>
    </div>
    <label>Response Payload / AI Agent Answer (<code>response.answerPath</code>)</label>
    <div style="background:var(--bg-0);border:1px solid var(--border);padding:12px;border-radius:6px;margin-bottom:12px;color:var(--text-0);">${esc(row.answer || '(Empty response)')}</div>
    <label>Retrieved RAG Contexts / Flow Metadata (<code>response.contextsPath</code>)</label>
    <div style="background:var(--bg-0);border:1px solid var(--border);padding:12px;border-radius:6px;margin-bottom:12px;color:var(--text-1);">${esc((row.contexts || []).join('\n') || 'None')}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-2);">
      <div>Measured Bytes (Sent/Rcv): <strong>${row.req_bytes ?? 'n/a'} B / ${row.res_bytes ?? 'n/a'} B</strong></div>
      <div>Tool Calls: <code>${esc((row.tool_calls || []).join(', ') || 'none')}</code></div>
      <div>Agent Steps: <strong>${row.steps ?? 1}</strong></div>
      <div>Tokens (In/Out): <strong>${row.prompt_tokens ?? 0} / ${row.completion_tokens ?? 0}</strong> ($${row.est_cost ?? 0})</div>
      <div>Variables: <code>${esc(JSON.stringify(row.vars || {}))}</code></div>
    </div>
  `;
}

function closeTurnModal() {
  document.getElementById('turnModal').classList.add('hidden');
}

async function deleteRunById(runId, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm(`Delete test run "${runId}" and its artifacts?`)) return;
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) {
    if (selectedRunId === runId) selectedRunId = null;
    await loadOverview();
    if (overviewState?.runs?.length && !selectedRunId) {
      selectRunDetail(overviewState.runs[0].run_id);
    }
  }
}

function renderRunsList(runs = []) {
  const container = document.getElementById('runsListContainer');
  if (!container) return;
  const filteredRuns = runs.filter((r) => {
    const rType = r.run_type || (String(r.workload || '').startsWith('k6:') ? 'k6' : 'ai');
    if (runHistoryFilter === 'k6') return rType === 'k6';
    if (runHistoryFilter === 'ai') return rType === 'ai';
    return true;
  });

  if (!filteredRuns.length) {
    container.innerHTML = `<div style="color:var(--text-2);">No matching runs found.</div>`;
    return;
  }

  container.innerHTML = filteredRuns
    .map((r) => {
      const isSelected = r.run_id === selectedRunId;
      const rType = r.run_type || (String(r.workload || '').startsWith('k6:') ? 'k6' : 'ai');
      const typeBadge = rType === 'k6'
        ? '<span class="badge badge-warn">&#9889; k6 HTTP</span>'
        : '<span class="badge badge-info">&#129302; AI Run</span>';

      const grpP95 = r.k6_counters?.group_duration_p95_ms ?? r.overall?.e2e_p95_ms ?? 'n/a';
      const subMetricText = rType === 'k6'
        ? `Iterations: <strong>${r.rows}</strong> &bull; Group p95: <strong>${grpP95} ms</strong>`
        : `Correctness: <strong>${(r.overall?.correctness_avg ?? 0).toFixed(2)}</strong> &bull; Max QDUL: <strong>${r.overall?.qdul_pct_max ?? 0}%</strong>`;

      const statusBadge = r.status === 'ABORTED' || r.gate?.aborted
        ? '<span class="badge badge-warn">ABORTED</span>'
        : `<span class="badge ${r.gate?.passed ? 'badge-pass' : 'badge-fail'}">${r.gate?.passed ? 'PASSED' : 'FAILED'}</span>`;

      return `
        <div onclick="selectRunDetail('${esc(r.run_id)}')" style="cursor:pointer;background:${isSelected ? 'var(--bg-3)' : 'var(--bg-2)'};border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              ${typeBadge}
              <strong>${esc(r.run_id)}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:5px;">
              ${statusBadge}
              <button class="btn btn-danger" style="padding:2px 6px;font-size:10px;" title="Delete run" onclick="deleteRunById('${esc(r.run_id)}', event)">&#128465;</button>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-2);margin-top:5px;">
            Workload: <code>${esc(r.workload)}</code> &bull; Reqs: <strong>${r.rows}</strong> &bull; p95: <strong>${r.overall?.e2e_p95_ms ?? 0} ms</strong>
          </div>
          <div style="font-size:11px;color:var(--text-2);margin-top:4px;">
            ${subMetricText}
          </div>
        </div>
      `;
    })
    .join('');
}

async function reprocessRun(runId) {
  const gatesRel = document.getElementById('selGates')?.value || 'config/gates.perfpilot.json';
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
  if (!refSel || !candSel || !runs.length) return;

  const prevRef = refSel.value;
  const prevCand = candSel.value;
  const opts = runs.map((r) => `<option value="${esc(r.run_id)}">${esc(r.run_id)} (${esc(r.workload)} - p95: ${r.overall?.e2e_p95_ms}ms)</option>`).join('');
  refSel.innerHTML = opts;
  candSel.innerHTML = opts;
  if (prevRef && runs.some((r) => r.run_id === prevRef)) refSel.value = prevRef;
  else if (runs.length > 1) refSel.value = runs[runs.length - 1].run_id;

  if (prevCand && runs.some((r) => r.run_id === prevCand)) candSel.value = prevCand;
  else if (runs.length > 0) candSel.value = runs[0].run_id;
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

  const scenRows = (data.scenario_deltas || [])
    .map(
      (s) => `
      <tr>
        <td><code>${esc(s.scenario)}</code></td>
        <td>${s.ref_n} &rarr; ${s.cand_n}</td>
        <td>${s.ref_p95_ms} ms &rarr; <strong>${s.cand_p95_ms} ms</strong></td>
        <td><code>${s.p95_delta_pct > 0 ? '+' : ''}${s.p95_delta_pct}%</code></td>
        <td>${s.ref_pass_pct}% &rarr; <strong>${s.cand_pass_pct}%</strong> (${s.pass_delta_pts > 0 ? '+' : ''}${s.pass_delta_pts} pp)</td>
        <td><span class="badge ${s.verdict === 'REGRESSION' ? 'badge-fail' : s.verdict === 'IMPROVED' ? 'badge-pass' : 'badge-info'}">${esc(s.verdict)}</span></td>
      </tr>`
    )
    .join('');

  const trendRows = (data.baseline_trend || [])
    .map(
      (t) => `
      <tr>
        <td><strong><code>${esc(t.run_id)}</code></strong></td>
        <td><span class="badge ${t.run_type === 'k6' ? 'badge-warn' : 'badge-info'}">${esc(t.run_type)}</span></td>
        <td>${t.rows}</td>
        <td><strong>${t.e2e_p95_ms} ms</strong></td>
        <td>${t.e2e_avg_ms} ms</td>
        <td>${t.det_pass_rate}%</td>
        <td><span class="badge ${t.gate_passed ? 'badge-pass' : 'badge-fail'}">${t.gate_passed ? 'PASS' : 'FAIL'}</span></td>
      </tr>`
    )
    .join('');

  document.getElementById('compareResultContainer').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>Overall Comparison: <code>${esc(data.reference_run)}</code> vs <code>${esc(data.candidate_run)}</code></strong>
      <span class="badge ${data.passed ? 'badge-pass' : 'badge-fail'}">${data.passed ? 'NO SIGNIFICANT REGRESSION (Exit 0)' : 'REGRESSION DETECTED (Exit 1)'}</span>
    </div>
    <table style="margin-bottom:18px;">
      <thead><tr><th>Metric</th><th>Reference Run</th><th>Candidate Run</th><th>Delta</th><th>Statistical Verdict</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${
      scenRows
        ? `<h4 style="margin:14px 0 8px;">Per-Scenario / Per-Category Breakdown Comparison</h4>
           <table style="margin-bottom:18px;">
             <thead><tr><th>Scenario / Category</th><th>Requests (Ref &rarr; Cand)</th><th>P95 Latency</th><th>P95 Delta</th><th>Check Pass Rate</th><th>Verdict</th></tr></thead>
             <tbody>${scenRows}</tbody>
           </table>`
        : ''
    }

    ${
      trendRows
        ? `<h4 style="margin:14px 0 8px;">Multi-Run Historical Trend Across Workspace</h4>
           <table>
             <thead><tr><th>Run ID</th><th>Type</th><th>Requests</th><th>Latency P95</th><th>Mean Latency</th><th>Check Pass %</th><th>Gates</th></tr></thead>
             <tbody>${trendRows}</tbody>
           </table>`
        : ''
    }
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
  if (!container) return;
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

  const workers = [...(overviewState?.workers || [])];
  if (workers[0]) workers[0].url = w1Url;
  if (workers[1]) workers[1].url = w2Url;

  await fetch('/api/cluster/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frameworkRoot, workers })
  });
  await loadOverview();
  alert('Updated Load Injector Cluster & Framework settings!');
}

async function registerAdditionalInjector() {
  const id = document.getElementById('inpNewWorkerId').value.trim() || `EC2-Worker-0${(overviewState?.workers?.length || 2) + 1}`;
  const region = document.getElementById('inpNewWorkerRegion').value.trim() || 'ap-south-1c';
  const url = document.getElementById('inpNewWorkerUrl').value.trim() || `http://127.0.0.1:${4100 + (overviewState?.workers?.length || 2) + 1}`;
  const privateIp = document.getElementById('inpNewWorkerIp').value.trim() || '127.0.0.1';
  const spawnLocal = document.getElementById('chkSpawnLocalWorker').checked;

  const res = await fetch('/api/cluster/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, region, url, privateIp, spawnLocal })
  });
  const data = await res.json();
  if (data.ok) {
    selectedInjectorIds.add(id);
    await loadOverview();
    const nextNum = (overviewState?.workers?.length || 3) + 1;
    document.getElementById('inpNewWorkerId').value = `EC2-Worker-0${nextNum}`;
    document.getElementById('inpNewWorkerUrl').value = `http://127.0.0.1:${4100 + nextNum}`;
    alert(`Registered Load Injector "${id}" (${url})! It is now available in the War Room launcher.`);
  }
}

function connectLiveSse() {
  const es = new EventSource('/api/stream');
  es.addEventListener('pipeline_state', (e) => {
    const p = JSON.parse(e.data);
    updatePipelineStepper(p);
  });
  es.addEventListener('worker_status', () => {
    refreshClusterHealthOnly();
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
  applyTheme(currentTheme);
  loadOverview();
  connectLiveSse();
  // Lightweight health refresh every 8s (never overwrites active user inputs)
  setInterval(refreshClusterHealthOnly, 8000);
});
