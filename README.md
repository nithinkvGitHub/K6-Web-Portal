# AIPerf Cloud Orchestrator

**AIPerf Cloud Orchestrator** is a self-contained, zero-dependency distributed performance engineering and AI evaluation portal built on **Node.js + k6**. It supports distributed load injection across **1 to N Load Injectors**, real-time Server-Sent Events (SSE) telemetry, separated **Normal k6 (`http_reqs`, checks, RPS, payload bytes)** and **AI Agent (`TTFT`, tokens, stage breakdown, lexical correctness, groundedness, QDUL)** counter profiles, and local Grafana Cloud k6-style interactive analytics and exports.

---

## Key Capabilities

### 1. Three Execution Modes & Native `k6` CLI Auto-Detection
- **Multi-Population Project Mode (NeoLoad / Enterprise k6 Style):** Upload or select a multi-file framework project (`flows/`, `data/`, `config/`, `lib/`, `project.json`), configure multiple user populations with independent VUs, durations, and dataset bindings, and distribute execution across selected load injectors.
- **Direct Single `.js` (`k6 run`) Mode:** Select or upload any standard k6 script (`export const options = { scenarios, thresholds }`), auto-discover custom `Trend` / `Rate` / `Counter` / `Gauge` metrics, and run across selected injectors.
- **AI Pipeline (`aiperf.mjs`) Mode:** Full 3-stage pipeline:
  1. **Stage 1 (`doctor.mjs`):** Preflight verification of target endpoint, streaming headers (`text/event-stream`), and deterministic JSON schema.
  2. **Stage 2 (Distributed Load Generation):** Executes segmented load (`--execution-segment`) across selected injectors.
  3. **Stage 3 (Post-Processing & Gates):** Evaluates lexical correctness, groundedness, Quality Degradation Under Load (QDUL), script `options.thresholds` + `gates.json`, and generates `summary.json`, `results.csv`, and self-contained `report.html`.
- **Execution Engine Auto-Detection:**
  - When the **`k6` binary** is installed on an injector host (`k6 version`), worker agents automatically spawn real `k6 run --execution-segment <slice> --out json=...` processes and tail live point telemetry.
  - When `k6` is not installed, workers execute the **Measured Node HTTP/SSE Engine**, recording real socket timings, real streaming first-chunk `ttft_ms`, real UTF-8 request/response byte counts (`req_bytes`, `res_bytes`), and real OS resource utilization.

### 2. Dynamic $N$-Injector Load Distribution & Cluster Registration
- **Default Local Injector Selection:** By default, only the local injector hosting the web portal (`EC2-Worker-01`) is checked.
- **Scale from 1 to $N$ Injectors:** Check any combination of online injectors in the Launcher or register additional remote worker nodes at runtime (`POST /api/cluster/register` or via the **Load Injectors & Offline Setup** tab).
- **Automatic k6 Segment Slicing:** `computeSegmentSlices(N)` partitions `--execution-segment` across any number of selected injectors (e.g., `0:1` for 1 injector, `0:0.5` / `0.5:1` for 2 injectors, `0:0.3333` / `0.3333:0.6666` / `0.6666:1` for 3 injectors, or custom population weights).
- **True Abort (`Stop`):** The **Stop** button is enabled only while a run is active, sends `SIGTERM` / `AbortController.abort()` only to the participating injectors for that run, skips post-processing into a false pass state, and records `ABORTED` status.

### 3. Real Telemetry & Unified Statistical Engine (`n - 1` Sample Stdev)
- **Zero Fabricated Metrics:** All metrics are computed from measured rows in `rows.jsonl`:
  - **OS Telemetry:** Real CPU utilization delta (`os.cpus()`), memory utilization (`os.totalmem()` / `os.freemem()`), and active file handles (`process._getActiveHandles()`).
  - **Network Payload Telemetry:** Real `req_bytes` and `res_bytes` per request (`data_sent` and `data_received`).
  - **Streaming TTFT:** Real time to first streamed chunk (`ttft_ms`) for SSE/streaming responses; displays `n/a` for non-streaming HTTP requests.
  - **Unified Statistics (`server/stats-engine.mjs`):** Consistent percentile calculation (`P50`, `P90`, `P95`, `P99`) and sample standard deviation ($s = \sqrt{\frac{1}{n-1}\sum (x_i - \bar{x})^2}$) across the post-processor, UI inspector, and CSV/ZIP exporter.
  - **Full-Duration Time Bucketing:** Charts plot aggregated time buckets (`summary.time_series`) across the entire test duration without truncating at 60 rows.

### 4. Comprehensive Exports & CI/CD Integration
- **Dynamic Multi-CSV `.zip` Export (`/api/runs/:runId/export-k6-zip`):** Dynamically generates per-metric 12-second bucketed CSVs (`http_reqs.csv`, `http_req_duration.csv`, `checks.csv`, discovered custom metrics, AI metrics when present, `metadata.json`, and `summary_stats.csv`) with per-injector load zones.
- **Prometheus Exposition Format (`/api/runs/:runId/export-prometheus`):** Exports run metrics as `.prom` gauges and counters.
- **InfluxDB Line Protocol (`/api/runs/:runId/export-influx`):** Exports per-request time-series points in `.lp` format.
- **JUnit XML (`/api/runs/:runId/junit.xml`):** Exports threshold and release gate results as standard `<testsuite>` XML for GitHub Actions, GitLab CI, Jenkins, or Azure DevOps.

---

## Project Architecture

```text
aiperf-cloud/
├── start-demo.ps1                         # Windows PowerShell launcher (auto-detects node on PATH)
├── server/
│   ├── index.mjs                          # Master Orchestrator API, SSE stream, cluster registry (Port 4000)
│   ├── worker-agent.mjs                   # Load Injector Worker Agent (Ports 4101, 4102, ... or remote hosts)
│   ├── mock-agent.mjs                     # Local Target AI Agent & E-Commerce HTTP/SSE simulator (Port 4200)
│   ├── stats-engine.mjs                   # Unified percentiles, sample stdev (n-1), segment slicer, OS sampler
│   ├── k6-cli-bridge.mjs                  # Native k6 CLI runner + Prometheus, InfluxDB & JUnit XML exporters
│   ├── k6-zip-exporter.mjs                # Dynamic Grafana Cloud k6-compatible Multi-CSV ZIP builder
│   └── seed-runs.mjs                      # Initial baseline & candidate runs for immediate exploration
├── public/
│   ├── index.html                         # Responsive Light/Dark full-viewport Web Portal
│   ├── styles.css                         # Dynamic fluid grid & Light/Dark theme variables
│   ├── app.js                             # Live War Room, N-Injector selector, Multi-Population builder
│   └── run-inspector.js                   # 6-tab Cloud Report View (Thresholds, Checks, HTTP, Explorer, Flamegraph, Logs)
├── demo-framework/
│   ├── tools/
│   │   ├── aiperf.mjs                     # CLI & Stage 3 Post-Processor, Threshold/Gate evaluator, Run comparator
│   │   ├── doctor.mjs                     # Stage 1 Target preflight validator
│   │   ├── direct-k6-runner.mjs           # Single .js k6 script inspector & execution engine
│   │   └── population-orchestrator.mjs    # Multi-file project scanner, upload validator & population runner
│   ├── projects/
│   │   └── omni-commerce-ai/              # Sample multi-population project (flows/, data/, config/, lib/)
│   ├── k6/                                # Standalone k6 scripts (agent-Turns.js, ecommerce-user-flows.js)
│   ├── config/                            # Workload profiles & gates.json
│   └── results/                           # Run artifacts (rows.jsonl, summary.json, report.html, console.log)
└── tests/
    └── verify-all.mjs                     # Automated verification test suite
```

---

## Quick Start

### 1. Start the Portal
Using PowerShell on Windows:
```powershell
.\start-demo.ps1
```
Or directly with Node.js (v18+):
```bash
node server/index.mjs
```
Then open **http://localhost:4000** in your browser.

### 2. Environment Variables & Security Configuration
All configuration is optional and defaults to zero-config local execution:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | Master Orchestrator HTTP port |
| `BIND_HOST` | `127.0.0.1` | Bind address (`127.0.0.1` for local-only, `0.0.0.0` for LAN/EC2 access) |
| `AIPERF_TOKEN` | *(unset)* | Optional shared bearer/header token (`x-aiperf-token`) required on mutating API & worker calls |
| `WORKER1_URL` | `http://127.0.0.1:4101` | Primary injector URL |
| `WORKER2_URL` | `http://127.0.0.1:4102` | Secondary injector URL |
| `EXTRA_WORKERS` | *(unset)* | Comma-separated additional injectors (`id=http://host:port,id2=http://host2:port`) |
| `WEBHOOK_URL` | *(unset)* | Optional webhook URL notified via HTTP POST when a run finishes |

### 3. Run the Automated Verification Suite
```bash
node tests/verify-all.mjs
```

---

## Git Setup & Pushing Updates

To check repository status, commit changes, and push to your remote Git repository:

```bash
git status
git add .
git commit -m "Upgrade AIPerf Cloud Orchestrator with N-injector scaling, real telemetry, and unified exports"
git push origin main
```
