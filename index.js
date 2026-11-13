import { execFile } from 'node:child_process';
import Schema from '@deepseek-ai/schemastery';

const inject = ['connection', 'webServer'];

/** User-tunable settings; the recommended poll interval travels with every sample. */
const Config = Schema.object({
  intervalMs: Schema.number().step(1).min(500).max(60000).default(2000)
    .description('Recommended client poll interval in milliseconds (500-60000, default 2000)'),
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

let cached;
let cachedAt = 0;
let sampling;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: SMI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function runSmi(args) {
  return run('nvidia-smi', args);
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

/** One `ps` call for every listed PID: user, cpu %, rss, full command line. */
async function processDetails(pids) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const details = new Map();
  if (unique.length === 0) return details;
  try {
    const text = await run('ps', [
      '-o', 'pid=,user=,%cpu=,rss=,args=',
      '-p', unique.join(','),
    ]);
    for (const line of text.split('\n')) {
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
  } catch {
    // A process may exit between nvidia-smi and ps; leave its details absent.
  }
  return details;
}

async function sample() {
  const [gpuText, appText] = await Promise.all([
    runSmi(['--query-gpu', QUERY_FIELDS, '--format=csv,noheader,nounits']),
    runSmi(['--query-compute-apps', APP_FIELDS, '--format=csv,noheader,nounits'])
      .catch(() => ''),
  ]);

  const gpus = gpuText
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

  const deviceOfUuid = new Map(gpus.map((gpu) => [gpu.uuid, gpu.index]));

  const entries = appText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const f = splitCsv(line);
      return {
        pid: numeric(f[0]) ?? 0,
        device: deviceOfUuid.get(f[1]) ?? null,
        memoryUsed: numeric(f[2]),
        name: f[3] ?? '',
      };
    });

  const details = await processDetails(entries.map((entry) => entry.pid));

  const processes = entries.map((entry) => {
    const extra = details.get(entry.pid);
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

  return { ok: true, sampledAt: Date.now(), gpus, processes };
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

export { Config, apply, inject };
