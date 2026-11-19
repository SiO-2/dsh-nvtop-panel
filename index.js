import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import Schema from '@deepseek-ai/schemastery';

const inject = ['connection', 'webServer'];

/** User-tunable settings; the recommended poll interval travels with every sample. */
const Config = Schema.object({
  intervalMs: Schema.number().step(1).min(500).max(60000).default(2000)
    .description('Recommended client poll interval in milliseconds (500-60000, default 2000)'),
  peers: Schema.array(Schema.object({
    host: Schema.string().required()
      .description('SSH host of the peer unit (another DGX Spark or GPU host)'),
    user: Schema.string()
      .description('SSH user (default: the user dsh runs as)'),
    port: Schema.number().default(22)
      .description('SSH port'),
    title: Schema.string()
      .description('Display name for this unit (default: host)'),
  })).default([])
    .description('Peer units sampled over SSH; requires key-based auth (BatchMode)'),
});

const QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'fan.speed',
  'power.draw',
  'power.limit',
  'uuid',
].join(',');

const APP_FIELDS = ['pid', 'gpu_uuid', 'used_memory', 'process_name'].join(',');

/** Milliseconds a successful or failed sample stays cached. */
const CACHE_MS = 1000;
/** nvidia-smi hard timeout per invocation. */
const SMI_TIMEOUT_MS = 5000;
/** SSH timeout per peer invocation (connect + command). */
const SSH_TIMEOUT_MS = 8000;

/** Marker names delimiting sections of the one-shot remote probe script. */
const REMOTE_SECTIONS = ['HOST', 'SMI', 'APPS', 'MEM'];

const REMOTE_PROBE = [
  "printf '__NVTP_HOST__\\n'; hostname 2>/dev/null || echo unknown",
  `printf '__NVTP_SMI__\\n'; nvidia-smi --query-gpu=${QUERY_FIELDS} --format=csv,noheader,nounits 2>/dev/null`,
  `printf '__NVTP_APPS__\\n'; nvidia-smi --query-compute-apps=${APP_FIELDS} --format=csv,noheader,nounits 2>/dev/null`,
  "printf '__NVTP_MEM__\\n'; grep -E 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null",
].join('; ');

let cached;
let cachedAt = 0;
let sampling;
let peerConfig = [];
/** Peer refresh cadence; tracks the configured client interval. */
let pollBudgetMs = 2000;

function run(command, args, timeout = SMI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Keep ssh's own diagnostics ("No route to host", "Permission denied")
          // instead of the raw "Command failed: ssh -o ..." command line.
          const detail = String(stderr ?? '').trim().split('\n').filter(Boolean).pop();
          error.message = detail !== undefined && detail !== ''
            ? detail.slice(0, 120)
            : String(error.message ?? error).slice(0, 120);
          reject(error);
        } else resolve(stdout);
      },
    );
  });
}

function runSmi(args) {
  return run('nvidia-smi', args);
}

/** One SSH command on a peer; key auth only (BatchMode never prompts). */
function sshRun(peer, script) {
  const destination = peer.user !== undefined && peer.user !== null && peer.user !== ''
    ? `${peer.user}@${peer.host}`
    : peer.host;
  return run('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(peer.port ?? 22),
    destination,
    script,
  ], SSH_TIMEOUT_MS);
}

function splitCsv(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/** Parse a numeric field, keeping null for "[Not Supported]" or empty values. */
function numeric(value) {
  if (value === undefined || value === '' || value.startsWith('[')) return null;
  const n = Number(value.replace(/[^\d.\-+]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `--query-gpu` CSV lines into raw GPU rows (no memory fallback yet).
 * @internal exported for tests.
 */
function parseGpuCsv(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const f = splitCsv(line);
      return {
        index: numeric(f[0]) ?? 0,
        name: f[1] ?? 'GPU',
        utilization: numeric(f[2]),
        memoryUsed: numeric(f[3]),
        memoryTotal: numeric(f[4]),
        temperature: numeric(f[5]),
        fan: numeric(f[6]),
        powerDraw: numeric(f[7]),
        powerLimit: numeric(f[8]),
        uuid: f[9] ?? '',
      };
    });
}

/**
 * Parse `--query-compute-apps` CSV lines: pid, gpu uuid, MiB, process name.
 * @internal exported for tests.
 */
function parseAppsCsv(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const f = splitCsv(line);
      return {
        pid: numeric(f[0]) ?? 0,
        uuid: f[1] ?? '',
        memoryUsed: numeric(f[2]),
        name: f[3] ?? '',
      };
    });
}

/**
 * Parse MemTotal / MemAvailable from /proc/meminfo text.
 * @internal exported for tests.
 */
function parseMeminfo(text) {
  const out = { totalKib: null, availKib: null };
  for (const line of String(text ?? '').split('\n')) {
    let match = line.match(/^MemTotal:\s+(\d+)\s+kB/);
    if (match !== null) out.totalKib = Number(match[1]);
    match = line.match(/^MemAvailable:\s+(\d+)\s+kB/);
    if (match !== null) out.availKib = Number(match[1]);
  }
  return out;
}

/** Parse `ps -o pid=,user=,%cpu=,rss=,args=` output into a pid → details map. */
function parsePs(text) {
  const details = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    details.set(Number(match[1]), {
      user: match[2],
      cpu: Number(match[3]),
      rssKib: Number(match[4]),
      command: match[5],
    });
  }
  return details;
}

/** One `ps` call for every listed PID, executed through `execList` (local or ssh). */
async function processDetails(execList, pids) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (unique.length === 0) return new Map();
  try {
    const text = await execList(unique.join(','));
    return parsePs(text);
  } catch {
    // A process may exit between nvidia-smi and ps; leave its details absent.
    return new Map();
  }
}

const PS_ARGS = ['-o', 'pid=,user=,%cpu=,rss=,args='];

/**
 * Fold raw samples into one unit: GPU rows with unified-memory fallback and the
 * nvtop-style process table.
 *
 * Unified memory (DGX Spark GB10): nvidia-smi reports memory.used/total as
 * [N/A] because the GPU shares the LPDDR5X pool with the CPU. Following the
 * sparkDash approach, `used` then comes from the compute-apps sum and `total`
 * from the OS-visible pool (MemTotal), with MemAvailable as the free figure.
 * @internal exported for tests.
 */
function assembleUnit({ title, remote, gpusRaw, apps, mem, psDetails }) {
  const poolTotalMib = mem.totalKib !== null ? mem.totalKib / 1024 : null;
  const poolAvailMib = mem.availKib !== null ? mem.availKib / 1024 : null;

  const appsByUuid = new Map();
  let appsSumAll = 0;
  for (const app of apps) {
    appsByUuid.set(app.uuid, (appsByUuid.get(app.uuid) ?? 0) + (app.memoryUsed ?? 0));
    appsSumAll += app.memoryUsed ?? 0;
  }

  const deviceOfUuid = new Map();

  const gpus = gpusRaw.map((gpu) => {
    const isSparkChip = /GB10|DGX\s*Spark/i.test(gpu.name ?? '');
    let memoryUsed = gpu.memoryUsed;
    let memoryTotal = gpu.memoryTotal;
    let unified = false;
    let memoryAvailable = null;

    // GB10: nvidia-smi memory figures are N/A (or a misleading partial number
    // on some driver builds) — the OS pool is the honest denominator.
    if (isSparkChip || memoryTotal === null || memoryUsed === null) {
      if (poolTotalMib !== null && (isSparkChip || memoryTotal === null)) {
        unified = true;
        memoryTotal = poolTotalMib;
        memoryAvailable = poolAvailMib;
      }
    }
    // GPU-allocated share of the pool: compute-apps sum (per device when the
    // uuid maps, whole-box sum on a single-GPU unit without uuid match).
    // Spark chips always prefer the sum: some driver builds report a
    // misleading partial number instead of [N/A].
    {
      const perDevice = gpu.uuid !== '' ? appsByUuid.get(gpu.uuid) : undefined;
      const appsForGpu = perDevice !== undefined
        ? perDevice
        : (gpusRaw.length === 1 ? appsSumAll : 0);
      if (memoryUsed === null || memoryUsed === 0
        || (isSparkChip && appsForGpu > 0 && appsForGpu !== memoryUsed)) {
        memoryUsed = appsForGpu;
      }
    }
    if (gpu.uuid !== '') deviceOfUuid.set(gpu.uuid, gpu.index);
    return {
      ...gpu,
      memoryUsed,
      memoryTotal,
      unified,
      memoryAvailable,
    };
  });

  // Re-map app→device with the final uuid table (single-GPU Spark with an
  // unmatched uuid still lands on device 0).
  const entries = apps.map((app) => ({
    pid: app.pid,
    uuid: app.uuid,
    device: deviceOfUuid.get(app.uuid)
      ?? (gpus.length === 1 ? gpus[0].index : null),
    memoryUsed: app.memoryUsed,
    name: app.name,
  }));

  const processes = entries.map((entry) => {
    const extra = psDetails.get(entry.pid);
    const device = gpus.find((gpu) => gpu.index === entry.device);
    return {
      pid: entry.pid,
      user: extra?.user ?? null,
      device: entry.device,
      // nvidia-smi lists compute contexts; nvtop labels them "C".
      type: 'C',
      gpuUtilization: device?.utilization ?? null,
      memoryUsed: entry.memoryUsed,
      cpuPercent: extra?.cpu ?? null,
      hostMemKib: extra?.rssKib ?? null,
      command: extra?.command ?? entry.name,
    };
  });

  return { title, remote, gpus, processes, hostMem: mem };
}

async function sampleLocal() {
  const [gpuText, appText, memText] = await Promise.all([
    runSmi(['--query-gpu', QUERY_FIELDS, '--format=csv,noheader,nounits']),
    runSmi(['--query-compute-apps', APP_FIELDS, '--format=csv,noheader,nounits'])
      .catch(() => ''),
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
  ]);
  const apps = parseAppsCsv(appText);
  const psDetails = await processDetails(
    (list) => run('ps', [...PS_ARGS, '-p', list]),
    apps.map((app) => app.pid),
  );
  return assembleUnit({
    title: hostname(),
    remote: false,
    gpusRaw: parseGpuCsv(gpuText),
    apps,
    mem: parseMeminfo(memText),
    psDetails,
  });
}

/** Split the one-shot remote probe output into its marked sections. */
function splitRemoteSections(text) {
  const sections = {};
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^__NVTP_([A-Z]+)__$/);
    if (match !== null && REMOTE_SECTIONS.includes(match[1])) {
      current = match[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current !== null) sections[current].push(line);
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].join('\n');
  return sections;
}

/** Probe one peer over SSH; throws on failure (never returns an error unit). */
async function probePeer(peer) {
  const probe = await sshRun(peer, REMOTE_PROBE);
  const sections = splitRemoteSections(probe);
  if (sections.smi === undefined) throw new Error('probe returned no markers');
  const apps = parseAppsCsv(sections.apps ?? '');
  const psDetails = await processDetails(
    (list) => sshRun(peer, `ps ${PS_ARGS[0]} ${PS_ARGS[1]} -p ${list}`),
    apps.map((app) => app.pid),
  );
  const unit = assembleUnit({
    title: peer.title ?? ((sections.host ?? '').trim() || peer.host),
    remote: true,
    gpusRaw: parseGpuCsv(sections.smi ?? ''),
    apps,
    mem: parseMeminfo(sections.mem ?? ''),
    psDetails,
  });
  const complete = { id: peer.host, configuredTitle: peer.title ?? peer.host, ...unit };
  if (complete.gpus.length === 0) {
    complete.note = `no NVIDIA GPU detected on ${peer.host}`;
  }
  return complete;
}

/**
 * Peer units never block the API response: each peer refreshes in the
 * background on its own schedule, and every request reads the latest snapshot.
 * A failed peer retries at most once per PEER_RETRY_MS.
 */
const peerState = new Map();
const peerRefreshing = new Set();
const PEER_RETRY_MS = 10000;

function refreshPeer(peer) {
  const now = Date.now();
  const state = peerState.get(peer.host);
  if (state !== undefined && now < state.nextAt) return;
  if (peerRefreshing.has(peer.host)) return;
  peerRefreshing.add(peer.host);
  probePeer(peer)
    .then((unit) => {
      peerState.set(peer.host, { unit, error: null, at: Date.now(), nextAt: Date.now() + pollBudgetMs });
    })
    .catch((error) => {
      peerState.set(peer.host, {
        unit: null,
        error: `SSH ${peer.host}: ${error?.message ?? String(error)}`,
        at: Date.now(),
        nextAt: Date.now() + PEER_RETRY_MS,
      });
    })
    .finally(() => peerRefreshing.delete(peer.host));
}

/** Latest view of one peer: last-good data, the last error, or a connecting note. */
function peerSnapshot(peer) {
  refreshPeer(peer);
  const state = peerState.get(peer.host);
  const fallbackTitle = peer.title ?? peer.host;
  if (state === undefined) {
    return { id: peer.host, title: fallbackTitle, remote: true, error: `SSH ${peer.host}: connecting…` };
  }
  if (state.error !== null) {
    return { id: peer.host, title: fallbackTitle, remote: true, error: state.error };
  }
  return state.unit;
}

async function sample() {
  const local = await sampleLocal();
  const units = [{ id: 'local', ...local }, ...peerConfig.map((peer) => peerSnapshot(peer))];
  return {
    ok: true,
    sampledAt: Date.now(),
    units,
    // Backwards-compatible top-level view of the local unit.
    gpus: local.gpus,
    processes: local.processes,
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function fetchStats() {
  const now = Date.now();
  if (cached !== undefined && now - cachedAt < CACHE_MS) return cached;
  if (sampling !== undefined) return sampling;
  sampling = (async () => {
    try {
      cached = await sample();
      cachedAt = Date.now();
      return cached;
    } catch (error) {
      const body = {
        ok: false,
        sampledAt: now,
        message: error?.code === 'ENOENT'
          ? 'nvidia-smi not found on the host'
          : String(error?.message ?? error),
      };
      return new Response(JSON.stringify(body), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } finally {
      sampling = undefined;
    }
  })();
  return sampling;
}

/**
 * Host half: expose one owner-authenticated GET route on the shared /api
 * channel that returns a live nvidia-smi sample as JSON.
 */
function apply(ctx, config) {
  const intervalMs = config?.intervalMs ?? 2000;
  peerConfig = Array.isArray(config?.peers) ? config.peers : [];
  pollBudgetMs = Math.max(1000, intervalMs);
  // Drop cached state for peers that are no longer configured.
  const configuredHosts = new Set(peerConfig.map((peer) => peer.host));
  for (const host of peerState.keys()) {
    if (!configuredHosts.has(host)) peerState.delete(host);
  }
  const dispose = ctx.connection.registerFetchRoute(ctx, {
    path: '/api/nvtop',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const result = await fetchStats();
        if (result instanceof Response) return result;
        return jsonResponse({ ...result, intervalMs });
      } catch (error) {
        console.error('[dsh-nvtop] stats route failed:', error);
        return new Response(JSON.stringify({ ok: false, message: String(error?.message ?? error) }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    },
  });
  ctx.effect(() => dispose, 'dsh-nvtop: /api/nvtop stats route');
}

export {
  Config,
  apply,
  inject,
  // @internal test hooks
  parseGpuCsv,
  parseAppsCsv,
  parseMeminfo,
  assembleUnit,
  splitRemoteSections,
};
