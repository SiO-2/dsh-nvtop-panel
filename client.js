window.__ModuleLoader__.load({
  id: 'dsh-nvtop-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'nvtop.panel';
    const PANEL_ID = 'nvtop';
    const POLL_MS = 2000;

    const dict = {
      en: {
        panel: 'GPU monitor',
        gpus: '{n} GPU',
        gpusOther: '{n} GPUs',
        utilization: 'Utilization',
        memory: 'Memory',
        temperature: 'Temp',
        fan: 'Fan',
        power: 'Power',
        processes: 'Processes',
        noProcesses: 'No GPU processes',
        unavailable: 'GPU stats unavailable',
        stale: 'Waiting for data…',
        pid: 'PID',
        user: 'USER',
        dev: 'DEV',
        type: 'TYPE',
        gpu: 'GPU',
        gpuMem: 'GPU MEM',
        cpu: 'CPU',
        hostMem: 'HOST MEM',
        command: 'Command',
      },
    };

    function fmtInt(value) {
      return value === null || value === undefined ? '—' : `${Math.round(value)}`;
    }

    function fmtMemory(mib) {
      if (mib === null || mib === undefined) return '—';
      if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
      return `${Math.round(mib)} MiB`;
    }

    function fmtHostMemory(kib) {
      if (kib === null || kib === undefined) return '—';
      if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GiB`;
      if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MiB`;
      return `${Math.round(kib)} KiB`;
    }

    function fmtPower(watt) {
      return watt === null || watt === undefined ? '—' : `${watt.toFixed ? watt.toFixed(1) : watt} W`;
    }

    function fmtPercent(value) {
      return value === null || value === undefined ? '—' : `${Math.round(value)}%`;
    }

    function levelClass(ratio) {
      if (ratio === null || ratio === undefined) return 'nvtp-empty';
      if (ratio >= 0.9) return 'nvtp-hot';
      if (ratio >= 0.7) return 'nvtp-warm';
      return 'nvtp-ok';
    }

    function Bar(props) {
      const ratio = props.ratio;
      const pct = ratio === null || ratio === undefined ? 0 : Math.max(0, Math.min(100, ratio * 100));
      return h('div', { className: 'nvtp-bar ' + levelClass(ratio) },
        h('div', { className: 'nvtp-bar-fill', style: { width: pct + '%' } }));
    }

    function Stat(props) {
      return h('div', { className: 'nvtp-stat' },
        h('div', { className: 'nvtp-stat-label' }, props.label),
        h('div', { className: 'nvtp-stat-value' }, props.value));
    }

    function GpuCard(props) {
      const { gpu, t } = props;
      const memRatio = gpu.memoryUsed !== null && gpu.memoryTotal
        ? gpu.memoryUsed / gpu.memoryTotal : null;
      const powerRatio = gpu.powerDraw !== null && gpu.powerLimit
        ? gpu.powerDraw / gpu.powerLimit : null;
      return h('section', { className: 'nvtp-card' },
        h('header', { className: 'nvtp-card-head' },
          h('span', { className: 'nvtp-card-name' }, gpu.name),
          h('span', { className: 'nvtp-card-index' }, `GPU ${gpu.index}`)),
        h('div', { className: 'nvtp-rows' },
          h('div', { className: 'nvtp-row' },
            h('span', { className: 'nvtp-row-label' }, t('utilization')),
            h(Bar, { ratio: gpu.utilization === null ? null : gpu.utilization / 100 }),
            h('span', { className: 'nvtp-row-value' }, fmtPercent(gpu.utilization))),
          h('div', { className: 'nvtp-row' },
            h('span', { className: 'nvtp-row-label' }, t('memory')),
            h(Bar, { ratio: memRatio }),
            h('span', { className: 'nvtp-row-value' },
              `${fmtMemory(gpu.memoryUsed)} / ${fmtMemory(gpu.memoryTotal)}`)),
          h('div', { className: 'nvtp-row' },
            h('span', { className: 'nvtp-row-label' }, t('power')),
            h(Bar, { ratio: powerRatio }),
            h('span', { className: 'nvtp-row-value' },
              powerRatio === null ? fmtPower(gpu.powerDraw) : fmtPower(gpu.powerLimit)))),
        h('div', { className: 'nvtp-stats' },
          h(Stat, { label: t('temperature'), value: gpu.temperature === null ? '—' : `${Math.round(gpu.temperature)}°C` }),
          h(Stat, { label: t('fan'), value: gpu.fan === null ? '—' : `${Math.round(gpu.fan)}%` }),
          h(Stat, { label: t('power'), value: fmtPower(gpu.powerDraw) })));
    }

    function ProcessTable(props) {
      const { processes, t } = props;
      if (processes.length === 0) {
        return h('div', { className: 'nvtp-empty-note' }, t('noProcesses'));
      }
      return h('table', { className: 'nvtp-table nvtp-procs-table' },
        h('thead', null,
          h('tr', null,
            h('th', { className: 'nvtp-num' }, t('pid')),
            h('th', null, t('user')),
            h('th', { className: 'nvtp-num' }, t('dev')),
            h('th', null, t('type')),
            h('th', { className: 'nvtp-num' }, t('gpu')),
            h('th', { className: 'nvtp-num' }, t('gpuMem')),
            h('th', { className: 'nvtp-num' }, t('cpu')),
            h('th', { className: 'nvtp-num' }, t('hostMem')),
            h('th', { className: 'nvtp-cmd' }, t('command')))),
        h('tbody', null,
          processes.map((p) => h('tr', { key: p.pid + ':' + (p.device ?? '') + ':' + p.command.slice(0, 24) },
            h('td', { className: 'nvtp-num' }, fmtInt(p.pid)),
            h('td', { className: 'nvtp-user' }, p.user ?? '—'),
            h('td', { className: 'nvtp-num' }, p.device === null || p.device === undefined ? '—' : String(p.device)),
            h('td', { className: 'nvtp-type' }, p.type ?? '—'),
            h('td', { className: 'nvtp-num' }, fmtPercent(p.gpuUtilization)),
            h('td', { className: 'nvtp-num' }, fmtMemory(p.memoryUsed)),
            h('td', { className: 'nvtp-num' }, p.cpuPercent === null || p.cpuPercent === undefined ? '—' : `${p.cpuPercent.toFixed(1)}%`),
            h('td', { className: 'nvtp-num' }, fmtHostMemory(p.hostMemKib)),
            h('td', { className: 'nvtp-cmd nvtp-name' }, p.command)))));
    }

    const CSS = `
.nvtp-page{box-sizing:border-box;height:100%;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.nvtp-title{margin:0;font-size:18px;font-weight:600}
.nvtp-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.nvtp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.nvtp-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.nvtp-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.nvtp-card-name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nvtp-card-index{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none}
.nvtp-rows{display:flex;flex-direction:column;gap:8px}
.nvtp-row{display:grid;grid-template-columns:64px 1fr 130px;gap:10px;align-items:center;font-size:12px}
.nvtp-row-label{color:var(--dsw-alias-label-secondary)}
.nvtp-row-value{text-align:right;font-variant-numeric:tabular-nums}
.nvtp-bar{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.nvtp-bar-fill{height:100%;border-radius:4px;background:var(--dsw-alias-brand-primary);transition:width .4s ease}
.nvtp-ok .nvtp-bar-fill{background:var(--dsw-alias-brand-primary)}
.nvtp-warm .nvtp-bar-fill{background:var(--dsw-alias-state-warn-primary)}
.nvtp-hot .nvtp-bar-fill{background:var(--dsw-alias-state-error-primary)}
.nvtp-empty .nvtp-bar-fill{background:var(--dsw-alias-state-idle-primary)}
.nvtp-stats{display:flex;gap:18px;flex-wrap:wrap}
.nvtp-stat-label{color:var(--dsw-alias-label-secondary);font-size:11px}
.nvtp-stat-value{font-size:14px;font-variant-numeric:tabular-nums}
.nvtp-procs{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.nvtp-procs h2{margin:0 0 10px;font-size:14px;font-weight:600}
.nvtp-table{width:100%;border-collapse:collapse;font-size:13px}
.nvtp-table th{color:var(--dsw-alias-label-secondary);font-weight:500;text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;white-space:nowrap}
.nvtp-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.nvtp-num{text-align:right;font-variant-numeric:tabular-nums}
.nvtp-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.nvtp-procs-table .nvtp-cmd{max-width:420px;overflow:hidden;text-overflow:ellipsis}
.nvtp-empty-note{color:var(--dsw-alias-label-secondary);font-size:13px}
.nvtp-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:14px 16px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.nvtp-error-label{color:var(--dsw-alias-state-error-primary);font-weight:600;margin-bottom:6px}
`;

    function pluralize(template, other, count) {
      return (count === 1 ? template : other).replace('{n}', String(count));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dict), 'dsh-nvtop: dictionaries');
        const t = ctx.locale.bind(NS);
        const translate = (key) => t(key);

        function Panel() {
          const [data, setData] = useState(null);
          const [error, setError] = useState(null);
          const alive = useRef(true);

          useEffect(() => {
            alive.current = true;
            let timer = 0;
            let intervalMs = POLL_MS;
            const tick = async () => {
              try {
                const response = await fetch('/api/nvtop', { credentials: 'same-origin' });
                const body = await response.json();
                if (!alive.current) return;
                if (!response.ok || body.ok === false) {
                  setError(body?.message || `HTTP ${response.status}`);
                  setData(null);
                } else {
                  setError(null);
                  setData(body);
                  if (Number.isFinite(body?.intervalMs)) {
                    intervalMs = Math.max(250, Math.min(60000, body.intervalMs));
                  }
                }
              } catch (e) {
                if (alive.current) setError(String(e?.message ?? e));
              } finally {
                if (alive.current) timer = window.setTimeout(tick, intervalMs);
              }
            };
            tick();
            return () => {
              alive.current = false;
              window.clearTimeout(timer);
            };
          }, []);

          const gpus = data?.gpus ?? [];
          return h('div', { className: 'nvtp-page' },
            h('style', null, CSS),
            h('h1', { className: 'nvtp-title' }, translate('panel')),
            h('div', { className: 'nvtp-sub' },
              data === null && error === null ? translate('stale')
                : gpus.length > 0
                  ? pluralize(translate('gpus'), translate('gpusOther'), gpus.length)
                  : ''),
            error !== null
              ? h('div', { className: 'nvtp-error' },
                  h('div', { className: 'nvtp-error-label' }, translate('unavailable')),
                  h('div', null, error))
              : null,
            gpus.length > 0
              ? h('div', { className: 'nvtp-grid' },
                  gpus.map((gpu) => h(GpuCard, { key: gpu.index, gpu, t: translate })))
              : null,
            data !== null && error === null
              ? h('section', { className: 'nvtp-procs' },
                  h('h2', null, translate('processes')),
                  h(ProcessTable, { processes: data.processes ?? [], t: translate }))
              : null);
        }

        function PanelIcon() {
          return h('svg', {
            viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': true,
            style: { display: 'block' },
          },
          h('rect', { x: 2.5, y: 5.5, width: 19, height: 12, rx: 2,
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M6 21v-3M12 21v-3M18 21v-3M6 5V3M12 5V3M18 5V3',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
          h('rect', { x: 5.5, y: 8.5, width: 5, height: 3.2, rx: 0.8,
            fill: 'currentColor', opacity: 0.9 }),
          h('rect', { x: 5.5, y: 13, width: 8, height: 3.2, rx: 0.8,
            fill: 'currentColor', opacity: 0.55 }),
          h('rect', { x: 13, y: 8.5, width: 5.5, height: 3.2, rx: 0.8,
            fill: 'currentColor', opacity: 0.3 }));
        }

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, Panel)), 'dsh-nvtop: main panel');
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS,
          label: () => translate('panel'),
        }, PanelIcon)), 'dsh-nvtop: sidebar icon');
      },
    };
  },
});
