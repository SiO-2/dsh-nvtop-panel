# dsh-nvtop-panel

A [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) web plugin that
adds an **nvtop-style GPU dashboard** to the Web UI: one sidebar icon, one full-width
panel, live data from `nvidia-smi`.

Built for multi-GPU, multi-user servers: per-GPU metric cards plus a full
nvtop-like process table, so you can see *who* is using *which* GPU.

```
GPU monitor                          2 GPUs

┌ GPU 0 · NVIDIA RTX 4090 ────────┐  ┌ GPU 1 · … ┐
│ Utilization  ▓▓▓░░░░░░   12 %   │  │           │
│ Memory       ▓▓▓▓▓░░░░  9/23GiB │  │           │
│ Power        ▓▓░░░░░░   75/450W │  └───────────┘
│ Temp 42°C · Fan 35% · Power 75W │
└─────────────────────────────────┘

Processes
PID       USER   DEV TYPE  GPU  GPU MEM    CPU  HOST MEM  Command
10124    alice       0    C  62%   9.4 GiB   3.1%  1.8 GiB  llama-server
10192      bob        1    C  47%   8.9 GiB   2.4%  1.6 GiB  python train.py
10230    alice       2    C  89%  87.2 GiB  18.3%  2.6 GiB  vllm serve …
```

## Features

- **Per-GPU cards**: utilization, memory used/total, power draw vs limit (metered bars,
  amber ≥ 70 %, red ≥ 90 %), temperature, fan speed when the GPU reports it.
- **nvtop-style process table**: `PID · USER · DEV · TYPE · GPU · GPU MEM · CPU ·
  HOST MEM · Command`. GPU memory comes from `nvidia-smi --query-compute-apps`; user,
  CPU %, host RSS, and full command line come from one batched `ps` call; each process
  is mapped to its device via GPU UUID.
  - `TYPE` is `C` (compute) — the CSV interface only lists compute contexts.
  - `GPU` is the process's device utilization; per-process SM utilization is a
    driver-level statistic that `nvidia-smi`'s query interface does not expose.
- **Auto-refresh**, interval configurable per profile (default 2 s), server samples
  cached 1 s so overlapping polls share one `nvidia-smi` run.
- **Theme-native UI**: all styling uses DSH theme tokens (`--dsw-alias-*`), light/dark
  aware, English locale.
- **Owner-authenticated data route**: served on the shared `/api` channel
  (`GET /api/nvtop`), so it carries the same cookie trust as the rest of the DSH web
  API; unauthenticated requests get 401.

## Requirements

- DSH web profile (`dsh web`) with the standard `dsh-base` + `dsh-web-app` bundles.
- NVIDIA driver with `nvidia-smi` on the host PATH. (AMD/Intel GPUs are not supported;
  for AMD see community rocm-smi plugins.)

## Install

From npm:

```sh
dsh plugin --profile web add dsh-nvtop-panel
```

Then restart `dsh web` (or rely on live patch reload) and refresh the browser. A GPU
icon appears in the left sidebar panel list.

From a git checkout:

```sh
git clone <this repo> && cd dsh-nvtop-panel
dsh plugin --profile web add "$PWD"
```

## Configuration

Tunable in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-nvtop-panel
  config:
    intervalMs: 2000   # client poll interval, 500–60000 ms
```

Editing the interval restarts the plugin and the panel picks up the new value on the
next poll.

## Verify

```sh
dsh --profile web --dump-config | grep dsh-nvtop-panel
curl -s -b <browser-cookie-jar> http://127.0.0.1:3080/api/nvtop | head
# {"ok":true,"sampledAt":...,"gpus":[...],"processes":[...],"intervalMs":2000}
```

## Architecture

One dual-face package:

- `index.js` (host) — registers the owner-authenticated `/api/nvtop` fetch route on the
  shared Connection channel, samples `nvidia-smi` (1 s cache, in-flight dedup), merges
  `ps` details, and returns JSON.
- `client.js` (browser) — registers the `main` panel and the `sidebar.panellist` icon
  via Cordis slots, polls the route, and renders with React from the page module table.
  No build tooling; plain JS.

## License

MIT
