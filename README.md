# AIPerf Cloud Orchestrator — Distributed k6 & AI Agent Performance Portal

A self-hosted, zero-dependency **Grafana Cloud k6 + NeoLoad Web-style Load Orchestration Portal** designed for executing, monitoring, comparing, and exporting both **Standard k6 Multi-Scenario / Multi-Population Load Tests** and **AI Agent Performance Pipelines (`Node → k6 → Node`)** across a local Web Portal host and remote EC2 load injectors.

---

## 1. Key Capabilities

### Three Execution Engines in One Portal
1. **📦 Multi-Population Project Mode (`population-orchestrator.mjs`)**
   * Upload or select a complete multi-file k6 framework project (`flows/`, `lib/`, `data/`, `config/`, `project.json`).
   * Automatically discovers exported user-flow functions (`export function ...`) and CSV/JSON datasets.
   * Build **Populations** (e.g., `POP_RETAIL_BUYERS`, `POP_CHECKOUT_TX`, `POP_AI_ASSISTANT_SSE`, `POP_AUTH_SPIKE`) with independent VU counts, durations, dataset bindings, and load injector splits.
   * Dynamically generates and syncs a composite `options.scenarios` k6 bundle to each selected load injector.
2. **🤖 AI Agent Pipeline Mode (`Node → k6 → Node` / `aiperf.mjs`)**
   * **Stage 1 (Node Pre-Hook):** Runs `doctor` preflight probe against target endpoint, validates JSON/SSE answer paths, and writes `run-meta.json`.
   * **Stage 2 (Distributed k6):** Executes `smoke`, `baseline`, `plateaus`, `load`, `stress`, or `spike` workloads across selected injectors, streaming turn-level `rows.jsonl`.
   * **Stage 3 (Node Post-Hook):** Runs cleanup, lexical correctness & groundedness evaluation (`evals.jsonl`), statistical aggregation (`95% CI` + `QDUL %` Quality Drop Under Load), release gates (`gates.json`), and standalone `report.html`.
3. **⚡ Direct Single `.js` Script Mode (`direct-k6-runner.mjs`)**
   * Point directly to any k6 `.js` script containing `export const options = { scenarios: { ... }, thresholds: { ... } }`.
   * Parses scenarios, `group()` blocks, `check()` assertions, and `thresholds` automatically and lets you toggle which scenarios to trigger.

---

### Target Load Injector Selection (Checkboxes)
* **Default Selection:** Only **`EC2-Worker-01` (Web Portal Host — `127.0.0.1:4101`)** is checked by default so 100% of the test runs on the machine hosting the portal out of the box.
* **Multi-Injector Distribution:** Check **`EC2-Worker-02` (`10.24.2.102:4102`)** (or additional injectors) to automatically distribute load across all checked injectors using `--execution-segment` (`0:0.5` and `0.5:1`) or per-population percentage weights (`50/50`, `70/30`, `30/70`, `100/0`).
* **Run / Stop Controls:** Single **`▶ Run`** button to launch tests; **`■ Stop`** is disabled by default and only enables while a test run is actively executing.

---

### Separate Result Counter Profiles (`⚡ Normal k6` vs. `🤖 AI Agent`)
Because standard HTTP/microservice k6 runs and AI Agent LLM/RAG runs produce different telemetry, the portal provides separate, auto-detected (and manually toggleable) counter profiles in both the **Live War Room** and the **Run Inspector**:

| Counter Profile | Primary KPI Counters Displayed |
| :--- | :--- |
| **⚡ Normal k6 Counters** (`run_type: 'k6'`) | 1. **`http_reqs` & Throughput** (`reqs`, avg `reqs/s`, peak VUs)<br>2. **`iterations` & `iteration_duration`** (total iterations, iteration P95 ms)<br>3. **`http_req_duration`** (`P95`, `median`, `mean`, `stdev` ms)<br>4. **`http_req_failed`** (`nz_count` failed requests & failure rate `%`)<br>5. **`group_duration`** (`::UserFlow` group P95 / max ms)<br>6. **`checks` Pass Rate** (`nz_count / count` assertion pass `%`)<br>7. **Network I/O** (`data_received` KB / `data_sent` KB)<br>8. **Load Generator Gauges** (`cpu_percent`, `memory_used_percent`, `file_handles`) |
| **🤖 AI Agent Counters** (`run_type: 'ai'`) | 1. **AI Turns & Prompt Throughput** (`turns`, `turns/s`, peak VUs)<br>2. **Agent E2E Latency** (`e2e_ms` P95, median P50, P99)<br>3. **Time to First Token (`TTFT`)** (`ttft_ms` P95 / P50 for SSE streaming)<br>4. **Completion & Deterministic Pass `%`** (`completion_rate`, `deterministic_pass_rate`)<br>5. **Lexical Correctness & Groundedness** (`0.00 – 1.00` scores)<br>6. **Quality Drop Under Load (`QDUL %`)** (degradation vs. baseline concurrency)<br>7. **Agent Stage P95 (`Server-Timing`)** (`planning_ms`, `tools_ms`, `synthesis_ms`)<br>8. **Capacity SLO Ceiling** (`max_passing_load_level`) |

---

### Grafana Cloud k6 Run Inspector & 18-File Multi-CSV `.zip` Export
* **Full Grafana Cloud k6 Run View (`public/run-inspector.js`):**
  * **Header & Cloud Insights:** Star runs, add persistent notes/annotations, click **✨ Explain** for automated bottleneck diagnosis, or export Grafana Dashboard JSON.
  * **8 Sub-Tabs:**
    1. `THRESHOLDS` — Interactive table with inline expandable metric-vs-threshold time-series charts.
    2. `CHECKS` — Toggle between flat **List View** and hierarchical **Tree View** (`Scenario → Group → Check`).
    3. `HTTP & TURNS` — 10-column statistical table (`Count`, `Min`, `Avg`, `StdDev`, `P90`, `P95`, `P99`, `Max`) with 4 expandable chart modes + individual turn trace modal.
    4. `📦 EXPORTED k6 CSVs (18 FILES)` — In-browser file explorer and table viewer for every CSV in the Grafana Cloud k6 export bundle.
    5. `ANALYSIS EXPLORER` — Multi-metric overlay chart.
    6. `2-EC2 INJECTOR PROFILE` — Per-injector request count, P95 latency, errors, and CPU/Memory telemetry.
    7. `SCRIPT` — Executed scenario configuration snapshot.
    8. `LOGS` — Filterable (`ALL`, `INFO`, `WARN / ERROR`) execution logs.
* **Superior 18-File Multi-CSV `.zip` Export (`server/k6-zip-exporter.mjs`):**
  * Matches the exact Grafana Cloud k6 export archive format:
    * `metrics.csv` (`"metric","type","origin"`)
    * `metric_http_req_duration.csv`, `metric_http_req_failed.csv`, `metric_checks.csv`
    * `metric_group_duration.csv`, `metric_iteration_duration.csv`, `metric_iterations.csv`
    * `metric_data_received.csv`, `metric_data_sent.csv`
    * `metric_load_generator_cpu_percent.csv`, `metric_load_generator_memory_used_percent.csv`, `metric_load_generator_file_handles.csv`
    * `metric_vus.csv`, `metric_vus_max.csv`, plus custom flow/AI trend CSVs (`metric_flow_*.csv`).

---

### UI Theme & Dynamic 2K Desktop Layout
* **Light & Dark Theme Toggle:** Defaults to a high-contrast **Enterprise Light Theme** (`data-theme="light"`) with a top-bar toggle button (`🌙 Dark Theme` / `☀️ Light Theme`) persisted in `localStorage`.
* **100% Full-Viewport 2K/Ultrawide Layout:** Fluid edge-to-edge layout (`width: 100%; max-width: 100%`) with responsive side-by-side split panels on wide monitors (`>= 1750px`).

---

## 2. Repository Structure

```text
aiperf-cloud/
├── package.json
├── start-demo.ps1                         # One-click PowerShell launcher (auto-detects Node.js)
├── start-demo.bat                         # Windows CMD launcher
├── README.md
├── server/
│   ├── index.mjs                          # Main Master Orchestrator & Web Portal Server (:4000)
│   ├── worker-agent.mjs                   # Distributed EC2 Load Injector Agent (:4101, :4102)
│   ├── k6-zip-exporter.mjs                # Pure-Node 18-CSV Grafana Cloud k6 .zip builder
│   └── seed-runs.mjs                      # Generates initial reference runs (AI + k6)
├── public/
│   ├── index.html                         # Full-viewport Light/Dark UI shell & CSS variables
│   ├── app.js                             # Launcher, Injector Checkboxes, Live SSE & Studio logic
│   └── run-inspector.js                   # Grafana Cloud k6 Run View, Separate Counters & CSV Explorer
└── demo-framework/                        # Self-contained Demo Workspace (replaceable with real office projects)
    ├── mock/
    │   └── mock-agent.mjs                 # Mock Target Server (:8089) for PerfPilot HTTP, SSE & OpenAI
    ├── config/
    │   ├── default.json
    │   ├── perfpilot.json
    │   ├── perfpilot-sse.json
    │   ├── gates.json
    │   └── gates.perfpilot.json
    ├── data/
    │   ├── golden.json
    │   ├── adversarial.json
    │   ├── perfpilot-quick.json
    │   └── vars/clients.csv
    ├── k6/
    │   ├── main.js
    │   └── flows/
    │       ├── ecommerce-userflows.js
    │       └── microservices-api-suite.js
    ├── projects/
    │   └── enterprise-omni-framework/     # Sample Multi-Population Full Framework Project
    │       ├── project.json
    │       ├── config/staging.json
    │       ├── data/ (users.csv, products.json, ai-prompts.json)
    │       ├── lib/auth-helper.js
    │       └── flows/ (login-session.js, catalog-search.js, checkout-payment.js, ai-assistant-rag.js)
    ├── tools/
    │   ├── aiperf.mjs                     # Node -> k6 -> Node CLI & Post-Processor
    │   ├── direct-k6-runner.mjs           # Direct .js Multi-Scenario parser & runner
    │   └── population-orchestrator.mjs    # Multi-Population project scanner & composite k6 builder
    └── results/                           # Output directory for all runs (rows.jsonl, summary.json, report.html)
```

---

## 3. Quick Start

### Start Locally on Windows (Zero External Dependencies)
Run directly using Node.js (`v18+` / `v22+`):

```powershell
# Option A: Direct Node command
& "C:\Users\nithi\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe" "C:\Users\nithi\.gemini\antigravity\scratch\aiperf-cloud\server\index.mjs"

# Option B: Via PowerShell launcher script
.\start-demo.ps1
```

Once started, open **`http://127.0.0.1:4000`** in your browser.
* Master Portal UI: `http://127.0.0.1:4000`
* Local Load Injector #1 (`EC2-Worker-01` — Web Portal Host): `http://127.0.0.1:4101`
* Secondary Load Injector #2 (`EC2-Worker-02`): `http://127.0.0.1:4102`
* Local Mock AI / HTTP Target Server: `http://127.0.0.1:8089`

---

## 4. Adapting This Portal to Your Real Office Projects (Next Phase)

When you attach your real office projects (e.g., `c:\env_qa\perftest-framework-active\ai-agent-perf-framework` or your real k6 user-flow repositories), here is how they plug into this portal and where we will customize the components:

1. **Pointing to Real Project Directories (`Tab 5: 2-EC2 Cluster & Office Setup` or `projects/`):**
   * Drop any multi-file k6 project into `demo-framework/projects/<your-project-name>/` **or** upload the folder directly via the **📁 Upload Project Folder** button in the Test Launcher **or** set the **Framework Workspace Root** path in Tab 5.
2. **Customizing Entrypoints & Dataset Bindings (`demo-framework/tools/population-orchestrator.mjs`):**
   * `discoverEntrypoints()` and `Project.json` map your real `.js` user-flow functions (`export function ...`), custom environment variables, auth headers, and `SharedArray` CSV/JSON datasets into the Population Builder UI.
3. **Customizing Real Project Metrics & Result Counters (`demo-framework/tools/aiperf.mjs` & `public/run-inspector.js`):**
   * **Custom k6 `Trend` / `Rate` / `Counter` / `Gauge` metrics** emitted by your real scripts will be mapped into:
     * The **Normal k6 Result Counters** (`s.k6_counters`) and **AI Agent Result Counters** (`s.overall`).
     * The **18-File CSV Exporter (`server/k6-zip-exporter.mjs`)** so every custom metric in your real project generates its own `metric_<custom_name>.csv` file inside the exported `.zip` bundle.
     * The **Thresholds (`config/gates*.json`)**, **Checks Tree View**, and **Analysis Explorer** time-series charts.
4. **Real Distributed k6 CLI Execution (`server/worker-agent.mjs`):**
   * On your office machines where the `k6` binary is installed, `worker-agent.mjs` spawns the real `k6 run --execution-segment <seg> --out json=raw-k6.json <script.js>` process while streaming live metrics back to the Master Web Portal.
